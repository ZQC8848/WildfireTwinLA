import argparse
import json
from pathlib import Path
from urllib.request import urlopen

import numpy as np
from rasterio.features import rasterize
from rasterio.transform import Affine
from rasterio.warp import transform_geom

EATON_PERIMETER_URL = (
    "https://services.arcgis.com/RmCCgQtiZLDCtblq/ArcGIS/rest/services/"
    "Eaton_and_Palisades_Dissolved_Fire_Perimeters/FeatureServer/0/query"
    "?where=OBJECTID%3D2&outFields=*&outSR=4326&f=geojson"
)


def perimeter_cells(grid: dict, geometry: dict) -> list[int]:
    cell_size = float(grid["cellSize"])
    origin_x, origin_y = grid["originUTM"]
    transform = Affine(cell_size, 0, origin_x, 0, -cell_size, origin_y)
    projected = transform_geom("EPSG:4326", grid["crs"], geometry)
    mask = rasterize(
        [(projected, 1)],
        out_shape=(int(grid["height"]), int(grid["width"])),
        transform=transform,
        fill=0,
        dtype="uint8",
    )
    return np.flatnonzero(mask.reshape(-1)).tolist()


def build_events(grid: dict, payload: dict) -> list[dict]:
    feature = payload["features"][0]
    cells = perimeter_cells(grid, feature["geometry"])
    return [
        {
            "offsetSeconds": 0,
            "type": "snapshot",
            "sequence": 0,
            "emittedAt": "2025-01-08T02:20:00Z",
            "mode": "replay",
            "event": "eaton",
            "dataset": "LA County dissolved Eaton perimeter",
            "sourceUrl": EATON_PERIMETER_URL,
            "incidents": [],
            "wind": None,
        },
        {
            "offsetSeconds": 2,
            "type": "incident",
            "sequence": 1,
            "emittedAt": "2025-01-21T20:00:00Z",
            "id": "eaton-2025",
            "hotspotIds": [],
            "centroid": [-118.1, 34.2],
            "latestAt": "2025-01-21T20:00:00Z",
            "perimeterCells": cells,
        },
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description="Build Eaton replay events from public perimeter")
    parser.add_argument("--grid", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    with urlopen(EATON_PERIMETER_URL, timeout=120) as response:
        payload = json.load(response)
    events = build_events(json.loads(Path(args.grid).read_text()), payload)
    Path(args.output).write_text("\n".join(json.dumps(event) for event in events) + "\n")


if __name__ == "__main__":
    main()
