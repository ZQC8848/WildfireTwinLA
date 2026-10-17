import unittest
from datetime import UTC, datetime
from tempfile import TemporaryDirectory

from app.alerts import evaluate_alert
from app.schemas import (
    ArrivalRisk,
    Hotspot,
    OfficialOrderCreate,
    ResidentCreate,
    WindPoint,
    WindSnapshot,
)
from app.store import Store


class StoreTests(unittest.TestCase):
    def test_resident_opt_in_is_masked_and_can_be_revoked(self) -> None:
        with TemporaryDirectory() as directory:
            store = Store(f"{directory}/test.db")
            store.initialize()
            created = store.create_resident(
                ResidentCreate(
                    name="Test Resident",
                    phone_e164="+12135550123",
                    address="100 Test Avenue",
                    community_id="altadena",
                    consent=True,
                )
            )

            self.assertEqual(created.phone_masked, "***0123")
            self.assertFalse(store.revoke_resident(created.id, "wrong-token"))
            self.assertTrue(store.revoke_resident(created.id, created.revoke_token))
            self.assertFalse(store.revoke_resident(created.id, created.revoke_token))

    def test_hotspots_are_idempotent_and_wind_round_trips(self) -> None:
        with TemporaryDirectory() as directory:
            store = Store(f"{directory}/test.db")
            store.initialize()
            hotspot = Hotspot(
                id="hotspot-1",
                source="VIIRS",
                lat=34.2,
                lon=-118.1,
                acquired_at=datetime.now(UTC),
                confidence=0.9,
            )
            self.assertEqual(len(store.upsert_hotspots([hotspot])), 1)
            self.assertEqual(len(store.upsert_hotspots([hotspot])), 0)
            snapshot = WindSnapshot(
                observed_at=datetime.now(UTC),
                points=[
                    WindPoint(
                        lat=34.2,
                        lon=-118.1,
                        speed_ms=10,
                        direction_from_deg=45,
                        gust_ms=15,
                        relative_humidity=20,
                    )
                ],
            )
            store.save_wind(snapshot)
            self.assertEqual(store.latest_wind().points[0].speed_ms, 10)

    def test_alert_event_and_call_attempt_are_idempotent(self) -> None:
        with TemporaryDirectory() as directory:
            store = Store(f"{directory}/test.db")
            store.initialize()
            resident = store.create_resident(
                ResidentCreate(
                    name="Test Resident",
                    phone_e164="+12135550123",
                    address="100 Test Avenue",
                    community_id="altadena",
                    consent=True,
                )
            )
            risk = ArrivalRisk(
                community_id="altadena",
                incident_id="fire-1",
                probability_1h=0.1,
                probability_3h=0.6,
                probability_6h=0.8,
                eta_min=120,
            )
            level, below_count = store.alert_state("fire-1", "altadena")
            decision = evaluate_alert(level, risk, below_count)
            event_id = store.save_alert(risk, decision)
            attempt = store.create_call_attempt(event_id, resident.id)
            self.assertIsNotNone(attempt)
            self.assertIsNone(store.create_call_attempt(event_id, resident.id))

    def test_official_orders_are_idempotent_and_queryable(self) -> None:
        with TemporaryDirectory() as directory:
            store = Store(f"{directory}/test.db")
            store.initialize()
            order = OfficialOrderCreate(
                id="la-order-1",
                community_id="altadena",
                level="order",
                headline="Evacuate now",
                source="LA County",
                issued_at=datetime.now(UTC),
            )
            _, changed = store.save_official_order(order)
            _, changed_again = store.save_official_order(order)
            self.assertTrue(changed)
            self.assertFalse(changed_again)
            self.assertEqual(store.active_official_orders("altadena")[0].level, "order")


if __name__ == "__main__":
    unittest.main()
