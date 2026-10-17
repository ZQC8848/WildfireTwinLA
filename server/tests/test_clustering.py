import unittest
from datetime import UTC, datetime, timedelta

from app.clustering import cluster_hotspots
from app.schemas import Hotspot


def hotspot(identifier: str, lat: float, lon: float, minutes: int = 0) -> Hotspot:
    return Hotspot(
        id=identifier,
        source="VIIRS",
        lat=lat,
        lon=lon,
        acquired_at=datetime(2026, 1, 1, tzinfo=UTC) + timedelta(minutes=minutes),
        frp=10,
        confidence=0.9,
    )


class ClusteringTests(unittest.TestCase):
    def test_nearby_points_form_one_cluster(self) -> None:
        clusters = cluster_hotspots([hotspot("a", 34.20, -118.10), hotspot("b", 34.202, -118.10)])
        self.assertEqual([[point.id for point in group] for group in clusters], [["a", "b"]])

    def test_distant_points_form_separate_clusters(self) -> None:
        clusters = cluster_hotspots([hotspot("a", 34.20, -118.10), hotspot("b", 34.22, -118.10)])
        self.assertEqual(len(clusters), 2)

    def test_old_point_does_not_join_new_cluster(self) -> None:
        clusters = cluster_hotspots(
            [hotspot("a", 34.20, -118.10), hotspot("b", 34.20, -118.10, minutes=361)]
        )
        self.assertEqual(len(clusters), 2)


if __name__ == "__main__":
    unittest.main()
