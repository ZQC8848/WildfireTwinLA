import argparse
import json
from pathlib import Path

import planetary_computer
import pystac_client

STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"


def discover(bbox: tuple[float, float, float, float], max_cloud: float) -> dict:
    catalog = pystac_client.Client.open(STAC_URL)
    search = catalog.search(
        collections=["sentinel-2-l2a"],
        bbox=bbox,
        query={"eo:cloud_cover": {"lt": max_cloud}},
        sortby=[{"field": "properties.datetime", "direction": "desc"}],
        max_items=1,
    )
    item = next(search.items(), None)
    if item is None:
        raise RuntimeError("no Sentinel-2 scene matched the query")
    signed = planetary_computer.sign(item)
    assets = {}
    for name in ("B04", "B08", "B8A", "B11", "SCL", "visual"):
        if name in signed.assets:
            assets[name] = signed.assets[name].href
    return {
        "id": signed.id,
        "datetime": signed.datetime.isoformat() if signed.datetime else None,
        "cloudCover": signed.properties.get("eo:cloud_cover"),
        "assets": assets,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Discover a Sentinel-2 L2A scene")
    parser.add_argument(
        "--bbox", required=True, type=lambda value: tuple(map(float, value.split(",")))
    )
    parser.add_argument("--max-cloud", type=float, default=10)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if len(args.bbox) != 4:
        raise SystemExit("--bbox requires west,south,east,north")
    Path(args.output).write_text(json.dumps(discover(args.bbox, args.max_cloud), indent=2) + "\n")


if __name__ == "__main__":
    main()
