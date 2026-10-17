import unittest
from tempfile import TemporaryDirectory

from app.schemas import ResidentCreate
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
            self.assertTrue(store.revoke_resident(created.id))
            self.assertFalse(store.revoke_resident(created.id))


if __name__ == "__main__":
    unittest.main()
