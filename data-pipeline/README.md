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

Download the LANDFIRE fuel models (FBFM40, fall 2026 seasonal fuels by default). NDVI alone
classifies cured grass as unburnable and irrigated yards as wildland; FBFM40 decides fuel and
class when it is supplied:

```bash
wildfire-source fbfm40 --bbox=-117.714,33.427,-117.576,33.543 --output fbfm40.tif
```

Build the grid from local GeoTIFFs or signed COG URLs from that manifest:

```bash
wildfire-grid \
  --dem dem.tif \
  --red B04.tif --nir B08.tif --nir-narrow B8A.tif --swir B11.tif \
  --buildings buildings.geojson \
  --scl SCL.tif \
  --fbfm40 fbfm40.tif \
  --bbox=-117.714,33.427,-117.576,33.543 \
  --output ../web/public/data
```

Outputs follow the frozen contract in `docs/team-plan.md`:

- `grid.json`: dimensions, CRS, origin and WGS84 bounding box
- `grid.bin`: little-endian Float32 RGBA (`elevation`, `fuel`, `dryness`, `class`)
- `slope-aspect.bin`: little-endian Float32 RG (`slope radians`, `aspect radians`)
- `buildings.json`: building id, representative grid cell and outer ring as `[lon, lat][]`
- `fuel-model.bin` (with `--fbfm40`): one uint8 FBFM40 code per cell, same layout as `grid.bin`

To recompute fuel and class of an existing grid without downloading DEM and Sentinel-2 again:

```bash
wildfire-fuel --grid-dir ../web/public/data --fbfm40 fbfm40.tif
```

Rasterize community boundary polygons into the frozen `communities.json` contract:

```bash
wildfire-communities \
  --grid ../web/public/data/grid.json \
  --source ../data/norte/communities-approx.geojson \
  --output ../web/public/data/communities.json
```

Build the grid-aligned true-color basemap `satellite.jpg` from the last low-cloud Sentinel-2 L2A
scene before the fire (10 m TCI, MGRS tiles mosaicked). The frontend uses it for developed land and
as texture for the fuel colors. Attribution: "Contains modified Copernicus Sentinel data".

```bash
wildfire-basemap --grid-dir ../web/public/data --before 2026-10-16T18:30:00Z
```

Export the OpenStreetMap road network in grid coordinates (`roads.json`, display only; the
frontend drapes it on the terrain as a 4096² texture):

```bash
wildfire-roads --grid-dir ../web/public/data
```

Build the best available Norte perimeter (NIFC WFIGS, else a Sentinel-2 dNBR burn scar when
`--pre-nir/--pre-swir/--post-nir/--post-swir` are given, else the coarse VIIRS-detected area),
and flag buildings along the streets where OCFA reported damage:

```bash
wildfire-norte-perimeter
wildfire-norte-damage
```

Build the Norte replay from the archived WFIGS, HRRR, and FIRMS inputs. It ends at 18:00 PDT,
when the fire was knocked down, and adds `data/norte/perimeter.json` as the last event:

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
