from datetime import UTC, datetime

import httpx

from ..schemas import WindPoint, WindSnapshot

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"


def sampling_grid(
    bbox: tuple[float, float, float, float], size: int = 5
) -> list[tuple[float, float]]:
    west, south, east, north = bbox
    return [
        (
            north - row * (north - south) / (size - 1),
            west + column * (east - west) / (size - 1),
        )
        for row in range(size)
        for column in range(size)
    ]


class WeatherProvider:
    def __init__(self, client: httpx.AsyncClient, bbox: tuple[float, float, float, float]) -> None:
        self.client = client
        self.coordinates = sampling_grid(bbox)

    async def fetch(self) -> WindSnapshot:
        response = await self.client.get(
            OPEN_METEO_URL,
            params={
                "latitude": ",".join(str(lat) for lat, _ in self.coordinates),
                "longitude": ",".join(str(lon) for _, lon in self.coordinates),
                "current": (
                    "wind_speed_10m,wind_direction_10m,wind_gusts_10m,relative_humidity_2m"
                ),
                "wind_speed_unit": "ms",
                "timezone": "UTC",
            },
        )
        response.raise_for_status()
        payload = response.json()
        rows = payload if isinstance(payload, list) else [payload]
        points: list[WindPoint] = []
        observed: list[datetime] = []
        for (lat, lon), row in zip(self.coordinates, rows, strict=True):
            current = row["current"]
            observed_at = datetime.fromisoformat(current["time"])
            if observed_at.tzinfo is None:
                observed_at = observed_at.replace(tzinfo=UTC)
            else:
                observed_at = observed_at.astimezone(UTC)
            observed.append(observed_at)
            points.append(
                WindPoint(
                    lat=lat,
                    lon=lon,
                    speed_ms=current["wind_speed_10m"],
                    direction_from_deg=current["wind_direction_10m"] % 360,
                    gust_ms=current["wind_gusts_10m"],
                    relative_humidity=current["relative_humidity_2m"],
                )
            )
        return WindSnapshot(observed_at=max(observed), points=points)
