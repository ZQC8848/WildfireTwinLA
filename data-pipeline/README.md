# Offline data pipeline

This package aligns elevation, Sentinel-2 vegetation bands, and building polygons to the
same north-up UTM grid used by the browser and backend.

Discover the last low-cloud Sentinel-2 L2A scene before the Norte Fire:

```bash
wildfire-sentinel \
  --bbox=-117.714,33.427,-117.576,33.543 \
  --before=2026-10-15T23:59:59Z \
  --output sentinel-assets.json
```

Download DEM and building inputs for the same bounding box:

```bash
wildfire-source dem --bbox=-117.714,33.427,-117.576,33.543 --output dem.tif
wildfire-source buildings --bbox=-117.714,33.427,-117.576,33.543 --output buildings.geojson
```

The DEM command uses the USGS National Map product API and writes a source sidecar. The
building command converts OpenStreetMap Overpass building ways into GeoJSON.

Build the grid from local GeoTIFFs or signed COG URLs from that manifest:

```bash
wildfire-grid \
  --dem dem.tif \
  --red B04.tif --nir B08.tif --nir-narrow B8A.tif --swir B11.tif \
  --buildings buildings.geojson \
  --scl SCL.tif \
  --bbox=-117.714,33.427,-117.576,33.543 \
  --output ../web/public/data
```

Outputs follow the frozen contract in `docs/team-plan.md`:

- `grid.json`: dimensions, CRS, origin and WGS84 bounding box
- `grid.bin`: little-endian Float32 RGBA (`elevation`, `fuel`, `dryness`, `class`)
- `slope-aspect.bin`: little-endian Float32 RG (`slope radians`, `aspect radians`)
- `buildings.json`: building id, representative grid cell and original lon/lat polygon

Rasterize community boundary polygons into the frozen `communities.json` contract:

```bash
wildfire-communities \
  --grid ../web/public/data/grid.json \
  --source ../data/norte/communities-approx.geojson \
  --output ../web/public/data/communities.json
```

Build the Norte replay from the archived WFIGS, HRRR, and FIRMS inputs:

```bash
wildfire-norte-replay \
  --raw-dir ../data/norte/raw \
  --grid ../web/public/data/grid.json \
  --output ../server/data/norte-replay.jsonl
```

Build the 48-case WindNinja library in a Python 3.9 environment containing
`windninjapy`:

```bash
wildfire-wind-library \
  --grid-dir ../web/public/data \
  --output ../web/public/data/wind
```

The library uses 16 directions × 3 speeds, brush vegetation, 10 m input/output wind,
the mass-conserving solver, and the north-to-south binary layout in `docs/wind-field.md`.
The old Eaton replay generator remains available for compatibility:

```bash
wildfire-eaton-replay \
  --grid ../public/data/grid.json \
  --output ../server/data/eaton-replay.jsonl
```

The default is 512×512 in EPSG:32611. Cloud masking uses the Sentinel Scene
Classification Layer when `--scl` is supplied.
