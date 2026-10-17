# Offline data pipeline

This package aligns elevation, Sentinel-2 vegetation bands, and building polygons to the
same north-up UTM grid used by the browser and backend.

Discover the latest low-cloud Sentinel-2 L2A scene:

```bash
wildfire-sentinel \
  --bbox=-118.20,34.17,-118.06,34.27 \
  --output sentinel-assets.json
```

Build the grid from local GeoTIFFs or signed COG URLs from that manifest:

```bash
wildfire-grid \
  --dem dem.tif \
  --red B04.tif --nir B08.tif --swir B11.tif \
  --buildings buildings.geojson \
  --bbox=-118.20,34.17,-118.06,34.27 \
  --output ../public/data
```

Outputs follow the frozen contract in `docs/team-plan.md`:

- `grid.json`: dimensions, CRS, origin and WGS84 bounding box
- `grid.bin`: little-endian Float32 RGBA (`elevation`, `fuel`, `dryness`, `class`)
- `slope-aspect.bin`: little-endian Float32 RG (`slope radians`, `aspect radians`)
- `buildings.json`: building id, representative grid cell and original lon/lat polygon

The default is 512×512 in EPSG:32611. Cloud masking uses the Sentinel Scene
Classification Layer when `--scl` is supplied.
