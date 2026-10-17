import json

from wildfire_grid.communities import build_communities


def test_community_polygons_are_exported_as_grid_cells(tmp_path) -> None:
    grid = tmp_path / "grid.json"
    source = tmp_path / "communities.geojson"
    grid.write_text(
        json.dumps(
            {
                "width": 4,
                "height": 4,
                "cellSize": 1000,
                "crs": "EPSG:3857",
                "originUTM": [-2000, 2000],
            }
        )
    )
    source.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "id": "altadena",
                        "properties": {"name": "Altadena"},
                        "geometry": {
                            "type": "Polygon",
                            "coordinates": [
                                [
                                    [-0.01, 0.01],
                                    [0.01, 0.01],
                                    [0.01, -0.01],
                                    [-0.01, -0.01],
                                    [-0.01, 0.01],
                                ]
                            ],
                        },
                    }
                ],
            }
        )
    )
    result = build_communities(str(grid), str(source))
    assert result[0]["id"] == "altadena"
    assert result[0]["name"] == "Altadena"
    assert result[0]["cells"]
