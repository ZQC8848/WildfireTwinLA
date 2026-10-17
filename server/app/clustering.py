from collections import deque
from datetime import timedelta
from math import asin, cos, radians, sin, sqrt

from .schemas import Hotspot

EARTH_RADIUS_M = 6_371_008.8


def distance_m(a: Hotspot, b: Hotspot) -> float:
    """Great-circle distance suitable for the small LA-area working set."""
    lat1, lat2 = radians(a.lat), radians(b.lat)
    dlat = lat2 - lat1
    dlon = radians(b.lon - a.lon)
    hav = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * asin(sqrt(hav))


def cluster_hotspots(
    hotspots: list[Hotspot],
    radius_m: float = 750,
    time_window: timedelta = timedelta(hours=6),
    min_samples: int = 1,
) -> list[list[Hotspot]]:
    """DBSCAN-style connected clusters with a spatial and temporal neighborhood."""
    if min_samples < 1:
        raise ValueError("min_samples must be at least 1")

    def neighbors(index: int) -> list[int]:
        origin = hotspots[index]
        return [
            other_index
            for other_index, other in enumerate(hotspots)
            if abs(other.acquired_at - origin.acquired_at) <= time_window
            and distance_m(origin, other) <= radius_m
        ]

    visited: set[int] = set()
    assigned: set[int] = set()
    clusters: list[list[Hotspot]] = []

    for index in range(len(hotspots)):
        if index in visited:
            continue
        visited.add(index)
        nearby = neighbors(index)
        if len(nearby) < min_samples:
            continue

        members: list[int] = []
        queue = deque(nearby)
        queued = set(nearby)
        while queue:
            candidate = queue.popleft()
            if candidate not in visited:
                visited.add(candidate)
                candidate_neighbors = neighbors(candidate)
                if len(candidate_neighbors) >= min_samples:
                    for neighbor in candidate_neighbors:
                        if neighbor not in queued:
                            queue.append(neighbor)
                            queued.add(neighbor)
            if candidate not in assigned:
                assigned.add(candidate)
                members.append(candidate)

        clusters.append([hotspots[member] for member in members])
    return clusters
