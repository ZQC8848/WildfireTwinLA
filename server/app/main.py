import json
from contextlib import asynccontextmanager

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

from .config import get_settings
from .realtime import RealtimeHub
from .retell import RetellGateway, webhook_status
from .schemas import (
    AlertResult,
    ArrivalRisk,
    Incident,
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
    try:
        yield
    finally:
        await service.stop()
        await client.aclose()


app = FastAPI(title="WildfireTwinLA API", version="0.2.0", lifespan=lifespan)


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
def revoke_resident(resident_id: str) -> None:
    if not store.revoke_resident(resident_id):
        raise HTTPException(status_code=404, detail="resident not found or already revoked")


@app.post("/api/v1/risks/evaluate", response_model=AlertResult)
async def evaluate_risk(
    risk: ArrivalRisk, x_internal_key: str | None = Header(default=None)
) -> AlertResult:
    if settings.internal_api_key and x_internal_key != settings.internal_api_key:
        raise HTTPException(status_code=401, detail="invalid internal key")
    if service is None:
        raise HTTPException(status_code=503, detail="service not ready")
    return await service.process_risk(risk)


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
    websocket: WebSocket, mode: str = "live", event: str | None = None
) -> None:
    if mode not in {"live", "replay"} or (mode == "replay" and event != "eaton"):
        await websocket.close(code=1008, reason="unsupported stream mode")
        return
    await hub.connect(websocket)
    wind = store.latest_wind()
    await websocket.send_json(
        {
            "type": "snapshot",
            "sequence": hub.sequence,
            "data": {
                "mode": mode,
                "event": event,
                "incidents": [item.model_dump(mode="json") for item in store.list_incidents()],
                "wind": wind.model_dump(mode="json") if wind else None,
            },
        }
    )
    try:
        while True:
            message = await websocket.receive_text()
            if message == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        await hub.disconnect(websocket)
