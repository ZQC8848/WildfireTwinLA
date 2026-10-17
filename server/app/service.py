import asyncio
import hashlib
import logging
from contextlib import suppress

import httpx

from .alerts import evaluate_alert
from .clustering import cluster_hotspots, distance_m
from .config import Settings
from .contracts import hotspot_message, incident_message, official_order_message, wind_message
from .providers.firms import DEFAULT_SOURCES, FirmsProvider, is_static_heat_source
from .providers.goes import GoesProvider
from .providers.official import OfficialOrderProvider
from .providers.weather import WeatherProvider
from .realtime import RealtimeHub
from .retell import RetellGateway
from .schemas import AlertResult, ArrivalRisk, Hotspot, Incident
from .store import Store

logger = logging.getLogger(__name__)


class BackendService:
    def __init__(
        self,
        settings: Settings,
        store: Store,
        hub: RealtimeHub,
        client: httpx.AsyncClient,
        retell: RetellGateway,
    ) -> None:
        self.settings = settings
        self.store = store
        self.hub = hub
        firms_sources = (
            tuple(source for source in DEFAULT_SOURCES if source != "GOES_NRT")
            if settings.enable_direct_goes
            else DEFAULT_SOURCES
        )
        self.firms = FirmsProvider(
            client, settings.firms_map_key, settings.bbox, sources=firms_sources
        )
        self.weather = WeatherProvider(client, settings.bbox)
        self.goes = GoesProvider(client, settings.bbox, settings.goes_satellite)
        self.official = OfficialOrderProvider(client, settings.official_feed_url)
        self.retell = retell
        self.tasks: list[asyncio.Task] = []
        self.stopping = asyncio.Event()

    def start(self) -> None:
        if not self.settings.enable_pollers:
            return
        self.tasks = [
            asyncio.create_task(
                self._loop(self.poll_hotspots, self.settings.firms_poll_seconds),
                name="firms-poller",
            ),
            asyncio.create_task(
                self._loop(self.poll_weather, self.settings.weather_poll_seconds),
                name="weather-poller",
            ),
            asyncio.create_task(
                self._loop(self.cluster_incidents, self.settings.cluster_seconds),
                name="incident-clusterer",
            ),
        ]
        if self.settings.enable_direct_goes:
            self.tasks.append(
                asyncio.create_task(
                    self._loop(self.poll_goes, self.settings.goes_poll_seconds),
                    name="goes-poller",
                )
            )
        if self.settings.official_feed_url:
            self.tasks.append(
                asyncio.create_task(
                    self._loop(self.poll_official_orders, self.settings.official_poll_seconds),
                    name="official-order-poller",
                )
            )

    async def stop(self) -> None:
        self.stopping.set()
        for task in self.tasks:
            task.cancel()
        for task in self.tasks:
            with suppress(asyncio.CancelledError):
                await task

    async def _loop(self, action, interval: int) -> None:
        while not self.stopping.is_set():
            try:
                await action()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("background action failed", extra={"action": action.__name__})
            try:
                await asyncio.wait_for(self.stopping.wait(), timeout=interval)
            except TimeoutError:
                pass

    async def poll_hotspots(self) -> int:
        hotspots = [item for item in await self.firms.fetch() if not is_static_heat_source(item)]
        inserted = self.store.upsert_hotspots(hotspots)
        self.store.record_provider_success(
            "firms", metadata={"fetched": len(hotspots), "new": len(inserted)}
        )
        if inserted:
            await self.hub.broadcast(
                "hotspots",
                hotspot_message(
                    inserted,
                    self.settings.bbox,
                    self.settings.grid_width,
                    self.settings.grid_height,
                    self.settings.grid_crs,
                ),
            )
            await self.cluster_incidents()
        return len(inserted)

    async def poll_weather(self) -> None:
        snapshot = await self.weather.fetch()
        self.store.save_wind(snapshot)
        self.store.record_provider_success(
            "open-meteo", watermark=snapshot.observed_at.isoformat(), metadata={"points": 25}
        )
        await self.hub.broadcast("wind", wind_message(snapshot))

    async def poll_goes(self) -> int:
        object_key, hotspots = await self.goes.fetch()
        hotspots = [item for item in hotspots if not is_static_heat_source(item)]
        inserted = self.store.upsert_hotspots(hotspots)
        self.store.record_provider_success(
            "goes-abi-fdcc",
            watermark=object_key,
            metadata={"fetched": len(hotspots), "new": len(inserted)},
        )
        if inserted:
            await self.hub.broadcast(
                "hotspots",
                hotspot_message(
                    inserted,
                    self.settings.bbox,
                    self.settings.grid_width,
                    self.settings.grid_height,
                    self.settings.grid_crs,
                ),
            )
            await self.cluster_incidents()
        return len(inserted)

    async def poll_official_orders(self) -> int:
        orders = await self.official.fetch()
        changed = 0
        for order in orders:
            saved, was_changed = self.store.save_official_order(order)
            if was_changed:
                changed += 1
                await self.hub.broadcast("official_order", official_order_message(saved))
        self.store.record_provider_success(
            "official-orders", metadata={"fetched": len(orders), "changed": changed}
        )
        return changed

    async def cluster_incidents(self) -> list[Incident]:
        hotspots = self.store.recent_hotspots(hours=self.settings.incident_close_hours)
        existing = self.store.list_incidents(active_only=True)
        incidents: list[Incident] = []
        for cluster in cluster_hotspots(hotspots, min_samples=1):
            incident_id = self._match_incident(cluster, existing)
            incident = Incident(
                id=incident_id,
                hotspot_ids=[item.id for item in cluster],
                centroid_lat=sum(item.lat for item in cluster) / len(cluster),
                centroid_lon=sum(item.lon for item in cluster) / len(cluster),
                latest_at=max(item.acquired_at for item in cluster),
                hotspot_count=len(cluster),
            )
            self.store.upsert_incident(incident)
            incidents.append(incident)
        self.store.close_stale_incidents(self.settings.incident_close_hours)
        for incident in incidents:
            await self.hub.broadcast("incident", incident_message(incident))
        return incidents

    @staticmethod
    def _match_incident(cluster: list[Hotspot], existing: list[Incident]) -> str:
        ids = {item.id for item in cluster}
        for incident in existing:
            if ids.intersection(incident.hotspot_ids):
                return incident.id
        center = Hotspot(
            id="center",
            source="VIIRS",
            lat=sum(item.lat for item in cluster) / len(cluster),
            lon=sum(item.lon for item in cluster) / len(cluster),
            acquired_at=max(item.acquired_at for item in cluster),
            confidence=1,
        )
        candidates = [
            (
                distance_m(
                    center,
                    Hotspot(
                        id=incident.id,
                        source="VIIRS",
                        lat=incident.centroid_lat,
                        lon=incident.centroid_lon,
                        acquired_at=incident.latest_at,
                        confidence=1,
                    ),
                ),
                incident.id,
            )
            for incident in existing
        ]
        if candidates and min(candidates)[0] <= 1500:
            return min(candidates)[1]
        digest = hashlib.sha256("|".join(sorted(ids)).encode()).hexdigest()[:16]
        return f"fire-{digest}"

    async def process_risk(self, risk: ArrivalRisk) -> AlertResult:
        previous, below_count = self.store.alert_state(risk.incident_id, risk.community_id)
        decision = evaluate_alert(previous, risk, below_count)
        event_id = self.store.save_alert(risk, decision)
        calls_queued = 0
        if decision.changed:
            await self.hub.broadcast(
                "alert",
                {
                    "incidentId": risk.incident_id,
                    "communityId": risk.community_id,
                    "level": decision.current.name.lower(),
                    "etaMin": risk.eta_min,
                    "prediction": "non_official",
                },
            )
        if decision.should_call and event_id:
            calls_queued = await self._call_residents(event_id, risk, decision.current.name.lower())
        return AlertResult(
            community_id=risk.community_id,
            incident_id=risk.incident_id,
            previous=decision.previous,
            current=decision.current,
            changed=decision.changed,
            calls_queued=calls_queued,
            reason=decision.reason,
        )

    async def _call_residents(self, event_id: str, risk: ArrivalRisk, level: str) -> int:
        if not self.retell.configured:
            return 0
        queued = 0
        for resident in self.store.active_residents(risk.community_id):
            attempt_id = self.store.create_call_attempt(event_id, resident["id"])
            if not attempt_id:
                continue
            try:
                call_id = await self.retell.create_alert_call(
                    attempt_id=attempt_id,
                    resident=resident,
                    community_id=risk.community_id,
                    level=level,
                    eta_min=risk.eta_min,
                )
                self.store.update_call_attempt(
                    attempt_id=attempt_id,
                    retell_call_id=call_id,
                    status="queued",
                    details={},
                )
                queued += 1
            except Exception as error:
                self.store.update_call_attempt(
                    attempt_id=attempt_id,
                    status="failed",
                    details={"error": type(error).__name__},
                )
                logger.exception("Retell call creation failed", extra={"attempt_id": attempt_id})
        return queued
