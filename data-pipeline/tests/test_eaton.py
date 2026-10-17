from wildfire_grid.eaton import build_events


def test_eaton_perimeter_becomes_replay_cells() -> None:
    grid = {
        "width": 4,
        "height": 4,
        "cellSize": 1000,
        "crs": "EPSG:3857",
        "originUTM": [-2000, 2000],
    }
    payload = {
        "features": [
            {
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [[-0.01, 0.01], [0.01, 0.01], [0.01, -0.01], [-0.01, -0.01], [-0.01, 0.01]]
                    ],
                }
            }
        ]
    }
    events = build_events(grid, payload)
    assert events[0]["event"] == "eaton"
    assert events[1]["perimeterCells"]
