from wildfire_grid.sources import overpass_to_geojson


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
