# Offline data pipeline

This package aligns elevation, Sentinel-2 vegetation bands, and building polygons to the
same north-up UTM grid used by the browser and backend.

Discover the latest low-cloud Sentinel-2 L2A scene:

```bash
wildfire-sentinel \
  --bbox=-118.20,34.17,-118.06,34.27 \
  --output sentinel-assets.json
```

Download DEM and building inputs for the same bounding box:

```bash
wildfire-source dem --bbox=-118.20,34.17,-118.06,34.27 --output dem.tif
wildfire-source buildings --bbox=-118.20,34.17,-118.06,34.27 --output buildings.geojson
```

The DEM command uses the USGS National Map product API and writes a source sidecar. The
building command converts OpenStreetMap Overpass building ways into GeoJSON.

Build the grid from local GeoTIFFs or signed COG URLs from that manifest:

```bash
wildfire-grid \
  --dem dem.tif \
  --red B04.tif --nir B08.tif --nir-narrow B8A.tif --swir B11.tif \
  --buildings buildings.geojson \
  --bbox=-118.20,34.17,-118.06,34.27 \
  --output ../public/data
```

Outputs follow the frozen contract in `docs/team-plan.md`:

- `grid.json`: dimensions, CRS, origin and WGS84 bounding box
- `grid.bin`: little-endian Float32 RGBA (`elevation`, `fuel`, `dryness`, `class`)
- `slope-aspect.bin`: little-endian Float32 RG (`slope radians`, `aspect radians`)
- `buildings.json`: building id, representative grid cell and original lon/lat polygon

Rasterize community boundary polygons into the frozen `communities.json` contract:

```bash
wildfire-communities \
  --grid ../public/data/grid.json \
  --source communities.geojson \
  --output ../public/data/communities.json
```

Build a replay file from the public LA County dissolved Eaton Fire perimeter:

```bash
wildfire-eaton-replay \
  --grid ../public/data/grid.json \
  --output ../server/data/eaton-replay.jsonl
```

The default is 512×512 in EPSG:32611. Cloud masking uses the Sentinel Scene
Classification Layer when `--scl` is supplied.
