import numpy as np

from wildfire_grid.cli import footprint_ring
from wildfire_grid.damage import mark_buildings
from wildfire_grid.fuels import FUEL_BY_MODEL, apply_fbfm40
from wildfire_grid.perimeter import viirs_footprint_cells


def test_cured_grass_is_burnable_even_with_low_ndvi() -> None:
    # GR3 grass, NB1 developed (green yard), NB8 water, SH5 chaparral
    model = np.array([[103, 91, 98, 145]])
    ndvi_green = np.array([[False, True, False, True]])
    buildings = np.zeros((1, 4), dtype=bool)
    dryness = np.array([[0.0, 0.4, 0.0, 0.8]], dtype="float32")
    fuel, classes, dry = apply_fbfm40(model, ndvi_green, buildings, dryness)
    assert classes.tolist() == [[1, 0, 0, 1]]
    assert fuel[0, 0] == np.float32(FUEL_BY_MODEL[103])
    assert fuel[0, 3] > fuel[0, 0]
    # The grass cell had no NDMI; it gets the typical dryness of burnable cells
    assert dry[0, 0] > 0
    assert dry[0, 1] == dry[0, 2] == 0


def test_buildings_stay_buildings_and_missing_landfire_falls_back_to_ndvi() -> None:
    model = np.array([[103, 0, 0]])
    fuel, classes, _ = apply_fbfm40(
        model,
        np.array([[True, True, False]]),
        np.array([[True, False, False]]),
        np.full((1, 3), 0.5, dtype="float32"),
        ndvi_fuel=np.array([[0.7, 0.4, 0.0]], dtype="float32"),
    )
    assert classes.tolist() == [[2, 1, 0]]
    assert fuel.tolist()[0][:2] == [0.0, np.float32(0.4)]


def test_footprint_ring_matches_the_polygon_lon_lat_contract() -> None:
    polygon = {"type": "Polygon", "coordinates": [[[-117.1, 33.1], [-117.2, 33.1], [-117.1, 33.1]]]}
    assert footprint_ring(polygon) == [[-117.1, 33.1], [-117.2, 33.1], [-117.1, 33.1]]
    multi = {"type": "MultiPolygon", "coordinates": [polygon["coordinates"]]}
    assert footprint_ring(multi) == footprint_ring(polygon)


def test_damage_area_flags_buildings_near_the_street_only() -> None:
    street = [{"name": "Via de Agua", "coords": [(-117.660, 33.477), (-117.656, 33.477)]}]
    near = {"polygonLonLat": [[-117.658, 33.4772], [-117.6579, 33.4772], [-117.658, 33.4773]]}
    far = {"polygonLonLat": [[-117.658, 33.480], [-117.6579, 33.480], [-117.658, 33.4801]]}
    assert mark_buildings([near, far], street, 60) == 1
    assert near["reportedDamageArea"] is True
    assert "reportedDamageArea" not in far


def test_viirs_footprint_covers_the_pixel_box() -> None:
    meta = {
        "width": 64,
        "height": 64,
        "cellSize": 25.0,
        "crs": "EPSG:32611",
        "originUTM": [439000.0, 3705000.0],
    }
    pixel = {"lat": 33.4697, "lon": -117.6435, "scanKm": 0.4, "trackKm": 0.4}
    cells = viirs_footprint_cells(meta, [pixel])
    # A 400 m box is about 16 x 16 cells of 25 m
    assert 200 <= len(cells) <= 330
