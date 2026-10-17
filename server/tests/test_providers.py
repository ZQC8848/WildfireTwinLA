import asyncio

import httpx
import numpy as np
from netCDF4 import Dataset
from pyproj import CRS, Transformer

from app.providers.firms import FirmsProvider, is_static_heat_source, parse_firms_csv
from app.providers.goes import GoesProvider, decode_fdcc
from app.providers.official import parse_cap_feed
from app.providers.weather import sampling_grid


def test_firms_viirs_csv_is_normalized() -> None:
    payload = (
        "latitude,longitude,acq_date,acq_time,satellite,confidence,frp\n"
        "34.2,-118.1,2026-10-16,0815,N20,h,12.5\n"
    )
    result = parse_firms_csv(payload, "VIIRS_NOAA20_NRT")
    assert len(result) == 1
    assert result[0].source == "VIIRS"
    assert result[0].confidence == 0.9
    assert result[0].acquired_at.isoformat() == "2026-10-16T08:15:00+00:00"


def test_goes_s3_listing_selects_latest_object() -> None:
    listing = """<?xml version="1.0" encoding="UTF-8"?>
    <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
      <Contents><Key>ABI-L2-FDCC/2026/289/03/a.nc</Key></Contents>
      <Contents><Key>ABI-L2-FDCC/2026/289/03/b.nc</Key></Contents>
    </ListBucketResult>"""

    async def run() -> str:
        transport = httpx.MockTransport(lambda _: httpx.Response(200, text=listing))
        async with httpx.AsyncClient(transport=transport) as client:
            provider = GoesProvider(client, (-118.2, 34.17, -118.06, 34.27))
            return await provider.latest_key()

    assert asyncio.run(run()).endswith("b.nc")


def test_goes_fdcc_decoder_extracts_fire_pixel(tmp_path) -> None:
    path = tmp_path / "fdcc.nc"
    height = 35_786_023.0
    geos = CRS.from_proj4(
        f"+proj=geos +h={height} +lon_0=-137 +sweep=x +a=6378137 +b=6356752.31414 +units=m +no_defs"
    )
    to_geos = Transformer.from_crs("EPSG:4326", geos, always_xy=True)
    x_m, y_m = to_geos.transform(-118.1, 34.2)
    with Dataset(path, "w") as dataset:
        dataset.createDimension("x", 1)
        dataset.createDimension("y", 1)
        dataset.createVariable("x", "f4", ("x",))[:] = [x_m / height]
        dataset.createVariable("y", "f4", ("y",))[:] = [y_m / height]
        dataset.createVariable("Mask", "i2", ("y", "x"), fill_value=-99)[:] = np.array([[10]])
        dataset.createVariable("Power", "f4", ("y", "x"), fill_value=-1)[:] = np.array([[42.0]])
        projection = dataset.createVariable("goes_imager_projection", "i4")
        projection.perspective_point_height = height
        projection.longitude_of_projection_origin = -137.0
        projection.sweep_angle_axis = "x"
        projection.semi_major_axis = 6_378_137.0
        projection.semi_minor_axis = 6_356_752.31414
        dataset.time_coverage_start = "2026-10-16T03:00:00Z"

    result = decode_fdcc(path.read_bytes(), (-118.2, 34.17, -118.06, 34.27), object_key="x")
    assert len(result) == 1
    assert result[0].source == "GOES"
    assert result[0].frp == 42


def test_goes_product_maps_to_goes_source() -> None:
    payload = (
        "latitude,longitude,acq_date,acq_time,satellite,confidence,frp\n"
        "34.2,-118.1,2026-10-16,815,G18,80,4\n"
    )
    assert parse_firms_csv(payload, "GOES_NRT")[0].source == "GOES"


def test_weather_sampling_grid_is_five_by_five() -> None:
    points = sampling_grid((-118.2, 34.17, -118.06, 34.27))
    assert len(points) == 25
    assert points[0] == (34.27, -118.2)
    assert points[-1] == (34.17, -118.06)


def test_prima_deshecha_landfill_is_filtered() -> None:
    payload = (
        "latitude,longitude,acq_date,acq_time,satellite,confidence,frp\n"
        "33.4905,-117.6185,2026-10-16,0926,N,h,1.0\n"
    )
    hotspot = parse_firms_csv(payload, "VIIRS_SNPP_NRT")[0]
    assert is_static_heat_source(hotspot)


def test_cap_alert_is_normalized_as_official_order() -> None:
    payload = b"""<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
      <identifier>order-1</identifier><sender>county.example</sender>
      <sent>2026-10-16T20:00:00Z</sent><info>
      <event>Wildfire</event><headline>Evacuation Order for Altadena</headline>
      <expires>2026-10-17T00:00:00Z</expires><area><areaDesc>Altadena</areaDesc></area>
      </info></alert>"""
    order = parse_cap_feed(payload, "https://example.test/cap.xml")[0]
    assert order.level == "order"
    assert order.community_id == "altadena"
    assert order.source_url == "https://example.test/cap.xml"


def test_firms_keeps_working_when_one_source_fails() -> None:
    payload = (
        "latitude,longitude,acq_date,acq_time,satellite,confidence,frp\n"
        "34.2,-118.1,2026-10-16,0815,N20,h,12.5\n"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if "MODIS_NRT" in str(request.url):
            return httpx.Response(503)
        return httpx.Response(200, text=payload)

    async def run() -> list:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            provider = FirmsProvider(
                client,
                "test-key",
                (-118.2, 34.17, -118.06, 34.27),
                sources=("MODIS_NRT", "VIIRS_NOAA20_NRT"),
            )
            return await provider.fetch()

    result = asyncio.run(run())
    assert len(result) == 1
