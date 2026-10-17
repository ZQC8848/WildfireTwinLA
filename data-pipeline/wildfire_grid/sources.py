import argparse
import json
import re
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
    last_error: Exception | None = None
    for url in OVERPASS_URLS:
        request = Request(
            url,
            data=urlencode({"data": query}).encode(),
            headers={"User-Agent": "WildfireTwinLA/0.1"},
        )
        try:
            with urlopen(request, timeout=180) as response:
                return overpass_to_geojson(json.load(response))
        except (HTTPError, URLError, TimeoutError) as error:
            last_error = error
    raise RuntimeError("all Overpass endpoints failed") from last_error


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


def _dem_sort_key(item: dict) -> tuple[str, str]:
    title = str(item.get("title") or "")
    dates = re.findall(r"\b(20\d{6})\b", title)
    updated = item.get("lastUpdated")
    if not updated and dates:
        updated = dates[-1]
    return (str(updated or ""), title)


def main() -> None:
    parser = argparse.ArgumentParser(description="Download source data for the grid pipeline")
    parser.add_argument("kind", choices=("buildings", "dem"))
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
        content, source_url = fetch_dem(args.bbox)
        output.write_bytes(content)
        output.with_suffix(output.suffix + ".source.json").write_text(
            json.dumps({"source": source_url}, indent=2) + "\n"
        )


if __name__ == "__main__":
    main()
