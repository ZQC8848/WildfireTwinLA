import argparse
import json

import numpy as np
import rasterio
from rasterio.transform import from_bounds

from wildfire_grid.cli import build_grid, normalized_difference, terrain_derivatives


def test_normalized_difference_handles_zero_denominator() -> None:
    result = normalized_difference(np.array([1.0, 0.0]), np.array([0.0, 0.0]))
    np.testing.assert_allclose(result, [1.0, 0.0])


def test_flat_terrain_has_zero_slope() -> None:
    slope, _ = terrain_derivatives(np.ones((4, 4), dtype="float32"), 25, 25)
    np.testing.assert_allclose(slope, 0)


def _write_raster(path, values: np.ndarray) -> None:
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=values.shape[1],
        height=values.shape[0],
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=from_bounds(-118.2, 34.17, -118.06, 34.27, *values.shape[::-1]),
    ) as dataset:
        dataset.write(values.astype("float32"), 1)


def test_build_grid_writes_the_browser_contract(tmp_path) -> None:
    shape = (4, 4)
    dem = tmp_path / "dem.tif"
    red = tmp_path / "red.tif"
    nir = tmp_path / "nir.tif"
    swir = tmp_path / "swir.tif"
    _write_raster(dem, np.arange(16).reshape(shape) + 100)
    _write_raster(red, np.full(shape, 0.2))
    _write_raster(nir, np.full(shape, 0.8))
    _write_raster(swir, np.full(shape, 0.4))
    output = tmp_path / "output"

    build_grid(
        argparse.Namespace(
            dem=str(dem),
            red=str(red),
            nir=str(nir),
            swir=str(swir),
            scl=None,
            buildings=None,
            bbox=(-118.2, 34.17, -118.06, 34.27),
            crs="EPSG:32611",
            width=8,
            height=6,
            output=str(output),
        )
    )

    metadata = json.loads((output / "grid.json").read_text())
    grid = np.fromfile(output / "grid.bin", dtype="<f4").reshape(6, 8, 4)
    terrain = np.fromfile(output / "slope-aspect.bin", dtype="<f4").reshape(6, 8, 2)
    assert metadata["width"] == 8
    assert metadata["height"] == 6
    assert grid.shape == (6, 8, 4)
    assert terrain.shape == (6, 8, 2)
    assert np.all(grid[:, :, 1] > 0)
    assert json.loads((output / "buildings.json").read_text()) == []
