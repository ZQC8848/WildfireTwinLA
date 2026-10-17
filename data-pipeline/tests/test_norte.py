from pathlib import Path

from wildfire_grid.norte import build_events


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
