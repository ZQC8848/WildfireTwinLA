from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, status

from .config import get_settings
from .realtime import RealtimeHub
from .schemas import ResidentCreate, ResidentCreated
from .store import Store

settings = get_settings()
store = Store(settings.database_path)
hub = RealtimeHub()


@asynccontextmanager
async def lifespan(_: FastAPI):
    store.initialize()
    yield


app = FastAPI(title="WildfireTwinLA API", version="0.1.0", lifespan=lifespan)


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
    }


@app.post("/api/v1/residents", response_model=ResidentCreated, status_code=201)
def register_resident(resident: ResidentCreate) -> ResidentCreated:
    return store.create_resident(resident)


@app.delete("/api/v1/residents/{resident_id}", status_code=204)
def revoke_resident(resident_id: str) -> None:
    if not store.revoke_resident(resident_id):
        raise HTTPException(status_code=404, detail="resident not found or already revoked")


@app.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket, mode: str = "live", event: str | None = None
) -> None:
    if mode not in {"live", "replay"} or (mode == "replay" and event != "eaton"):
        await websocket.close(code=1008, reason="unsupported stream mode")
        return
    await hub.connect(websocket)
    await websocket.send_json(
        {"type": "snapshot", "sequence": 0, "data": {"mode": mode, "event": event}}
    )
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        await hub.disconnect(websocket)
