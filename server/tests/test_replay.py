import json

from app.replay import load_replay


def test_replay_events_are_ordered(tmp_path) -> None:
    path = tmp_path / "replay.jsonl"
    path.write_text(
        "\n".join(
            [
                json.dumps({"offsetSeconds": 2, "type": "incident"}),
                json.dumps({"offsetSeconds": 0, "type": "snapshot"}),
            ]
        )
    )
    assert [event["type"] for event in load_replay(str(path))] == ["snapshot", "incident"]


def test_replay_resumes_after_start_offset(tmp_path) -> None:
    import asyncio

    from app.replay import stream_replay

    path = tmp_path / "replay.jsonl"
    path.write_text(
        "\n".join(
            json.dumps({"offsetSeconds": o, "type": t})
            for o, t in [(0, "snapshot"), (1, "wind"), (2, "hotspots"), (3, "incident")]
        )
    )

    class Socket:
        def __init__(self) -> None:
            self.sent: list[dict] = []

        async def send_json(self, event: dict) -> None:
            self.sent.append(event)

    socket = Socket()
    asyncio.run(stream_replay(socket, str(path), speed=1000, start=1))
    assert [event["type"] for event in socket.sent] == ["hotspots", "incident"]
