import asyncio
import json
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from uuid import uuid4

import httpx
from fastapi import (
    FastAPI,
    Header,
    HTTPException,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .contracts import official_order_message, wind_message
from .dispatch import ContactTask, Dispatcher
from .households import generate_households
from .realtime import RealtimeHub
from .replay import stream_replay
from .retell import RetellGateway, webhook_status
from .schemas import (
    AlertResult,
    ArrivalRisk,
    DispatchFire,
    DispatchStart,
    Incident,
    OfficialOrder,
    OfficialOrderCreate,
    ResidentCreate,
    ResidentCreated,
    RetellWebhookEvent,
    WindSnapshot,
)
from .service import BackendService
from .store import Store

settings = get_settings()
store = Store(settings.database_path)
hub = RealtimeHub()
retell = RetellGateway(
    settings.retell_api_key, settings.retell_from_number, settings.retell_agent_id
)
service: BackendService | None = None
dispatch_hub = RealtimeHub()


async def real_call(task: ContactTask) -> str | None:
    """Call through Retell only for a building with a consented, registered resident."""
    resident = store.resident_for_building(task.household.building_id)
    if not resident or not retell.configured:
        return None
    return await retell.create_alert_call(
        attempt_id=task.id,
        resident=resident,
        community_id=task.household.community_id or resident["community_id"],
        level="imminent" if task.eta_min <= 30 else "warning",
        eta_min=task.eta_min,
    )


dispatcher = Dispatcher(
    lambda: generate_households(settings.grid_dir),
    dispatch_hub.broadcast,
    call_lines=settings.dispatch_call_lines,
    sms_per_second=settings.dispatch_sms_per_second,
    demo_speed=settings.dispatch_demo_speed,
    real_caller=real_call if settings.dispatch_real_calls else None,
)
registration_attempts: dict[str, deque[float]] = defaultdict(deque)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global service
    store.initialize()
    client = httpx.AsyncClient(
        timeout=settings.request_timeout_seconds,
        transport=httpx.AsyncHTTPTransport(retries=2),
    )
    service = BackendService(settings, store, hub, client, retell)
    service.start()
    preload = asyncio.create_task(dispatcher.preload())
    try:
        yield
    finally:
        preload.cancel()
        await service.stop()
        await dispatcher.stop()
        await client.aclose()


app = FastAPI(title="WildfireTwinLA API", version="0.3.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type", "X-Revocation-Token"],
)


@app.middleware("http")
async def security_middleware(request: Request, call_next):
    request_id = request.headers.get("X-Request-ID") or str(uuid4())
    if request.method == "POST" and request.url.path == "/api/v1/residents":
        key = request.client.host if request.client else "unknown"
        now = time.monotonic()
        attempts = registration_attempts[key]
        while attempts and attempts[0] < now - 60:
            attempts.popleft()
        if len(attempts) >= settings.registration_rate_limit:
            return Response(status_code=429, content="registration rate limit exceeded")
        attempts.append(now)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Request-ID"] = request_id
    return response


def require_internal_key(value: str | None) -> None:
    if settings.internal_api_key and value != settings.internal_api_key:
        raise HTTPException(status_code=401, detail="invalid internal key")


@app.get("/healthz")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/readyz")
def readiness() -> dict:
    if not store.ready():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="database")
    return {
        "status": "ready",
        "pollers_enabled": settings.enable_pollers,
        "providers": store.provider_status(),
        "retell_configured": retell.configured,
    }


@app.get("/metrics")
def metrics() -> Response:
    values = store.metrics()
    values["websocket_clients"] = hub.client_count
    body = "\n".join(f"wildfire_{name} {value}" for name, value in sorted(values.items())) + "\n"
    return Response(content=body, media_type="text/plain; version=0.0.4")


@app.get("/api/v1/incidents", response_model=list[Incident])
def incidents(active: bool = True) -> list[Incident]:
    return store.list_incidents(active_only=active)


@app.get("/api/v1/incidents/{incident_id}")
def incident(incident_id: str) -> dict:
    result = store.get_incident(incident_id)
    if result is None:
        raise HTTPException(status_code=404, detail="incident not found")
    item, hotspots = result
    return {
        "incident": item.model_dump(mode="json"),
        "hotspots": [hotspot.model_dump(mode="json") for hotspot in hotspots],
    }


@app.get("/api/v1/wind/latest", response_model=WindSnapshot)
def latest_wind() -> WindSnapshot:
    snapshot = store.latest_wind()
    if snapshot is None:
        raise HTTPException(status_code=404, detail="wind data not available")
    return snapshot


@app.post("/api/v1/residents", response_model=ResidentCreated, status_code=201)
def register_resident(resident: ResidentCreate) -> ResidentCreated:
    return store.create_resident(resident)


@app.delete("/api/v1/residents/{resident_id}", status_code=204)
def revoke_resident(
    resident_id: str, x_revocation_token: str | None = Header(default=None)
) -> None:
    if not x_revocation_token or not store.revoke_resident(resident_id, x_revocation_token):
        raise HTTPException(status_code=404, detail="resident not found, token invalid, or revoked")


@app.post("/api/v1/risks/evaluate", response_model=AlertResult)
async def evaluate_risk(
    risk: ArrivalRisk, x_internal_key: str | None = Header(default=None)
) -> AlertResult:
    require_internal_key(x_internal_key)
    if service is None:
        raise HTTPException(status_code=503, detail="service not ready")
    return await service.process_risk(risk)


@app.post("/api/v1/risks/evaluate-batch", response_model=list[AlertResult])
async def evaluate_risk_batch(
    risks: list[ArrivalRisk], x_internal_key: str | None = Header(default=None)
) -> list[AlertResult]:
    require_internal_key(x_internal_key)
    if service is None:
        raise HTTPException(status_code=503, detail="service not ready")
    return [await service.process_risk(risk) for risk in risks]


@app.get("/api/v1/official-orders", response_model=list[OfficialOrder])
def official_orders(community_id: str | None = None) -> list[OfficialOrder]:
    return store.active_official_orders(community_id)


@app.post("/api/v1/official-orders", response_model=OfficialOrder)
async def ingest_official_order(
    order: OfficialOrderCreate, x_internal_key: str | None = Header(default=None)
) -> OfficialOrder:
    require_internal_key(x_internal_key)
    saved, changed = store.save_official_order(order)
    if changed:
        await hub.broadcast("official_order", official_order_message(saved))
    return saved


@app.post("/api/v1/dispatch/start")
async def dispatch_start(body: DispatchStart) -> dict:
    """Start the emergency contact pipeline (idempotent)."""
    return await dispatcher.start(body.demo_speed, body.call_lines)


@app.post("/api/v1/dispatch/stop", status_code=204)
async def dispatch_stop() -> Response:
    await dispatcher.stop()
    return Response(status_code=204)


@app.post("/api/v1/dispatch/fire")
async def dispatch_fire(body: DispatchFire) -> dict:
    """Fire cells and optional model arrival times from the simulator; reprioritizes the queues."""
    created = await dispatcher.update_fire(
        body.cells, settings.grid_width, body.etas, body.wind_from_deg, body.wind_speed_ms
    )
    return {"created": created, **dispatcher.summary()}


@app.get("/api/v1/dispatch/state")
def dispatch_state() -> dict:
    return dispatcher.snapshot()


@app.websocket("/ws/dispatch")
async def dispatch_socket(websocket: WebSocket) -> None:
    await dispatch_hub.connect(websocket)
    await websocket.send_json({"type": "dispatch_snapshot", **dispatcher.snapshot()})
    try:
        while True:
            if await websocket.receive_text() == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        await dispatch_hub.disconnect(websocket)


@app.post("/webhooks/retell", status_code=204)
async def retell_webhook(
    request: Request, x_retell_signature: str | None = Header(default=None)
) -> Response:
    body = await request.body()
    if not x_retell_signature or not retell.verify_webhook(body, x_retell_signature):
        raise HTTPException(status_code=401, detail="invalid Retell signature")
    payload = RetellWebhookEvent.model_validate(json.loads(body))
    call_id = payload.call.get("call_id")
    metadata = payload.call.get("metadata") or {}
    call_status = webhook_status(payload.event, payload.call)
    updated = store.update_call_attempt(
        retell_call_id=call_id, status=call_status, details=payload.call
    )
    if not updated and metadata.get("attempt_id"):
        store.update_call_attempt(
            attempt_id=str(metadata["attempt_id"]),
            retell_call_id=call_id,
            status=call_status,
            details=payload.call,
        )
    if metadata.get("attempt_id"):
        await dispatcher.on_provider_status(str(metadata["attempt_id"]), call_status)
    await hub.broadcast(
        "call_status",
        {
            "buildingId": metadata.get("building_id"),
            "status": call_status,
        },
    )
    return Response(status_code=204)


@app.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    mode: str = "live",
    event: str | None = None,
    speed: float = 20,
    start: float = 0,
) -> None:
    replay_event = event or "norte"
    if mode not in {"live", "replay"} or (
        mode == "replay" and replay_event not in {"norte", "eaton"}
    ):
        await websocket.close(code=1008, reason="unsupported stream mode")
        return
    if mode == "replay":
        await websocket.accept()
        replay_path = (
            settings.replay_path if replay_event == "norte" else settings.eaton_replay_path
        )
        try:
            await stream_replay(websocket, replay_path, speed, max(0.0, start))
        except FileNotFoundError:
            await websocket.send_json({"type": "error", "detail": "replay dataset unavailable"})
        finally:
            await websocket.close()
        return
    await hub.connect(websocket)
    wind = store.latest_wind()
    await websocket.send_json(
        {
            "type": "snapshot",
            "sequence": hub.sequence,
            "emittedAt": datetime.now(UTC).isoformat(),
            "mode": mode,
            "event": event,
            "incidents": [item.model_dump(mode="json") for item in store.list_incidents()],
            "wind": wind_message(wind) if wind else None,
            "officialOrders": [
                official_order_message(order) for order in store.active_official_orders()
            ],
        }
    )
    try:
        while True:
            message = await websocket.receive_text()
            if message == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        await hub.disconnect(websocket)
