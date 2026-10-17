import asyncio

import httpx

from app.providers.firms import FirmsProvider, parse_firms_csv
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


def test_goes_product_maps_to_goes_source() -> None:
    payload = (
        "latitude,longitude,acq_date,acq_time,satellite,confidence,frp\n"
        "34.2,-118.1,2026-10-16,815,G18,80,4\n"
    )
    assert parse_firms_csv(payload, "GOES_NRT")[0].source == "GOES"


def test_weather_sampling_grid_is_five_by_five() -> None:
    points = sampling_grid((-118.2, 34.17, -118.06, 34.27))
    assert len(points) == 25
    assert points[0] == (34.17, -118.2)
    assert points[-1] == (34.27, -118.06)


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
