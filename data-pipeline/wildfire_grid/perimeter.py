"""Best available Norte Fire perimeter on the simulation grid.

Order of preference, each labelled in the output so the frontend never calls a proxy official:

1. NIFC WFIGS interagency perimeter (official).
2. Sentinel-2 dNBR burn scar from a pre-fire and a post-fire scene (`--pre`/`--post` B08 and B12
   rasters or signed COG URLs).
3. VIIRS-detected area: the union of the 375 m pixel footprints (scan x track) of the
   detections in the replay window. This is coarse: about 563 ha against the reported 570 acres
   (231 ha).

Writes data/norte/perimeter.json, which `wildfire-norte-replay` adds as the final incident event.
"""

import argparse
import csv
import json
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

import numpy as np
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.transform import Affine
from rasterio.warp import transform, transform_geom

WFIGS_QUERY = (
    "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/"
    "{layer}/FeatureServer/0/query"
)
WFIGS_LAYERS = ("WFIGS_Interagency_Perimeters_Current", "WFIGS_Interagency_Perimeters_YearToDate")
# dNBR above this is "low severity" or worse (Key & Benson 2006)
DNBR_BURNED = 0.27


def _grid_transform(meta: dict) -> Affine:
    cell = float(meta["cellSize"])
    return Affine(cell, 0, meta["originUTM"][0], 0, -cell, meta["originUTM"][1])


def fetch_wfigs(name: str = "NORTE", state: str = "US-CA") -> dict | None:
    """Most recent WFIGS perimeter polygon for the incident, or None."""
    for layer in WFIGS_LAYERS:
        params = urlencode(
            {
                "where": f"UPPER(poly_IncidentName) = '{name}' AND attr_POOState = '{state}'",
                "outFields": "poly_IncidentName,poly_GISAcres,poly_DateCurrent,poly_MapMethod",
                "outSR": 4326,
                "f": "geojson",
            }
        )
        with urlopen(f"{WFIGS_QUERY.format(layer=layer)}?{params}", timeout=60) as response:
            features = json.load(response).get("features") or []
        if features:
            return max(features, key=lambda f: f["properties"].get("poly_DateCurrent") or 0)
    return None


def cells_from_geometry(meta: dict, geometry: dict, crs: str = "EPSG:4326") -> list[int]:
    projected = transform_geom(crs, meta["crs"], geometry)
    mask = rasterize(
        [(projected, 1)],
        out_shape=(int(meta["height"]), int(meta["width"])),
        transform=_grid_transform(meta),
        fill=0,
        dtype="uint8",
    )
    return np.flatnonzero(mask).tolist()


def dnbr_cells(
    meta: dict,
    pre_nir: str,
    pre_swir: str,
    post_nir: str,
    post_swir: str,
    near: list[tuple[float, float]],
    radius_m: float = 3000,
) -> list[int]:
    """Cells with dNBR above DNBR_BURNED, kept only within radius_m of a detection."""
    from .cli import normalized_difference, read_band

    options = {
        "crs": meta["crs"],
        "transform": _grid_transform(meta),
        "width": int(meta["width"]),
        "height": int(meta["height"]),
        "resampling": Resampling.bilinear,
    }
    pre = normalized_difference(read_band(pre_nir, **options), read_band(pre_swir, **options))
    post = normalized_difference(read_band(post_nir, **options), read_band(post_swir, **options))
    burned = np.nan_to_num(pre - post) > DNBR_BURNED
    return np.flatnonzero(burned & near_mask(meta, near, radius_m)).tolist()


def near_mask(meta: dict, points: list[tuple[float, float]], radius_m: float) -> np.ndarray:
    height, width, cell = int(meta["height"]), int(meta["width"]), float(meta["cellSize"])
    rows, cols = np.mgrid[0:height, 0:width]
    xs = meta["originUTM"][0] + (cols + 0.5) * cell
    ys = meta["originUTM"][1] - (rows + 0.5) * cell
    out = np.zeros((height, width), dtype=bool)
    if not points:
        return out
    px, py = transform("EPSG:4326", meta["crs"], [p[0] for p in points], [p[1] for p in points])
    for x, y in zip(px, py, strict=True):
        out |= (xs - x) ** 2 + (ys - y) ** 2 <= radius_m**2
    return out


def viirs_pixels(raw_dir: Path, start: datetime, end: datetime, bbox) -> list[dict]:
    from .norte import LANDFILL, _distance_m

    west, south, east, north = bbox
    pixels = []
    for path in sorted(raw_dir.glob("firms_viirs_*_48h_2026-10-17.csv")):
        with path.open(newline="") as stream:
            for row in csv.DictReader(stream):
                lat, lon = float(row["latitude"]), float(row["longitude"])
                when = datetime.strptime(
                    f"{row['acq_date']} {row['acq_time'].zfill(4)}", "%Y-%m-%d %H%M"
                ).replace(tzinfo=UTC)
                if not (start <= when <= end and west <= lon <= east and south <= lat <= north):
                    continue
                if _distance_m(lat, lon, *LANDFILL) <= 750:
                    continue
                pixels.append(
                    {
                        "lat": lat,
                        "lon": lon,
                        "scanKm": float(row["scan"]),
                        "trackKm": float(row["track"]),
                    }
                )
    return pixels


def viirs_footprint_cells(meta: dict, pixels: list[dict]) -> list[int]:
    """Union of pixel footprints, approximated as scan (east-west) x track (north-south) boxes."""
    height, width, cell = int(meta["height"]), int(meta["width"]), float(meta["cellSize"])
    mask = np.zeros((height, width), dtype=bool)
    if not pixels:
        return []
    xs, ys = transform(
        "EPSG:4326", meta["crs"], [p["lon"] for p in pixels], [p["lat"] for p in pixels]
    )
    for pixel, x, y in zip(pixels, xs, ys, strict=True):
        col = (x - meta["originUTM"][0]) / cell
        row = (meta["originUTM"][1] - y) / cell
        half_x = pixel["scanKm"] * 1000 / 2 / cell
        half_y = pixel["trackKm"] * 1000 / 2 / cell
        r0, r1 = max(0, int(row - half_y)), min(height, int(row + half_y) + 1)
        c0, c1 = max(0, int(col - half_x)), min(width, int(col + half_x) + 1)
        mask[r0:r1, c0:c1] = True
    return np.flatnonzero(mask).tolist()


def build_perimeter(meta: dict, raw_dir: Path, args: argparse.Namespace) -> dict:
    from .norte import NORTE_BBOX, NORTE_IGNITION, REPLAY_END

    cell_ha = float(meta["cellSize"]) ** 2 / 1e4
    feature = None if args.skip_wfigs else fetch_wfigs()
    if feature:
        props = feature["properties"]
        cells = cells_from_geometry(meta, feature["geometry"])
        observed = props.get("poly_DateCurrent")
        result = {
            "source": "NIFC WFIGS interagency perimeter",
            "method": props.get("poly_MapMethod") or "unknown",
            "official": True,
            "label": "Official perimeter",
            "observedAt": datetime.fromtimestamp(observed / 1000, UTC).isoformat()
            if observed
            else None,
            "reportedAcres": props.get("poly_GISAcres"),
        }
    else:
        pixels = viirs_pixels(raw_dir, NORTE_IGNITION, REPLAY_END, NORTE_BBOX)
        if args.pre_nir and args.post_nir:
            cells = dnbr_cells(
                meta,
                args.pre_nir,
                args.pre_swir,
                args.post_nir,
                args.post_swir,
                [(p["lon"], p["lat"]) for p in pixels],
            )
            result = {
                "source": "Sentinel-2 L2A dNBR burn scar",
                "method": f"pre-post NBR difference > {DNBR_BURNED}, within 3 km of VIIRS detections",
                "official": False,
                "label": "Satellite burn scar (Sentinel-2)",
                "observedAt": args.post_time,
            }
        else:
            cells = viirs_footprint_cells(meta, pixels)
            result = {
                "source": "NASA FIRMS VIIRS 375 m detections",
                "method": f"union of {len(pixels)} pixel footprints (scan x track), 10-16 passes",
                "official": False,
                "label": "Satellite-detected area (VIIRS, coarse)",
                "observedAt": "2026-10-16T21:48:00Z",
            }
    result["areaHa"] = round(len(cells) * cell_ha, 1)
    result["cells"] = cells
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the best available Norte perimeter")
    parser.add_argument("--grid", default="../web/public/data/grid.json")
    parser.add_argument("--raw-dir", default="../data/norte/raw")
    parser.add_argument("--output", default="../data/norte/perimeter.json")
    parser.add_argument("--skip-wfigs", action="store_true", help="Do not query NIFC")
    parser.add_argument("--pre-nir", help="Pre-fire Sentinel-2 B08")
    parser.add_argument("--pre-swir", help="Pre-fire Sentinel-2 B12")
    parser.add_argument("--post-nir", help="Post-fire Sentinel-2 B08")
    parser.add_argument("--post-swir", help="Post-fire Sentinel-2 B12")
    parser.add_argument("--post-time", help="Post-fire scene time, ISO UTC")
    args = parser.parse_args()
    meta = json.loads(Path(args.grid).read_text())
    result = build_perimeter(meta, Path(args.raw_dir), args)
    Path(args.output).write_text(json.dumps(result) + "\n")
    summary = {k: v for k, v in result.items() if k != "cells"}
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
