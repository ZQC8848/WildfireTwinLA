import asyncio

from fastapi import WebSocket

from .schemas import ServerMessage


class RealtimeHub:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()
        self._sequence = 0

    @property
    def sequence(self) -> int:
        return self._sequence

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._clients.add(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(websocket)

    async def broadcast(self, message_type: str, data: dict) -> None:
        async with self._lock:
            self._sequence += 1
            clients = tuple(self._clients)
            payload = ServerMessage(
                type=message_type, sequence=self._sequence, data=data
            ).model_dump_json()

        failed: list[WebSocket] = []
        for client in clients:
            try:
                await client.send_text(payload)
            except (OSError, RuntimeError):
                failed.append(client)
        if failed:
            async with self._lock:
                self._clients.difference_update(failed)
