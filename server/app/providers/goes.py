import hashlib
from datetime import UTC, datetime, timedelta
from xml.etree import ElementTree

import httpx
import numpy as np
from netCDF4 import Dataset
from pyproj import CRS, Transformer

from ..schemas import Hotspot

FIRE_CODES = set(range(10, 16)) | set(range(30, 36))


def _confidence(code: int) -> float:
    base = code - 20 if code >= 30 else code
    return {10: 0.98, 11: 0.98, 12: 0.75, 13: 0.75, 14: 0.55, 15: 0.3}[base]


def decode_fdcc(
    content: bytes,
    bbox: tuple[float, float, float, float],
    *,
    object_key: str,
) -> list[Hotspot]:
    with Dataset("in-memory.nc", memory=content) as dataset:
        mask = np.asarray(dataset.variables["Mask"][:].filled(-99))
        power_data = dataset.variables.get("Power")
        power = (
            np.asarray(power_data[:].filled(0)) if power_data is not None else np.zeros_like(mask)
        )
        x = np.asarray(dataset.variables["x"][:])
        y = np.asarray(dataset.variables["y"][:])
        projection = dataset.variables["goes_imager_projection"]
        height = float(projection.perspective_point_height)
        source_crs = CRS.from_proj4(
            "+proj=geos "
            f"+h={height} +lon_0={projection.longitude_of_projection_origin} "
            f"+sweep={projection.sweep_angle_axis} +a={projection.semi_major_axis} "
            f"+b={projection.semi_minor_axis} +units=m +no_defs"
        )
        transformer = Transformer.from_crs(source_crs, "EPSG:4326", always_xy=True)
        rows, columns = np.nonzero(np.isin(mask, tuple(FIRE_CODES)))
        if not len(rows):
            return []
        lon, lat = transformer.transform(x[columns] * height, y[rows] * height)
        observed_at = datetime.fromisoformat(
            str(dataset.getncattr("time_coverage_start"))
        ).astimezone(UTC)

    west, south, east, north = bbox
    hotspots: list[Hotspot] = []
    for row, column, item_lon, item_lat in zip(rows, columns, lon, lat, strict=True):
        if not np.isfinite(item_lon) or not np.isfinite(item_lat):
            continue
        if not (west <= item_lon <= east and south <= item_lat <= north):
            continue
        code = int(mask[row, column])
        identity = f"{object_key}|{row}|{column}"
        hotspots.append(
            Hotspot(
                id=hashlib.sha256(identity.encode()).hexdigest()[:24],
                source="GOES",
                satellite="GOES-18",
                lat=float(item_lat),
                lon=float(item_lon),
                acquired_at=observed_at,
                frp=max(0, float(power[row, column])),
                confidence=_confidence(code),
                raw={"object_key": object_key, "mask_code": code},
            )
        )
    return hotspots


class GoesProvider:
    def __init__(
        self,
        client: httpx.AsyncClient,
        bbox: tuple[float, float, float, float],
        satellite: str = "goes18",
    ) -> None:
        self.client = client
        self.bbox = bbox
        self.satellite = satellite

    async def latest_key(self, now: datetime | None = None) -> str:
        instant = (now or datetime.now(UTC)).astimezone(UTC)
        base = f"https://noaa-{self.satellite}.s3.amazonaws.com"
        for candidate in (instant, instant - timedelta(hours=1)):
            prefix = f"ABI-L2-FDCC/{candidate.year}/{candidate.timetuple().tm_yday:03d}/{candidate.hour:02d}/"
            response = await self.client.get(
                base, params={"list-type": "2", "prefix": prefix, "max-keys": "1000"}
            )
            response.raise_for_status()
            root = ElementTree.fromstring(response.content)
            keys = [node.text for node in root.findall(".//{*}Key") if node.text]
            if keys:
                return max(keys)
        raise RuntimeError("no recent GOES ABI-L2-FDCC object found")

    async def fetch(self) -> tuple[str, list[Hotspot]]:
        key = await self.latest_key()
        response = await self.client.get(f"https://noaa-{self.satellite}.s3.amazonaws.com/{key}")
        response.raise_for_status()
        return key, decode_fdcc(response.content, self.bbox, object_key=key)
