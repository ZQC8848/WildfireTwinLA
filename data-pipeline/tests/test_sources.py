from wildfire_grid.sources import USGS_DEM_DATASET, _dem_sort_key, overpass_to_geojson


def test_overpass_building_ways_become_geojson_polygons() -> None:
    result = overpass_to_geojson(
        {
            "elements": [
                {
                    "type": "way",
                    "id": 10,
                    "tags": {"building": "yes"},
                    "geometry": [
                        {"lon": -118.1, "lat": 34.2},
                        {"lon": -118.09, "lat": 34.2},
                        {"lon": -118.09, "lat": 34.19},
                        {"lon": -118.1, "lat": 34.2},
                    ],
                }
            ]
        }
    )
    feature = result["features"][0]
    assert feature["id"] == "osm-way-10"
    assert feature["geometry"]["type"] == "Polygon"


def test_dem_source_is_seamless_one_third_arc_second() -> None:
    assert USGS_DEM_DATASET == "National Elevation Dataset (NED) 1/3 arc-second"
    products = [
        {"title": "USGS 1/3 Arc Second n34w118 20120201"},
        {"title": "USGS 1/3 Arc Second n34w118 20260915"},
    ]
    assert max(products, key=_dem_sort_key)["title"].endswith("20260915")
