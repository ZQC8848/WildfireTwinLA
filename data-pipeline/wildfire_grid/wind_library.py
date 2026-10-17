import argparse
import json
from pathlib import Path

import numpy as np

DIRECTIONS = [index * 22.5 for index in range(16)]
SPEEDS = [5, 12, 20]
OUTPUT_SIZE = 128


def resize_bilinear(source: np.ndarray, size: int = OUTPUT_SIZE) -> np.ndarray:
    """Resize a 2-D field without adding another image-processing dependency."""
    source = np.asarray(source, dtype="float64")
    source_y = np.arange(source.shape[0])
    source_x = np.arange(source.shape[1])
    target_y = np.linspace(0, source.shape[0] - 1, size)
    target_x = np.linspace(0, source.shape[1] - 1, size)
    horizontal = np.vstack([np.interp(target_x, source_x, row) for row in source])
    return np.vstack(
        [np.interp(target_y, source_y, horizontal[:, column]) for column in range(size)]
    ).T


def wind_components(
    speed: np.ndarray, direction_from_deg: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    radians = np.radians(direction_from_deg)
    east = -speed * np.sin(radians)
    north = -speed * np.cos(radians)
    return east, north


def load_dem(grid_dir: Path) -> tuple[dict, np.ndarray]:
    metadata = json.loads((grid_dir / "grid.json").read_text())
    height = int(metadata["height"])
    width = int(metadata["width"])
    grid = np.fromfile(grid_dir / "grid.bin", dtype="<f4").reshape(height, width, 4)
    if height % OUTPUT_SIZE or width % OUTPUT_SIZE:
        raise ValueError("grid dimensions must be divisible by 128")
    block_y = height // OUTPUT_SIZE
    block_x = width // OUTPUT_SIZE
    elevation = grid[:, :, 0].reshape(OUTPUT_SIZE, block_y, OUTPUT_SIZE, block_x).mean(axis=(1, 3))
    return metadata, np.maximum(elevation, 0).astype("float64")


def run_library(grid_dir: Path, output_dir: Path) -> None:
    try:
        import windninjapy as windninja
    except ImportError as error:
        raise RuntimeError(
            "windninjapy is required; run this command in its supported Python 3.9 environment"
        ) from error

    metadata, elevation = load_dem(grid_dir)
    origin_x, origin_y = metadata["originUTM"]
    cell_size = float(metadata["cellSize"]) * int(metadata["width"]) / OUTPUT_SIZE
    geotransform = [origin_x, cell_size, 0, origin_y, 0, -cell_size]
    fields = np.empty((len(DIRECTIONS), len(SPEEDS), OUTPUT_SIZE, OUTPUT_SIZE, 2), dtype="<f4")

    for direction_index, direction in enumerate(DIRECTIONS):
        for speed_index, inflow_speed in enumerate(SPEEDS):
            simulation = windninja.WindNinjaCore()
            try:
                simulation.set_dem_array(elevation, geotransform, metadata["crs"])
                simulation.set_uniform_wind(float(inflow_speed), float(direction), "mps")
                simulation.set_vegetation("brush")
                simulation.set_mesh_choice("fine")
                simulation.set_wind_height(10.0, "m")
                simulation.set_num_layers(20)
                simulation.set_diurnal_winds(False)
                if not simulation.simulate():
                    raise RuntimeError(
                        f"WindNinja failed for {direction} degrees at {inflow_speed} m/s"
                    )
                speed_grid, direction_grid = simulation.get_output_grids()
            finally:
                simulation.cleanup()

            east, north = wind_components(np.asarray(speed_grid), np.asarray(direction_grid))
            # WindNinja's grid starts at yll; the browser contract starts at the north edge.
            fields[direction_index, speed_index, :, :, 0] = resize_bilinear(np.flipud(east))
            fields[direction_index, speed_index, :, :, 1] = resize_bilinear(np.flipud(north))

    north_case = fields[0, 0]
    if float(north_case[:, :, 1].mean()) >= 0:
        raise RuntimeError("north-wind validation failed: the mean vector does not point south")

    output_dir.mkdir(parents=True, exist_ok=True)
    fields.tofile(output_dir / "wind-library.bin")
    index = {
        "width": OUTPUT_SIZE,
        "height": OUTPUT_SIZE,
        "directions": DIRECTIONS,
        "speeds": SPEEDS,
        "file": "wind-library.bin",
        "source": "WindNinja mass-conserving C API, brush, 10 m, resampled to 100 m",
    }
    (output_dir / "index.json").write_text(json.dumps(index, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the 48-case WindNinja lookup library")
    parser.add_argument("--grid-dir", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    run_library(Path(args.grid_dir), Path(args.output))


if __name__ == "__main__":
    main()
