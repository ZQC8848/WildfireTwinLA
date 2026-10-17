import re
from datetime import UTC, datetime
from xml.etree import ElementTree

import httpx

from ..schemas import OfficialOrderCreate


def _text(node: ElementTree.Element, name: str) -> str | None:
    child = node.find(f".//{{*}}{name}")
    return child.text.strip() if child is not None and child.text else None


def _datetime(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value).astimezone(UTC) if value else None


def parse_cap_feed(content: bytes, source_url: str) -> list[OfficialOrderCreate]:
    root = ElementTree.fromstring(content)
    alerts = [root] if root.tag.endswith("alert") else root.findall(".//{*}alert")
    orders: list[OfficialOrderCreate] = []
    for alert in alerts:
        identifier = _text(alert, "identifier")
        headline = _text(alert, "headline") or _text(alert, "event")
        area = _text(alert, "areaDesc")
        issued_at = _datetime(_text(alert, "sent") or _text(alert, "effective"))
        if not identifier or not headline or not area or not issued_at:
            continue
        normalized = f"{headline} {_text(alert, 'description') or ''}".lower()
        if "shelter" in normalized:
            level = "shelter"
        elif "evacuation order" in normalized or "evacuate now" in normalized:
            level = "order"
        else:
            level = "warning"
        community_id = re.sub(r"[^a-z0-9]+", "-", area.lower()).strip("-")
        orders.append(
            OfficialOrderCreate(
                id=identifier,
                community_id=community_id,
                level=level,
                headline=headline,
                source=_text(alert, "senderName") or _text(alert, "sender") or "CAP",
                source_url=source_url,
                issued_at=issued_at,
                expires_at=_datetime(_text(alert, "expires")),
            )
        )
    return orders


class OfficialOrderProvider:
    def __init__(self, client: httpx.AsyncClient, url: str) -> None:
        self.client = client
        self.url = url

    async def fetch(self) -> list[OfficialOrderCreate]:
        if not self.url:
            return []
        response = await self.client.get(self.url)
        response.raise_for_status()
        return parse_cap_feed(response.content, self.url)
