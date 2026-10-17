"""OpenStreetMap road network in grid coordinates (web/public/data/roads.json).

Display only: the frontend rasterizes it into a high-resolution texture draped on the terrain.
The simulation does not read it. Urban roads are already non-burnable through LANDFIRE NB1, and
wildland dirt roads are a few metres wide, far narrower than a 25 m cell.

Output:

    {"classes": ["motorway", "major", "minor", "street", "track"],
     "roads": [[classIndex, x0, y0, x1, y1, ...], ...]}

x and y are in grid-cell units measured from the north-west corner of the grid (x east, y south),
so cell (c, r) spans [c, c + 1) x [r, r + 1).
"""

import argparse
import json
from pathlib import Path

from rasterio.warp import transform

from .sources import fetch_overpass_raw

CLASSES = ("motorway", "major", "minor", "street", "track")
HIGHWAY_CLASS = {
    "motorway": 0,
    "motorway_link": 0,
    "trunk": 0,
    "trunk_link": 0,
    "primary": 1,
    "primary_link": 1,
    "secondary": 1,
    "secondary_link": 1,
    "tertiary": 2,
    "tertiary_link": 2,
    "residential": 3,
    "unclassified": 3,
    "living_street": 3,
    "track": 4,
}


def fetch_roads(bbox: tuple[float, float, float, float]) -> list[dict]:
    west, south, east, north = bbox
    kinds = "|".join(HIGHWAY_CLASS)
    query = (
        "[out:json][timeout:120];"
        f'way["highway"~"^({kinds})$"]({south},{west},{north},{east});'
        "out geom;"
    )
    payload = fetch_overpass_raw(query)
    return [
        {
            "class": HIGHWAY_CLASS[way["tags"]["highway"]],
            "coords": [(p["lon"], p["lat"]) for p in way["geometry"]],
        }
        for way in payload.get("elements", [])
        if way.get("geometry") and way.get("tags", {}).get("highway") in HIGHWAY_CLASS
    ]


def to_grid(meta: dict, roads: list[dict]) -> list[list[float]]:
    lons = [lon for road in roads for lon, _ in road["coords"]]
    lats = [lat for road in roads for _, lat in road["coords"]]
    xs, ys = transform("EPSG:4326", meta["crs"], lons, lats)
    cell = float(meta["cellSize"])
    x0, y0 = meta["originUTM"]
    out: list[list[float]] = []
    k = 0
    for road in roads:
        flat: list[float] = [road["class"]]
        for _ in road["coords"]:
            # 0.01 cell = 25 cm, plenty for display
            flat.append(round((xs[k] - x0) / cell, 2))
            flat.append(round((y0 - ys[k]) / cell, 2))
            k += 1
        out.append(flat)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Export the OSM road network for display")
    parser.add_argument("--grid-dir", default="../web/public/data")
    args = parser.parse_args()
    grid_dir = Path(args.grid_dir)
    meta = json.loads((grid_dir / "grid.json").read_text())
    roads = fetch_roads(tuple(meta["bboxLonLat"]))
    payload = {
        "classes": list(CLASSES),
        "source": "OpenStreetMap contributors (ODbL)",
        "roads": to_grid(meta, roads),
    }
    (grid_dir / "roads.json").write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    counts = {name: sum(1 for r in roads if r["class"] == i) for i, name in enumerate(CLASSES)}
    print(json.dumps({"ways": len(roads), "byClass": counts}))


if __name__ == "__main__":
    main()
