"""Reported Norte Fire damage area on buildings.json.

OCFA reported at least six homes damaged or destroyed along Avenida Calita, Via La Mirada and Via
De Agua in San Juan Capistrano. No per-address list is public, so every building within
`--distance` metres of those streets gets `reportedDamageArea: true`. This marks a street-level
area for comparison, not confirmed damage to each flagged building.

The street geometry used is saved next to the raw inputs for provenance.
"""

import argparse
import json
import math
from itertools import pairwise
from pathlib import Path

from .sources import fetch_overpass_raw

# Matched case-insensitively: OSM spells them "Via la Mirada" and "Via de Agua"
STREETS = ("Avenida Calita", "Via La Mirada", "Via De Agua")
SOURCE = "OCFA via Fox LA and LAist, 2026-10-17: homes damaged or destroyed on these streets"


def fetch_streets(bbox: tuple[float, float, float, float]) -> list[dict]:
    west, south, east, north = bbox
    names = "|".join(STREETS)
    query = (
        "[out:json][timeout:60];"
        f'way["highway"]["name"~"^({names})$",i]({south},{west},{north},{east});'
        "out geom;"
    )
    payload = fetch_overpass_raw(query)
    return [
        {"name": way["tags"]["name"], "coords": [(p["lon"], p["lat"]) for p in way["geometry"]]}
        for way in payload.get("elements", [])
        if way.get("geometry")
    ]


def _local_xy(lon: float, lat: float, lat0: float) -> tuple[float, float]:
    return (
        math.radians(lon) * 6_371_000 * math.cos(math.radians(lat0)),
        math.radians(lat) * 6_371_000,
    )


def _segment_distance(p, a, b) -> float:
    ax, ay = b[0] - a[0], b[1] - a[1]
    length2 = ax * ax + ay * ay
    t = (
        0.0
        if length2 == 0
        else max(0.0, min(1.0, ((p[0] - a[0]) * ax + (p[1] - a[1]) * ay) / length2))
    )
    return math.hypot(p[0] - a[0] - t * ax, p[1] - a[1] - t * ay)


def mark_buildings(buildings: list[dict], streets: list[dict], distance_m: float) -> int:
    """Set reportedDamageArea on buildings whose footprint centroid is near a street."""
    if not streets:
        return 0
    lat0 = streets[0]["coords"][0][1]
    lines = [[_local_xy(lon, lat, lat0) for lon, lat in s["coords"]] for s in streets]
    xs = [x for line in lines for x, _ in line]
    ys = [y for line in lines for _, y in line]
    box = (min(xs) - distance_m, min(ys) - distance_m, max(xs) + distance_m, max(ys) + distance_m)
    marked = 0
    for building in buildings:
        ring = building.get("polygonLonLat") or []
        if not ring:
            continue
        lon = sum(p[0] for p in ring) / len(ring)
        lat = sum(p[1] for p in ring) / len(ring)
        p = _local_xy(lon, lat, lat0)
        near = (
            box[0] <= p[0] <= box[2]
            and box[1] <= p[1] <= box[3]
            and any(
                _segment_distance(p, a, b) <= distance_m
                for line in lines
                for a, b in pairwise(line)
            )
        )
        if near:
            building["reportedDamageArea"] = True
            marked += 1
        else:
            building.pop("reportedDamageArea", None)
    return marked


def main() -> None:
    parser = argparse.ArgumentParser(description="Flag buildings in the reported damage area")
    parser.add_argument("--buildings", default="../web/public/data/buildings.json")
    parser.add_argument("--streets-out", default="../data/norte/reported-damage-streets.json")
    parser.add_argument(
        "--bbox",
        default="-117.714,33.427,-117.576,33.543",
        type=lambda value: tuple(map(float, value.split(","))),
    )
    parser.add_argument("--distance", type=float, default=60)
    args = parser.parse_args()
    streets = fetch_streets(args.bbox)
    Path(args.streets_out).write_text(
        json.dumps({"source": SOURCE, "streets": streets}, indent=1) + "\n"
    )
    path = Path(args.buildings)
    buildings = json.loads(path.read_text())
    marked = mark_buildings(buildings, streets, args.distance)
    path.write_text(json.dumps(buildings, separators=(",", ":")) + "\n")
    print(json.dumps({"streets": sorted({s["name"] for s in streets}), "marked": marked}))


if __name__ == "__main__":
    main()
