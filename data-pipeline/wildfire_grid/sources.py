import argparse
import json
import re
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_URLS = (
    OVERPASS_URL,
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.nchc.org.tw/api/interpreter",
)
USGS_PRODUCTS_URL = "https://tnmaccess.nationalmap.gov/api/v1/products"
USGS_DEM_DATASET = "National Elevation Dataset (NED) 1/3 arc-second"


def overpass_to_geojson(payload: dict) -> dict:
    features = []
    for element in payload.get("elements", []):
        geometry = element.get("geometry") or []
        if element.get("type") != "way" or len(geometry) < 4:
            continue
        coordinates = [[point["lon"], point["lat"]] for point in geometry]
        if coordinates[0] != coordinates[-1]:
            coordinates.append(coordinates[0])
        features.append(
            {
                "type": "Feature",
                "id": f"osm-way-{element['id']}",
                "properties": {**element.get("tags", {}), "osm_id": element["id"]},
                "geometry": {"type": "Polygon", "coordinates": [coordinates]},
            }
        )
    return {"type": "FeatureCollection", "features": features}


def fetch_buildings(bbox: tuple[float, float, float, float]) -> dict:
    west, south, east, north = bbox
    mid_lon = (west + east) / 2
    mid_lat = (south + north) / 2
    tiles = (
        (west, south, mid_lon, mid_lat),
        (mid_lon, south, east, mid_lat),
        (west, mid_lat, mid_lon, north),
        (mid_lon, mid_lat, east, north),
    )
    by_id: dict[str, dict] = {}
    for tile in tiles:
        tile_west, tile_south, tile_east, tile_north = tile
        query = (
            f'[out:json][timeout:120];way["building"]'
            f"({tile_south},{tile_west},{tile_north},{tile_east});out geom;"
        )
        payload = _fetch_overpass(query)
        for feature in overpass_to_geojson(payload)["features"]:
            by_id[str(feature["id"])] = feature
    return {"type": "FeatureCollection", "features": list(by_id.values())}


def _fetch_overpass(query: str) -> dict:
    return overpass_to_geojson(fetch_overpass_raw(query))


def fetch_overpass_raw(query: str, rounds: int = 4) -> dict:
    """Overpass JSON from the first endpoint that answers.

    The public servers often reject requests at capacity; they ask clients to retry with
    exponential backoff, so each round waits 15, 30, 60 s before trying all endpoints again.
    """
    last_error: Exception | None = None
    for attempt in range(rounds):
        if attempt:
            time.sleep(15 * 2 ** (attempt - 1))
        for url in OVERPASS_URLS:
            result = _try_overpass(url, query)
            if isinstance(result, dict):
                return result
            last_error = result
    raise RuntimeError("all Overpass endpoints failed") from last_error


def _try_overpass(url: str, query: str) -> dict | Exception:
    request = Request(
        url,
        data=urlencode({"data": query}).encode(),
        headers={"User-Agent": "WildfireTwinLA/0.1"},
    )
    try:
        with urlopen(request, timeout=180) as response:
            return json.load(response)
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as error:
        return error


def fetch_dem(bbox: tuple[float, float, float, float]) -> tuple[bytes, str]:
    params = urlencode(
        {
            "datasets": USGS_DEM_DATASET,
            "bbox": ",".join(map(str, bbox)),
            "outputFormat": "JSON",
            "max": 100,
        }
    )
    with urlopen(f"{USGS_PRODUCTS_URL}?{params}", timeout=60) as response:
        payload = json.load(response)
    items = payload.get("items") or []
    if not items:
        raise RuntimeError("USGS returned no DEM product for the bounding box")
    item = max(items, key=_dem_sort_key)
    url = item.get("downloadURL") or item.get("urls", {}).get("TIFF")
    if not url:
        raise RuntimeError("USGS DEM product has no downloadable GeoTIFF")
    with urlopen(url, timeout=300) as response:
        return response.read(), url


LANDFIRE_IMAGE_SERVICES = "https://lfps.usgs.gov/arcgis/rest/services"


def fetch_fbfm40(
    bbox: tuple[float, float, float, float],
    layer: str = "FA26",
    crs: str = "EPSG:32611",
    cell_size: float = 30.0,
    margin_m: float = 500.0,
) -> tuple[bytes, str]:
    """LANDFIRE FBFM40 GeoTIFF covering the bbox, exported at its native 30 m in the grid CRS.

    `layer` is a key of fuels.LANDFIRE_FBFM40_LAYERS. FA26 is the fall 2026 seasonal fuel
    model, matching an October fire. The grid build resamples it with nearest neighbour.
    """
    from rasterio.warp import transform_bounds

    from .fuels import LANDFIRE_FBFM40_LAYERS

    left, bottom, right, top = transform_bounds("EPSG:4326", crs, *bbox)
    left, bottom, right, top = left - margin_m, bottom - margin_m, right + margin_m, top + margin_m
    width = round((right - left) / cell_size)
    height = round((top - bottom) / cell_size)
    epsg = crs.split(":")[1]
    params = urlencode(
        {
            "bbox": f"{left},{bottom},{left + width * cell_size},{bottom + height * cell_size}",
            "bboxSR": epsg,
            "imageSR": epsg,
            "size": f"{width},{height}",
            "format": "tiff",
            "pixelType": "U8",
            "interpolation": "RSP_NearestNeighbor",
            "noData": 0,
            "f": "image",
        }
    )
    url = f"{LANDFIRE_IMAGE_SERVICES}/{LANDFIRE_FBFM40_LAYERS[layer]}/ImageServer/exportImage?{params}"
    with urlopen(url, timeout=120) as response:
        content = response.read()
    if not content.startswith((b"II*\x00", b"MM\x00*")):
        raise RuntimeError(f"LANDFIRE did not return a GeoTIFF: {content[:200]!r}")
    return content, url


def _dem_sort_key(item: dict) -> tuple[str, str]:
    title = str(item.get("title") or "")
    dates = re.findall(r"\b(20\d{6})\b", title)
    updated = item.get("lastUpdated")
    if not updated and dates:
        updated = dates[-1]
    return (str(updated or ""), title)


def main() -> None:
    parser = argparse.ArgumentParser(description="Download source data for the grid pipeline")
    parser.add_argument("kind", choices=("buildings", "dem", "fbfm40"))
    parser.add_argument(
        "--layer", default="FA26", help="FBFM40 layer: FA26 (fall 2026), SU26, SP26, ES26, LF2025"
    )
    parser.add_argument(
        "--bbox", required=True, type=lambda value: tuple(map(float, value.split(",")))
    )
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if len(args.bbox) != 4:
        raise SystemExit("--bbox requires west,south,east,north")
    output = Path(args.output)
    if args.kind == "buildings":
        output.write_text(json.dumps(fetch_buildings(args.bbox)) + "\n")
    else:
        content, source_url = (
            fetch_dem(args.bbox) if args.kind == "dem" else fetch_fbfm40(args.bbox, args.layer)
        )
        output.write_bytes(content)
        output.with_suffix(output.suffix + ".source.json").write_text(
            json.dumps({"source": source_url}, indent=2) + "\n"
        )


if __name__ == "__main__":
    main()
