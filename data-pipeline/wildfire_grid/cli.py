import argparse
import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.transform import from_bounds, rowcol
from rasterio.vrt import WarpedVRT
from rasterio.warp import transform_bounds, transform_geom


def read_band(
    path: str,
    *,
    crs: str,
    transform,
    width: int,
    height: int,
    resampling: Resampling = Resampling.bilinear,
) -> np.ndarray:
    with (
        rasterio.open(path) as source,
        WarpedVRT(
            source,
            crs=crs,
            transform=transform,
            width=width,
            height=height,
            resampling=resampling,
        ) as dataset,
    ):
        return dataset.read(1, masked=True).filled(np.nan).astype("float32")


def normalized_difference(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    denominator = a + b
    return np.divide(a - b, denominator, out=np.zeros_like(a), where=np.abs(denominator) > 1e-6)


def terrain_derivatives(
    elevation: np.ndarray, cell_x: float, cell_y: float
) -> tuple[np.ndarray, np.ndarray]:
    safe = np.nan_to_num(elevation, nan=float(np.nanmedian(elevation)))
    grad_y, grad_x = np.gradient(safe, cell_y, cell_x)
    slope = np.arctan(np.hypot(grad_x, grad_y)).astype("float32")
    aspect = np.mod(np.arctan2(-grad_x, grad_y), 2 * np.pi).astype("float32")
    return slope, aspect


def load_buildings(path: str | None, crs: str, transform, shape: tuple[int, int]):
    if not path:
        return np.zeros(shape, dtype="uint8"), []
    payload = json.loads(Path(path).read_text())
    source_crs = payload.get("crs", {}).get("properties", {}).get("name", "EPSG:4326")
    projected: list[tuple[dict, int]] = []
    records: list[dict] = []
    height, width = shape
    for index, feature in enumerate(payload.get("features", [])):
        geometry = feature.get("geometry")
        if not geometry:
            continue
        projected_geometry = transform_geom(source_crs, crs, geometry)
        projected.append((projected_geometry, 1))
        coordinates = projected_geometry.get("coordinates", [])
        ring = coordinates[0] if projected_geometry["type"] == "Polygon" else coordinates[0][0]
        center_x = sum(point[0] for point in ring) / len(ring)
        center_y = sum(point[1] for point in ring) / len(ring)
        row, column = rowcol(transform, center_x, center_y)
        row = max(0, min(height - 1, row))
        column = max(0, min(width - 1, column))
        records.append(
            {
                "id": str(feature.get("id") or feature.get("properties", {}).get("id") or index),
                "cell": row * width + column,
                "weight": feature.get("properties", {}).get("weight", 1),
                "polygonLonLat": geometry,
            }
        )
    mask = rasterize(projected, out_shape=shape, transform=transform, fill=0, dtype="uint8")
    return mask, records


def build_grid(args: argparse.Namespace) -> None:
    west, south, east, north = args.bbox
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    bounds = transform_bounds("EPSG:4326", args.crs, west, south, east, north)
    transform = from_bounds(*bounds, args.width, args.height)
    read_options = {
        "crs": args.crs,
        "transform": transform,
        "width": args.width,
        "height": args.height,
    }
    elevation = read_band(args.dem, **read_options)
    if args.red and args.nir:
        red = read_band(args.red, **read_options)
        nir = read_band(args.nir, **read_options)
        ndvi = normalized_difference(nir, red)
        fuel = np.clip((ndvi - 0.15) / 0.6, 0, 1)
    else:
        fuel = np.zeros_like(elevation)
    moisture_nir = args.nir_narrow or args.nir
    if args.swir and moisture_nir:
        swir = read_band(args.swir, **read_options)
        moisture = read_band(moisture_nir, **read_options)
        ndmi = normalized_difference(moisture, swir)
        dryness = np.clip((0.3 - ndmi) / 0.5, 0, 1)
    else:
        dryness = np.full_like(elevation, 0.5)
    if args.scl:
        scl = read_band(args.scl, **read_options, resampling=Resampling.nearest)
        invalid = np.isin(scl.astype("int16"), [0, 1, 3, 6, 8, 9, 10, 11])
        fuel[invalid] = 0
        dryness[invalid] = 0
    building_mask, buildings = load_buildings(
        args.buildings, args.crs, transform, (args.height, args.width)
    )
    classes = np.where(fuel > 0, 1, 0).astype("float32")
    classes[building_mask == 1] = 2
    fuel[building_mask == 1] = 0
    grid = np.stack(
        (
            np.nan_to_num(elevation),
            np.nan_to_num(fuel),
            np.nan_to_num(dryness),
            classes,
        ),
        axis=-1,
    ).astype("<f4")
    slope, aspect = terrain_derivatives(elevation, abs(transform.a), abs(transform.e))
    np.stack((slope, aspect), axis=-1).astype("<f4").tofile(output / "slope-aspect.bin")
    grid.tofile(output / "grid.bin")
    metadata = {
        "width": args.width,
        "height": args.height,
        "cellSize": abs(transform.a),
        "crs": args.crs,
        "originUTM": [transform.c, transform.f],
        "bboxLonLat": list(args.bbox),
        "layout": "row-major, north-to-south, little-endian Float32 RGBA",
    }
    (output / "grid.json").write_text(json.dumps(metadata, indent=2) + "\n")
    (output / "buildings.json").write_text(json.dumps(buildings) + "\n")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Build the WildfireTwinLA aligned grid")
    result.add_argument("--dem", required=True)
    result.add_argument("--red")
    result.add_argument("--nir")
    result.add_argument("--nir-narrow", help="Sentinel-2 B8A band used for NDMI")
    result.add_argument("--swir")
    result.add_argument("--scl")
    result.add_argument("--buildings")
    result.add_argument(
        "--bbox", required=True, type=lambda value: tuple(map(float, value.split(",")))
    )
    result.add_argument("--crs", default="EPSG:32611")
    result.add_argument("--width", type=int, default=512)
    result.add_argument("--height", type=int, default=512)
    result.add_argument("--output", required=True)
    return result


def main() -> None:
    args = parser().parse_args()
    if len(args.bbox) != 4:
        raise SystemExit("--bbox requires west,south,east,north")
    build_grid(args)


if __name__ == "__main__":
    main()
