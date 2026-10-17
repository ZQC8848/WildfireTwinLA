from datetime import datetime
from functools import lru_cache

from pyproj import Transformer

from .schemas import Hotspot, Incident, OfficialOrder, WindSnapshot


def lon_lat_to_cell(
    lon: float,
    lat: float,
    bbox: tuple[float, float, float, float],
    width: int,
    height: int,
    crs: str = "EPSG:32611",
) -> int:
    west, south, east, north = bbox
    transformer = _transformer(crs)
    left, bottom, right, top = transformer.transform_bounds(west, south, east, north)
    projected_x, projected_y = transformer.transform(lon, lat)
    column = min(width - 1, max(0, int((projected_x - left) / ((right - left) / width))))
    row = min(height - 1, max(0, int((top - projected_y) / ((top - bottom) / height))))
    return row * width + column


@lru_cache
def _transformer(crs: str) -> Transformer:
    return Transformer.from_crs("EPSG:4326", crs, always_xy=True)


def hotspot_message(
    hotspots: list[Hotspot],
    bbox: tuple[float, float, float, float],
    width: int,
    height: int,
    crs: str = "EPSG:32611",
) -> dict:
    return {
        "items": [
            {
                "id": item.id,
                "cell": lon_lat_to_cell(item.lon, item.lat, bbox, width, height, crs),
                "lon": item.lon,
                "lat": item.lat,
                "t": item.acquired_at.isoformat(),
                "frp": item.frp,
                "conf": item.confidence,
                "source": item.source,
            }
            for item in hotspots
        ]
    }


def incident_message(incident: Incident) -> dict:
    return {
        "id": incident.id,
        "hotspotIds": incident.hotspot_ids,
        "centroid": [incident.centroid_lon, incident.centroid_lat],
        "latestAt": incident.latest_at.isoformat(),
    }


def wind_message(snapshot: WindSnapshot) -> dict:
    return {
        "t": snapshot.observed_at.isoformat(),
        "grid5x5": [[point.speed_ms, point.direction_from_deg] for point in snapshot.points],
    }


def official_order_message(order: OfficialOrder) -> dict:
    return {
        "id": order.id,
        "communityId": order.community_id,
        "level": order.level,
        "headline": order.headline,
        "source": order.source,
        "sourceUrl": order.source_url,
        "issuedAt": order.issued_at.isoformat(),
        "expiresAt": order.expires_at.isoformat() if order.expires_at else None,
        "official": True,
    }


def envelope(message_type: str, sequence: int, data: dict, emitted_at: datetime) -> dict:
    return {
        "type": message_type,
        "sequence": sequence,
        "emittedAt": emitted_at.isoformat(),
        **data,
    }
