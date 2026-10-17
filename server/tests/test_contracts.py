from datetime import UTC, datetime

from app.contracts import hotspot_message, wind_message
from app.schemas import Hotspot, WindPoint, WindSnapshot


def test_hotspot_contract_matches_frozen_team_shape() -> None:
    hotspot = Hotspot(
        id="h1",
        source="VIIRS",
        lat=34.22,
        lon=-118.12,
        acquired_at=datetime(2026, 10, 16, tzinfo=UTC),
        frp=12,
        confidence=0.9,
    )
    item = hotspot_message([hotspot], (-118.2, 34.17, -118.06, 34.27), 512, 512)["items"][0]
    assert set(item) == {"id", "cell", "lon", "lat", "t", "frp", "conf", "source"}
    assert item["cell"] >= 0


def test_wind_contract_uses_5x5_tuples() -> None:
    point = WindPoint(
        lat=34.2,
        lon=-118.1,
        speed_ms=10,
        direction_from_deg=45,
        gust_ms=15,
        relative_humidity=20,
    )
    message = wind_message(
        WindSnapshot(observed_at=datetime(2026, 10, 16, tzinfo=UTC), points=[point] * 25)
    )
    assert len(message["grid5x5"]) == 25
    assert message["grid5x5"][0] == [10.0, 45.0]
