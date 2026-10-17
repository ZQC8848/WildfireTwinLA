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
