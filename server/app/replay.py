import asyncio
import json
from pathlib import Path

from fastapi import WebSocket


def load_replay(path: str) -> list[dict]:
    replay_path = Path(path)
    if not replay_path.exists():
        raise FileNotFoundError(f"replay dataset not found: {replay_path}")
    events = [json.loads(line) for line in replay_path.read_text().splitlines() if line.strip()]
    return sorted(events, key=lambda event: float(event.get("offsetSeconds", 0)))


async def stream_replay(websocket: WebSocket, path: str, speed: float = 20) -> None:
    events = load_replay(path)
    previous = 0.0
    for event in events:
        offset = float(event.pop("offsetSeconds", 0))
        await asyncio.sleep(max(0, offset - previous) / max(speed, 0.1))
        await websocket.send_json(event)
        previous = offset
