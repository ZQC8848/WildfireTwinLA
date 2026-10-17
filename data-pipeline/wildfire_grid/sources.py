import argparse
import json
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USGS_PRODUCTS_URL = "https://tnmaccess.nationalmap.gov/api/v1/products"


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
    query = f'[out:json][timeout:120];way["building"]({south},{west},{north},{east});out geom;'
    request = Request(
        OVERPASS_URL,
        data=urlencode({"data": query}).encode(),
        headers={"User-Agent": "WildfireTwinLA/0.1"},
    )
    with urlopen(request, timeout=180) as response:
        return overpass_to_geojson(json.load(response))


def fetch_dem(bbox: tuple[float, float, float, float]) -> tuple[bytes, str]:
    params = urlencode(
        {
            "datasets": "Digital Elevation Model (DEM) 1 meter",
            "bbox": ",".join(map(str, bbox)),
            "outputFormat": "JSON",
            "max": 1,
        }
    )
    with urlopen(f"{USGS_PRODUCTS_URL}?{params}", timeout=60) as response:
        payload = json.load(response)
    items = payload.get("items") or []
    if not items:
        raise RuntimeError("USGS returned no DEM product for the bounding box")
    url = items[0].get("downloadURL") or items[0].get("urls", {}).get("TIFF")
    if not url:
        raise RuntimeError("USGS DEM product has no downloadable GeoTIFF")
    with urlopen(url, timeout=300) as response:
        return response.read(), url


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
