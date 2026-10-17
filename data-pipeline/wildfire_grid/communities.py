import argparse
import json
from pathlib import Path

import numpy as np
from rasterio.features import rasterize
from rasterio.transform import Affine
from rasterio.warp import transform_geom


def build_communities(grid_path: str, source_path: str) -> list[dict]:
    grid = json.loads(Path(grid_path).read_text())
    source = json.loads(Path(source_path).read_text())
    width = int(grid["width"])
    height = int(grid["height"])
    cell_size = float(grid["cellSize"])
    origin_x, origin_y = grid["originUTM"]
    transform = Affine(cell_size, 0, origin_x, 0, -cell_size, origin_y)
    source_crs = source.get("crs", {}).get("properties", {}).get("name", "EPSG:4326")
    communities: list[dict] = []
    for index, feature in enumerate(source.get("features", [])):
        geometry = feature.get("geometry")
        if not geometry:
            continue
        projected = transform_geom(source_crs, grid["crs"], geometry)
        mask = rasterize(
            [(projected, 1)],
            out_shape=(height, width),
            transform=transform,
            fill=0,
            dtype="uint8",
        )
        properties = feature.get("properties", {})
        community = {
            "id": str(feature.get("id") or properties.get("id") or index),
            "name": str(properties.get("name") or properties.get("NAME") or index),
            "cells": np.flatnonzero(mask.reshape(-1)).tolist(),
        }
        if "approx" in properties:
            community["approx"] = bool(properties["approx"])
        communities.append(community)
    return communities


def main() -> None:
    parser = argparse.ArgumentParser(description="Rasterize community polygons into grid cells")
    parser.add_argument("--grid", required=True, help="Path to grid.json")
    parser.add_argument("--source", required=True, help="Community boundary GeoJSON")
    parser.add_argument("--output", required=True, help="Output communities.json")
    args = parser.parse_args()
    communities = build_communities(args.grid, args.source)
    Path(args.output).write_text(json.dumps(communities, indent=2) + "\n")


if __name__ == "__main__":
    main()
