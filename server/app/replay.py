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


async def stream_replay(
    websocket: WebSocket, path: str, speed: float = 20, start: float = 0
) -> None:
    """Send events paced by offsetSeconds / speed.

    A client that changes speed mid-replay reconnects with `start`, the offset of the last event
    it received; events at or before it are skipped.
    """
    events = load_replay(path)
    previous = start
    for event in events:
        offset = float(event.pop("offsetSeconds", 0))
        if start > 0 and offset <= start + 0.0005:
            continue
        await asyncio.sleep(max(0, offset - previous) / max(speed, 0.1))
        await websocket.send_json(event)
        previous = offset
