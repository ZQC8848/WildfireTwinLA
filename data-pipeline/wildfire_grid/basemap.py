"""True-color basemap aligned to the simulation grid (web/public/data/satellite.jpg).

Uses the Sentinel-2 L2A `visual` (TCI, 10 m) asset of the most recent low-cloud scene before a
date, mosaics the MGRS tiles that cover the grid, warps it onto the grid extent and applies a
mild contrast stretch with slightly reduced saturation to suit the frontend's palette.

The frontend's default "hybrid" palette shows this image for developed land and uses its
brightness as texture for the LANDFIRE fuel colors. Attribution required by the Copernicus
terms: "Contains modified Copernicus Sentinel data".
"""

import argparse
import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import Affine
from rasterio.vrt import WarpedVRT

STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"


def find_scenes(bbox, before: str, max_cloud: float, days: int = 30) -> list:
    from datetime import datetime, timedelta

    import planetary_computer
    from pystac_client import Client

    end = datetime.fromisoformat(before)
    start = end - timedelta(days=days)
    client = Client.open(STAC_URL, modifier=planetary_computer.sign_inplace)
    items = list(
        client.search(
            collections=["sentinel-2-l2a"],
            bbox=bbox,
            datetime=f"{start.isoformat()}/{end.isoformat()}",
            query={"eo:cloud_cover": {"lt": max_cloud}},
        ).items()
    )
    if not items:
        raise RuntimeError("no low-cloud Sentinel-2 scene in the window")
    # Every MGRS tile of the most recent acquisition date
    latest = max(item.datetime.date() for item in items)
    return [item for item in items if item.datetime.date() == latest]


def grade(rgb: np.ndarray, saturation: float = 0.9, gamma: float = 0.85) -> np.ndarray:
    data = rgb.astype("float32")
    valid = data.sum(0) > 0
    low, high = np.percentile(data[:, valid], 1), np.percentile(data[:, valid], 99.5)
    data = np.clip((data - low) / max(high - low, 1), 0, 1) ** gamma
    gray = data.mean(0, keepdims=True)
    data = gray + (data - gray) * saturation
    return (np.clip(data, 0, 1) * 255).astype("uint8")


def build_basemap(grid_meta: dict, hrefs: list[str], pixels: int) -> np.ndarray:
    extent = grid_meta["cellSize"] * grid_meta["width"]
    cell = extent / pixels
    transform = Affine(cell, 0, grid_meta["originUTM"][0], 0, -cell, grid_meta["originUTM"][1])
    out = np.zeros((3, pixels, pixels), dtype="uint8")
    for href in hrefs:
        with (
            rasterio.open(href) as source,
            WarpedVRT(
                source,
                crs=grid_meta["crs"],
                transform=transform,
                width=pixels,
                height=pixels,
                resampling=Resampling.bilinear,
            ) as warped,
        ):
            data = warped.read()[:3]
        empty = out.sum(0) == 0
        fill = empty & (data.sum(0) > 0)
        out[:, fill] = data[:, fill]
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the grid-aligned true-color basemap")
    parser.add_argument("--grid-dir", default="../web/public/data")
    parser.add_argument("--before", default="2026-10-16T18:30:00Z", help="Latest scene time (UTC)")
    parser.add_argument("--max-cloud", type=float, default=5)
    parser.add_argument("--pixels", type=int, default=1280, help="Output size; 1280 is 10 m")
    args = parser.parse_args()
    grid_dir = Path(args.grid_dir)
    meta = json.loads((grid_dir / "grid.json").read_text())
    scenes = find_scenes(meta["bboxLonLat"], args.before, args.max_cloud)
    image = grade(build_basemap(meta, [s.assets["visual"].href for s in scenes], args.pixels))
    output = grid_dir / "satellite.jpg"
    with rasterio.open(
        output,
        "w",
        driver="JPEG",
        width=args.pixels,
        height=args.pixels,
        count=3,
        dtype="uint8",
        quality=88,
    ) as dataset:
        dataset.write(image)
    output.with_suffix(".jpg.aux.xml").unlink(missing_ok=True)
    (grid_dir / "satellite.source.json").write_text(
        json.dumps(
            {
                "scenes": [s.id for s in scenes],
                "datetime": scenes[0].datetime.isoformat(),
                "attribution": "Contains modified Copernicus Sentinel data 2026",
            },
            indent=2,
        )
        + "\n"
    )
    print(json.dumps({"output": str(output), "scenes": [s.id for s in scenes]}))


if __name__ == "__main__":
    main()
