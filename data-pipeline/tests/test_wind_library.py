import numpy as np

from wildfire_grid.wind_library import resize_bilinear, wind_components


def test_north_wind_points_south_and_resize_preserves_corners() -> None:
    speed = np.full((2, 2), 5.0)
    direction = np.zeros((2, 2))
    east, north = wind_components(speed, direction)
    assert np.allclose(east, 0)
    assert np.allclose(north, -5)
    resized = resize_bilinear(np.array([[1.0, 2.0], [3.0, 4.0]]), 4)
    assert resized.shape == (4, 4)
    assert resized[0, 0] == 1
    assert resized[-1, -1] == 4
