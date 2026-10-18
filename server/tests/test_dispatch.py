import asyncio
import json

from app.dispatch import Dispatcher
from app.households import Household, generate_households, mask_address, mask_name, mask_phone


def _grid_dir(tmp_path):
    (tmp_path / "grid.json").write_text(json.dumps({"width": 64, "height": 64, "cellSize": 25}))
    buildings = [{"id": f"b{i}", "cell": 32 * 64 + i} for i in range(40)]
    (tmp_path / "buildings.json").write_text(json.dumps(buildings))
    # One named residential street along row 33 and one freeway along row 31
    roads = {
        "classes": ["motorway", "major", "minor", "street", "track"],
        "roads": [[3, 0, 33.0, 64, 33.0], [0, 0, 31.0, 64, 31.0]],
        "names": ["Via Test", "Pacific Coast Highway"],
    }
    (tmp_path / "roads.json").write_text(json.dumps(roads))
    communities = [{"id": "sjc04", "name": "Test", "cells": [32 * 64 + i for i in range(20)]}]
    (tmp_path / "communities.json").write_text(json.dumps(communities))
    return tmp_path


def test_households_are_reproducible_fictional_and_masked(tmp_path) -> None:
    grid = _grid_dir(tmp_path)
    first = generate_households(grid)
    assert first == generate_households(grid)
    assert len(first) == 40
    for h in first:
        # Only the NANP fiction range 555-0100 to 555-0199
        assert h.phone_e164.startswith("+194955501") and len(h.phone_e164) == 12
        # Homes are addressed on the residential street, never the freeway
        assert h.address.endswith("Via Test")
        public = h.public()
        assert h.owner not in json.dumps(public)
        assert h.phone_e164 not in json.dumps(public)
        assert public["address"].split()[0].endswith("*")
    assert first[0].city == "San Juan Capistrano"
    assert mask_name("Maria Garcia") == "Maria G*****"
    assert mask_phone("+19495550142") == "(949) 555-01**"
    assert mask_address("27341 Via la Mirada") == "27*** Via la Mirada"


def _household(i: int, x: float, vulnerable: bool = False) -> Household:
    return Household(
        id=f"hh-{i}",
        building_id=f"b{i}",
        cell=0,
        x=x,
        y=10.5,
        address=f"{100 + i} Via Test",
        city="San Juan Capistrano",
        zip="92675",
        owner=f"Test Owner{i}",
        phone_e164="+19495550100",
        language="en",
        vulnerable=vulnerable,
        community_id=None,
    )


def test_dispatcher_calls_nearest_first_and_texts_the_zone() -> None:
    # Fire at x = 10.5; homes 1, 3, 20 and 200 cells away (25 m cells)
    homes = [_household(0, 30.5), _household(1, 11.5), _household(2, 13.5), _household(3, 210.5)]
    events: list[tuple[str, dict]] = []

    async def broadcast(kind: str, data: dict) -> None:
        events.append((kind, data))

    async def scenario() -> None:
        d = Dispatcher(lambda: homes, broadcast, call_lines=1, demo_speed=1000, sms_per_second=100)
        await d.start()
        created = await d.update_fire([10 * 64 + 10], 64, wind_from_deg=270, wind_speed_ms=8)
        # Calls for the homes within the call zone, texts for all within 1.5 km
        channels = {(t.household.id, t.channel) for t in d.tasks.values()}
        assert ("hh-1", "call") in channels and ("hh-2", "call") in channels
        assert ("hh-3", "call") not in channels and ("hh-3", "text") not in channels
        assert created == len(channels)
        await asyncio.sleep(0.3)
        ringing = [
            e[1]["task"]["household"]["id"]
            for e in events
            if e[0] == "contact"
            and e[1]["task"]["channel"] == "call"
            and e[1]["task"]["status"] == "ringing"
        ]
        assert ringing[0] == "hh-1"  # nearest home first
        await d.stop()

    asyncio.run(scenario())


def test_unanswered_calls_retry_once_then_fall_back_to_text() -> None:
    homes = [_household(1, 11.5)]

    async def broadcast(kind: str, data: dict) -> None:
        return None

    async def scenario() -> None:
        d = Dispatcher(lambda: homes, broadcast, demo_speed=1000)
        await d.start()
        await d.update_fire([10 * 64 + 10], 64)
        call = d.tasks["call-hh-1"]
        await d._no_answer(call)
        assert call.attempt == 2 and call.status == "queued" and call.ready_at > 0
        await d._no_answer(call)
        assert call.status == "no_answer"
        await d.stop()

    asyncio.run(scenario())
