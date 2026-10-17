from pathlib import Path

from wildfire_grid.norte import REPLAY_END, build_events


def test_norte_replay_uses_reports_north_first_wind_and_four_viirs_passes() -> None:
    raw_dir = Path(__file__).parents[2] / "data" / "norte" / "raw"
    events = build_events(raw_dir)
    assert events[0]["event"] == "norte"
    reports = [
        item
        for event in events
        if event["type"] == "hotspots"
        for item in event["items"]
        if item["source"] == "REPORT"
    ]
    assert [item["id"] for item in reports] == ["norte-report", "mirada-report"]
    winds = [event for event in events if event["type"] == "wind"]
    assert winds[0]["width"] == winds[0]["height"] == 5
    assert len(winds[0]["samples"]) == 25
    viirs = [
        event
        for event in events
        if event["type"] == "hotspots" and event["items"][0]["source"] == "VIIRS"
    ]
    assert [len(event["items"]) for event in viirs] == [15, 16, 18, 11]
    assert all(
        abs(item["lat"] - 33.4905) > 0.001 or abs(item["lon"] + 117.6185) > 0.001
        for event in viirs
        for item in event["items"]
    )
    orders = [event for event in events if event["type"] == "official_order"]
    assert {event["communityId"] for event in orders} == {
        "scl12",
        "scl13",
        "sjc04",
        "sjc05",
        "sjc10",
    }
    # No public issue time: the orders are flagged approximate rather than given a fake time
    assert all(event["timeApproximate"] and event["issuedAt"] is None for event in orders)
    assert all(item["satellite"] in {"N", "N20", "N21"} for event in viirs for item in event["items"])


def test_norte_replay_ends_when_the_fire_was_knocked_down() -> None:
    raw_dir = Path(__file__).parents[2] / "data" / "norte" / "raw"
    events = build_events(raw_dir)
    assert max(event["emittedAt"] for event in events) <= REPLAY_END.isoformat().replace("+00:00", "Z")
    winds = [event for event in events if event["type"] == "wind"]
    assert winds[0]["emittedAt"] == "2026-10-16T18:32:56Z"
    assert len(winds) == 8


def test_perimeter_is_the_last_event_and_keeps_its_label(tmp_path) -> None:
    raw_dir = Path(__file__).parents[2] / "data" / "norte" / "raw"
    perimeter = tmp_path / "perimeter.json"
    perimeter.write_text(
        '{"cells": [1, 2], "source": "VIIRS", "label": "Satellite-detected area", '
        '"official": false, "observedAt": "2026-10-16T21:48:00Z"}'
    )
    last = build_events(raw_dir, perimeter=perimeter)[-1]
    assert last["type"] == "incident"
    assert last["perimeterCells"] == [1, 2]
    assert last["perimeterOfficial"] is False
    assert last["perimeterLabel"] == "Satellite-detected area"
