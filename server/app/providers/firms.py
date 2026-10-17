import csv
import hashlib
import io
import logging
from datetime import UTC, datetime

import httpx

from ..schemas import Hotspot

FIRMS_BASE_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
DEFAULT_SOURCES = (
    "VIIRS_SNPP_NRT",
    "VIIRS_NOAA20_NRT",
    "VIIRS_NOAA21_NRT",
    "MODIS_NRT",
    "GOES_NRT",
)
logger = logging.getLogger(__name__)


def _confidence(value: str) -> float:
    normalized = value.strip().lower()
    if normalized in {"h", "high"}:
        return 0.9
    if normalized in {"n", "nominal"}:
        return 0.6
    if normalized in {"l", "low"}:
        return 0.3
    try:
        return max(0.0, min(1.0, float(normalized) / 100))
    except ValueError:
        return 0.5


def _source(product: str) -> str:
    if product.startswith("MODIS"):
        return "MODIS"
    if product.startswith("GOES"):
        return "GOES"
    return "VIIRS"


def parse_firms_csv(text: str, product: str) -> list[Hotspot]:
    hotspots: list[Hotspot] = []
    for row in csv.DictReader(io.StringIO(text)):
        if not row.get("latitude") or not row.get("longitude"):
            continue
        acquired_at = datetime.strptime(
            f"{row['acq_date']} {str(row.get('acq_time', '0')).zfill(4)}", "%Y-%m-%d %H%M"
        ).replace(tzinfo=UTC)
        identity = "|".join(
            (
                product,
                row.get("satellite", ""),
                acquired_at.isoformat(),
                f"{float(row['latitude']):.5f}",
                f"{float(row['longitude']):.5f}",
            )
        )
        hotspots.append(
            Hotspot(
                id=hashlib.sha256(identity.encode()).hexdigest()[:24],
                source=_source(product),
                satellite=row.get("satellite") or None,
                lat=float(row["latitude"]),
                lon=float(row["longitude"]),
                acquired_at=acquired_at,
                frp=max(0, float(row.get("frp") or 0)),
                confidence=_confidence(row.get("confidence", "")),
                raw=row,
            )
        )
    return hotspots


class FirmsProvider:
    def __init__(
        self,
        client: httpx.AsyncClient,
        map_key: str,
        bbox: tuple[float, float, float, float],
        sources: tuple[str, ...] = DEFAULT_SOURCES,
    ) -> None:
        self.client = client
        self.map_key = map_key
        self.bbox = bbox
        self.sources = sources

    async def fetch(self) -> list[Hotspot]:
        if not self.map_key:
            raise RuntimeError("WILDFIRE_FIRMS_MAP_KEY is not configured")
        area = ",".join(str(value) for value in self.bbox)
        results: list[Hotspot] = []
        successful_sources = 0
        last_error: Exception | None = None
        for source in self.sources:
            try:
                response = await self.client.get(
                    f"{FIRMS_BASE_URL}/{self.map_key}/{source}/{area}/1"
                )
                if response.status_code == 400 and source == "GOES_NRT":
                    logger.info("FIRMS GOES_NRT is unavailable for this key or area")
                    continue
                response.raise_for_status()
                results.extend(parse_firms_csv(response.text, source))
                successful_sources += 1
            except (httpx.HTTPError, ValueError) as error:
                last_error = error
                logger.warning("FIRMS source failed", extra={"source": source}, exc_info=True)
        if successful_sources == 0 and last_error is not None:
            raise RuntimeError("all FIRMS sources failed") from last_error
        return results
