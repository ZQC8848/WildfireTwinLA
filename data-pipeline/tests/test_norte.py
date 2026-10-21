from pathlib import Path

from wildfire_grid.norte import FAST_FACTOR, NORTE_IGNITION, REPLAY_END, build_events

END = REPLAY_END.isoformat().replace("+00:00", "Z")


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
    orders = [
        event for event in events if event["type"] == "official_order" and event["level"] == "order"
    ]
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


def test_fire_inputs_stop_at_knockdown_and_later_days_only_bring_official_updates() -> None:
    raw_dir = Path(__file__).parents[2] / "data" / "norte" / "raw"
    events = build_events(raw_dir)
    winds = [event for event in events if event["type"] == "wind"]
    assert winds[0]["emittedAt"] == "2026-10-16T18:32:56Z"
    assert len(winds) == 8
    late = {event["type"] for event in events if event["emittedAt"] > END}
    assert late == {"suppression", "incident_status", "official_order"}
    assert all(event["emittedAt"] <= END for event in events if event["type"] in {"wind", "hotspots"})


def test_crews_hold_the_fire_and_a_quiet_satellite_pass_puts_it_out() -> None:
    raw_dir = Path(__file__).parents[2] / "data" / "norte" / "raw"
    events = build_events(raw_dir)
    hold, out = [event for event in events if event["type"] == "suppression"]
    # OCFA: most of the fire knocked down by 17:45 PDT, before day one ends
    assert hold["action"] == "hold" and hold["emittedAt"] == "2026-10-17T00:45:00Z"
    assert hold["timeApproximate"] and "5:45 p.m." in hold["quote"]
    # The first pass after it that imaged the area without any heat near the fire (NOAA-20, 02:26 PDT)
    assert out["action"] == "extinguish" and out["emittedAt"] == "2026-10-17T09:26:00Z"
    assert out["satellite"] == "N20"
    status = [event for event in events if event["type"] == "incident_status"]
    assert [event["containedPercent"] for event in status] == [None, 0, 5, 25, 50]
    lifted = {event["communityId"] for event in events if event.get("level") == "lifted"}
    assert lifted == {"scl12", "scl13", "sjc04", "sjc05", "sjc10"}


def test_replay_clock_is_declared_and_fast_after_day_one() -> None:
    raw_dir = Path(__file__).parents[2] / "data" / "norte" / "raw"
    events = build_events(raw_dir)
    clock = events[0]["clock"]
    assert clock["fastFactor"] == FAST_FACTOR
    assert clock["fastAfterMinutes"] == (REPLAY_END - NORTE_IGNITION).total_seconds() / 60
    by_time = {event["emittedAt"]: event["offsetSeconds"] for event in events}
    day_one = (REPLAY_END - NORTE_IGNITION).total_seconds() / 300
    # 10:20 PDT on 10-18 is 40 h 20 min after the end of day one
    assert abs(by_time["2026-10-18T17:20:00Z"] - (day_one + 2420 * 60 / 300 / FAST_FACTOR)) < 0.01


def test_day_one_perimeter_closes_day_one_and_keeps_its_label(tmp_path) -> None:
    raw_dir = Path(__file__).parents[2] / "data" / "norte" / "raw"
    perimeter = tmp_path / "perimeter.json"
    perimeter.write_text(
        '{"cells": [1, 2], "source": "VIIRS", "label": "Satellite-detected area", '
        '"official": false, "observedAt": "2026-10-16T21:48:00Z"}'
    )
    sent = [event for event in build_events(raw_dir, perimeter=perimeter) if "perimeterCells" in event]
    assert len(sent) == 1
    assert sent[0]["emittedAt"] == END
    assert sent[0]["perimeterCells"] == [1, 2]
    assert sent[0]["perimeterOfficial"] is False
    assert sent[0]["perimeterLabel"] == "Satellite-detected area"


def test_official_perimeter_arrives_when_it_was_mapped(tmp_path) -> None:
    raw_dir = Path(__file__).parents[2] / "data" / "norte" / "raw"
    official = tmp_path / "perimeter.json"
    official.write_text(
        '{"cells": [3], "source": "NIFC WFIGS", "label": "Official perimeter", '
        '"official": true, "observedAt": "2026-10-18T00:42:41+00:00"}'
    )
    viirs = tmp_path / "viirs.json"
    viirs.write_text(
        '{"cells": [1, 2], "source": "VIIRS", "label": "Satellite-detected area", '
        '"official": false, "observedAt": "2026-10-16T21:48:00Z"}'
    )
    sent = [
        event
        for event in build_events(raw_dir, perimeter=official, viirs_area=viirs)
        if "perimeterCells" in event
    ]
    assert [(event["emittedAt"], event["perimeterOfficial"]) for event in sent] == [
        (END, False),
        ("2026-10-18T00:42:41Z", True),
    ]
