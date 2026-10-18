"""Fuel and cell class from LANDFIRE FBFM40 (Scott & Burgan 2005 fire behavior fuel models).

NDVI alone cannot classify October fuels in coastal Southern California: cured annual grass has
NDVI around 0.1-0.2, so an NDVI threshold turns the most flammable cover into "unburnable",
while irrigated urban landscaping reads as dense vegetation. FBFM40 separates them.

`fuel` in grid.bin is a 0-1 relative fire-behavior index used by the cellular automaton. It
modulates spread probability and burn duration together. The values below rank the models by
their Scott & Burgan rate of spread and fireline intensity under very dry, windy conditions.
They are hackathon assumptions, not fitted coefficients.

Also used:

* `wildfire-grid --fbfm40` during a full rebuild.
* `wildfire-fuel`, which recomputes fuel and class in an existing grid directory and writes
  `fuel-model.bin` (one uint8 FBFM40 code per cell, same layout as grid.bin).
"""

import argparse
import json
from pathlib import Path

import numpy as np
from rasterio.enums import Resampling
from rasterio.transform import Affine

FUEL_BY_MODEL: dict[int, float] = {
    # GR grass: fast spread, light load
    101: 0.30,
    102: 0.50,
    103: 0.60,
    104: 0.65,
    105: 0.70,
    106: 0.70,
    107: 0.75,
    108: 0.80,
    109: 0.80,
    # GS grass-shrub (coastal sage scrub in this area)
    121: 0.40,
    122: 0.55,
    123: 0.65,
    124: 0.75,
    # SH shrub (chaparral)
    141: 0.40,
    142: 0.60,
    143: 0.50,
    144: 0.65,
    145: 0.90,
    146: 0.75,
    147: 0.90,
    148: 0.80,
    149: 0.95,
    # TU timber-understory
    161: 0.35,
    162: 0.45,
    163: 0.60,
    164: 0.55,
    165: 0.70,
    # TL timber litter
    181: 0.15,
    182: 0.20,
    183: 0.20,
    184: 0.25,
    185: 0.30,
    186: 0.30,
    187: 0.30,
    188: 0.35,
    189: 0.40,
    # SB slash-blowdown
    201: 0.50,
    202: 0.60,
    203: 0.70,
    204: 0.85,
}
NB_URBAN = 91
NB_WATER = 98
# All NB (non-burnable) models stay unburnable, including irrigated urban landscaping. Fire
# enters developed land through embers igniting buildings, which the simulator models
# separately. Giving yards even a low fuel lets the cellular automaton carry a wind-driven
# front straight through neighbourhoods, because fuel only scales spread probability by ±40%.

LANDFIRE_FBFM40_LAYERS = {
    "FA26": "Landfire_LF2025_Seasonal_Fuels_2026/LF2025_FBFM40_FA26",
    "SU26": "Landfire_LF2025_Seasonal_Fuels_2026/LF2025_FBFM40_SU26",
    "SP26": "Landfire_LF2025_Seasonal_Fuels_2026/LF2025_FBFM40_SP26",
    "ES26": "Landfire_LF2025_Seasonal_Fuels_2026/LF2025_FBFM40_ES26",
    "LF2025": "Landfire_LF2025/LF2025_FBFM40_CONUS",
}


def apply_fbfm40(
    model: np.ndarray,
    ndvi_vegetated: np.ndarray,
    building_mask: np.ndarray,
    dryness: np.ndarray,
    ndvi_fuel: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (fuel, classes, dryness) for every cell.

    model: FBFM40 codes (0 where LANDFIRE has no data).
    ndvi_vegetated: Sentinel-2 NDVI says the cell is green. Used only where LANDFIRE has no
        data.
    building_mask: OSM footprints. These cells stay class 2 with no fuel.
    ndvi_fuel: optional NDVI-derived fuel for the no-data fallback.
    """
    model = model.astype("int32")
    fuel = np.zeros(model.shape, dtype="float32")
    lookup = np.zeros(256, dtype="float32")
    for code, value in FUEL_BY_MODEL.items():
        lookup[code] = value
    burnable_model = lookup[np.clip(model, 0, 255)] > 0
    fuel[burnable_model] = lookup[np.clip(model, 0, 255)][burnable_model]
    missing = (model <= 0) & ndvi_vegetated
    if ndvi_fuel is not None:
        fuel[missing] = np.clip(ndvi_fuel[missing], 0, 1)

    classes = np.where(fuel > 0, 1, 0).astype("float32")
    classes[building_mask] = 2
    fuel[building_mask] = 0

    # Cells that become burnable here may have had no NDMI (cloud or water mask in the scene);
    # give them the typical dryness of the burnable cells instead of zero.
    dryness = dryness.astype("float32").copy()
    burnable = classes == 1
    known = burnable & (dryness > 0)
    fill = float(np.median(dryness[known])) if known.any() else 0.5
    dryness[burnable & (dryness <= 0)] = fill
    dryness[classes == 0] = 0
    return fuel, classes, dryness


def fuel_from_grid_dir(grid_dir: Path, fbfm40_path: str) -> dict:
    """Recompute fuel, class and dryness of an existing grid directory in place."""
    from .cli import read_band

    meta = json.loads((grid_dir / "grid.json").read_text())
    width, height = int(meta["width"]), int(meta["height"])
    cell = float(meta["cellSize"])
    transform = Affine(cell, 0, meta["originUTM"][0], 0, -cell, meta["originUTM"][1])
    grid = np.fromfile(grid_dir / "grid.bin", dtype="<f4").reshape(height, width, 4).copy()
    model = read_band(
        fbfm40_path,
        crs=meta["crs"],
        transform=transform,
        width=width,
        height=height,
        resampling=Resampling.nearest,
    )
    model = np.nan_to_num(model, nan=0).astype("int32")
    before = grid[..., 3].copy()
    # In the NDVI-built grid, fuel > 0 means NDVI > 0.15.
    ndvi_vegetated = grid[..., 1] > 0
    fuel, classes, dryness = apply_fbfm40(
        model, ndvi_vegetated, before == 2, grid[..., 2], ndvi_fuel=grid[..., 1]
    )
    grid[..., 1] = fuel
    grid[..., 2] = dryness
    grid[..., 3] = classes
    grid.astype("<f4").tofile(grid_dir / "grid.bin")
    np.clip(model, 0, 255).astype("uint8").tofile(grid_dir / "fuel-model.bin")
    return summarize(model, before, classes, fuel)


def summarize(model: np.ndarray, before: np.ndarray, after: np.ndarray, fuel: np.ndarray) -> dict:
    total = model.size

    def share(mask: np.ndarray) -> float:
        return round(float(mask.sum()) / total * 100, 1)

    return {
        "unburnablePercent": {"before": share(before == 0), "after": share(after == 0)},
        "vegetationPercent": {"before": share(before == 1), "after": share(after == 1)},
        "buildingPercent": share(after == 2),
        "grassPercent": share((model >= 101) & (model <= 109)),
        "grassShrubPercent": share((model >= 121) & (model <= 124)),
        "shrubPercent": share((model >= 141) & (model <= 149)),
        "urbanPercent": share(model == NB_URBAN),
        "waterPercent": share(model == NB_WATER),
        "meanVegetationFuel": round(float(fuel[after == 1].mean()), 3) if (after == 1).any() else 0,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Recompute fuel and class of an existing grid from LANDFIRE FBFM40"
    )
    parser.add_argument("--grid-dir", default="../web/public/data")
    parser.add_argument("--fbfm40", required=True, help="GeoTIFF from `wildfire-source fbfm40`")
    args = parser.parse_args()
    print(json.dumps(fuel_from_grid_dir(Path(args.grid_dir), args.fbfm40), indent=2))


if __name__ == "__main__":
    main()
