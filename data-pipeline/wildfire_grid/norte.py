import argparse
import csv
import hashlib
import json
import math
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from pathlib import Path

from rasterio.transform import Affine, rowcol
from rasterio.warp import transform

NORTE_BBOX = (-117.714, 33.427, -117.576, 33.543)
NORTE_IGNITION = datetime(2026, 10, 16, 18, 32, 56, tzinfo=UTC)
MIRADA_IGNITION = datetime(2026, 10, 16, 19, 19, 54, tzinfo=UTC)
LANDFILL = (33.4905, -117.6185)
# Day one ends at 18:00 PDT: the last VIIRS detection was 21:48Z, wind dropped below
# 4 m/s after 00:00Z and OCFA reported most of the fire knocked down by 17:45 PDT. Fire
# behaviour inputs (wind, hotspots) stop here. The replay then plays the official updates of
# the next days FAST_FACTOR times faster: containment, orders lifted, the NIFC perimeter. The
# knockdown stops the model spread, and the first satellite pass with no heat at the fire puts
# the model flames out, so the simulator never grows a fire that crews had already held.
REPLAY_END = datetime(2026, 10, 17, 1, 0, tzinfo=UTC)
FAST_FACTOR = 48
UPDATES_FILE = "calfire_updates_2026-10-18.json"
VIIRS_7D = "firms_viirs_*_7d_2026-10-18.csv"
SATELLITES = {"N": "S-NPP", "N20": "NOAA-20", "N21": "NOAA-21"}
# A pass is "quiet" when none of its detections lies within this distance of a day-one detection
QUIET_RADIUS_M = 2000
# No public source gives the issue time of the orders. News coverage shows them in place by
# about 12:30 PDT, so the events sit there and are flagged as approximate.
ORDER_TIME = datetime(2026, 10, 16, 19, 30, tzinfo=UTC)
ORDER_ZONES = ("SCL12", "SCL13", "SJC04", "SJC05", "SJC10")
ORDER_SOURCES = (
    "https://www.cbsnews.com/losangeles/news/norte-fire-san-clemente-orange-county-fire-authority/",
    "https://ktla.com/news/orange-county/norte-fire-threatening-structures-san-clemente/",
)


def _distance_m(lat_a: float, lon_a: float, lat_b: float, lon_b: float) -> float:
    radius = 6_371_000.0
    delta_lat = math.radians(lat_b - lat_a)
    delta_lon = math.radians(lon_b - lon_a)
    a = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(math.radians(lat_a))
        * math.cos(math.radians(lat_b))
        * math.sin(delta_lon / 2) ** 2
    )
    return 2 * radius * math.asin(math.sqrt(a))


def _offset(when: datetime) -> float:
    """Replay seconds: 1 s = 5 min of fire time on day one, FAST_FACTOR times faster after it."""
    seconds = (min(when, REPLAY_END) - NORTE_IGNITION).total_seconds() / 300
    if when > REPLAY_END:
        seconds += (when - REPLAY_END).total_seconds() / (300 * FAST_FACTOR)
    return round(seconds, 3)


def _iso(when: datetime) -> str:
    return when.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _pdt(value: str) -> datetime:
    return datetime.fromisoformat(value).astimezone(UTC)


def _confidence(value: str) -> float:
    return {"high": 0.9, "nominal": 0.6, "low": 0.3}.get(value.lower(), 0.5)


def _grid_cell(grid: dict | None, lon: float, lat: float) -> int:
    if grid is None:
        return -1
    xs, ys = transform("EPSG:4326", grid["crs"], [lon], [lat])
    cell_size = float(grid["cellSize"])
    affine = Affine(cell_size, 0, grid["originUTM"][0], 0, -cell_size, grid["originUTM"][1])
    row, column = rowcol(affine, xs[0], ys[0])
    if not (0 <= row < int(grid["height"]) and 0 <= column < int(grid["width"])):
        return -1
    return int(row) * int(grid["width"]) + int(column)


def _hotspot_item(
    *,
    item_id: str,
    lat: float,
    lon: float,
    when: datetime,
    source: str,
    confidence: float,
    frp: float,
    grid: dict | None,
    satellite: str | None = None,
) -> dict:
    item = {
        "id": item_id,
        "cell": _grid_cell(grid, lon, lat),
        "lon": lon,
        "lat": lat,
        "t": when.isoformat().replace("+00:00", "Z"),
        "frp": frp,
        "conf": confidence,
        "source": source,
    }
    if satellite:
        item["satellite"] = satellite
    return item


def _report_events(grid: dict | None) -> list[dict]:
    reports = (
        ("norte-report", "norte-2026", 33.479656, -117.634842, NORTE_IGNITION),
        ("mirada-report", "mirada-2026", 33.476987, -117.661362, MIRADA_IGNITION),
    )
    events: list[dict] = []
    for hotspot_id, incident_id, lat, lon, when in reports:
        emitted = when.isoformat().replace("+00:00", "Z")
        events.extend(
            [
                {
                    "offsetSeconds": _offset(when),
                    "type": "hotspots",
                    "emittedAt": emitted,
                    "items": [
                        _hotspot_item(
                            item_id=hotspot_id,
                            lat=lat,
                            lon=lon,
                            when=when,
                            source="REPORT",
                            confidence=1,
                            frp=0,
                            grid=grid,
                        )
                    ],
                },
                {
                    "offsetSeconds": _offset(when),
                    "type": "incident",
                    "emittedAt": emitted,
                    "id": incident_id,
                    "hotspotIds": [hotspot_id],
                    "centroid": [lon, lat],
                    "latestAt": emitted,
                },
            ]
        )
    return events


def _wind_events(path: Path) -> list[dict]:
    points = json.loads(path.read_text())["points"]
    times = points[0]["hourly"]["time"]
    events = []
    for index, raw_time in enumerate(times):
        when = datetime.fromisoformat(raw_time).replace(tzinfo=UTC)
        # The hour containing the ignition is sent at the ignition time
        if when + timedelta(hours=1) <= NORTE_IGNITION or when > REPLAY_END:
            continue
        when = max(when, NORTE_IGNITION)
        samples = [
            {
                "speedMs": point["hourly"]["wind_speed_10m"][index],
                "dirFromDeg": point["hourly"]["wind_direction_10m"][index] % 360,
            }
            for point in points
        ]
        events.append(
            {
                "offsetSeconds": _offset(when),
                "type": "wind",
                "emittedAt": when.isoformat().replace("+00:00", "Z"),
                "t": when.isoformat().replace("+00:00", "Z"),
                "width": 5,
                "height": 5,
                "samples": samples,
            }
        )
    return events


def _viirs_events(paths: list[Path], grid: dict | None) -> list[dict]:
    passes: dict[datetime, list[dict]] = defaultdict(list)
    seen: set[str] = set()
    west, south, east, north = NORTE_BBOX
    for path in paths:
        with path.open(newline="") as stream:
            for row in csv.DictReader(stream):
                lat = float(row["latitude"])
                lon = float(row["longitude"])
                when = datetime.strptime(
                    f"{row['acq_date']} {row['acq_time'].zfill(4)}", "%Y-%m-%d %H%M"
                ).replace(tzinfo=UTC)
                if (
                    when < NORTE_IGNITION
                    or when > REPLAY_END
                    or not (west <= lon <= east and south <= lat <= north)
                    or _distance_m(lat, lon, *LANDFILL) <= 750
                ):
                    continue
                identity = f"{row.get('satellite', '')}|{when.isoformat()}|{lat:.5f}|{lon:.5f}"
                item_id = hashlib.sha256(identity.encode()).hexdigest()[:24]
                if item_id in seen:
                    continue
                seen.add(item_id)
                passes[when].append(
                    _hotspot_item(
                        item_id=item_id,
                        lat=lat,
                        lon=lon,
                        when=when,
                        source="VIIRS",
                        confidence=_confidence(row.get("confidence", "")),
                        frp=max(0, float(row.get("frp") or 0)),
                        grid=grid,
                        satellite=row.get("satellite") or None,
                    )
                )
    return [
        {
            "offsetSeconds": _offset(when),
            "type": "hotspots",
            "emittedAt": when.isoformat().replace("+00:00", "Z"),
            "items": items,
        }
        for when, items in sorted(passes.items())
    ]


def _order_events() -> list[dict]:
    emitted = ORDER_TIME.isoformat().replace("+00:00", "Z")
    return [
        {
            "offsetSeconds": _offset(ORDER_TIME),
            "type": "official_order",
            "emittedAt": emitted,
            "id": f"norte-order-{zone.lower()}",
            "communityId": zone.lower(),
            "level": "order",
            "headline": (
                f"Evacuation order for {zone}. In place by early afternoon; "
                "the exact issue time was not published"
            ),
            "source": "Orange County Fire Authority, as reported by CBS Los Angeles and KTLA",
            "sourceUrl": ORDER_SOURCES[0],
            "sourceUrls": list(ORDER_SOURCES),
            "issuedAt": None,
            "timeApproximate": True,
            "expiresAt": None,
            "official": True,
        }
        for zone in ORDER_ZONES
    ]


def _viirs_rows(paths: list[Path]) -> list[tuple[datetime, str, float, float]]:
    rows = []
    for path in paths:
        with path.open(newline="") as stream:
            for row in csv.DictReader(stream):
                when = datetime.strptime(
                    f"{row['acq_date']} {row['acq_time'].zfill(4)}", "%Y-%m-%d %H%M"
                ).replace(tzinfo=UTC)
                rows.append(
                    (when, row["satellite"], float(row["latitude"]), float(row["longitude"]))
                )
    return rows


def _quiet_pass(raw_dir: Path, after: datetime) -> tuple[datetime, str] | None:
    """First satellite pass after `after` that saw the area but no heat near the fire.

    Only passes with at least one detection in the archived area are known to have happened, so a
    pass is evidence only if it detected something elsewhere and nothing within QUIET_RADIUS_M of
    a day-one detection.
    """
    rows = _viirs_rows(sorted(raw_dir.glob(VIIRS_7D)))
    west, south, east, north = NORTE_BBOX
    fire = [
        (lat, lon)
        for when, _, lat, lon in rows
        if NORTE_IGNITION <= when <= REPLAY_END
        and west <= lon <= east
        and south <= lat <= north
        and _distance_m(lat, lon, *LANDFILL) > 750
    ]
    passes: dict[tuple[datetime, str], list[tuple[float, float]]] = defaultdict(list)
    for when, satellite, lat, lon in rows:
        if when > after:
            passes[(when, satellite)].append((lat, lon))
    for key in sorted(passes):
        near = any(
            _distance_m(lat, lon, f_lat, f_lon) <= QUIET_RADIUS_M
            for lat, lon in passes[key]
            for f_lat, f_lon in fire
        )
        if fire and not near:
            return key
    return None


def _suppression_events(raw_dir: Path) -> list[dict]:
    path = raw_dir / UPDATES_FILE
    if not path.exists():
        return []
    knockdown = json.loads(path.read_text())["knockdown"]
    held = _pdt(knockdown["time"])
    events = [
        {
            "offsetSeconds": _offset(held),
            "type": "suppression",
            "emittedAt": _iso(held),
            "id": "norte-2026",
            "action": "hold",
            "headline": "Crews knocked down most of the fire",
            "quote": knockdown["quote"],
            "source": knockdown["source"],
            "sourceUrl": knockdown["url"],
            "timeApproximate": True,
        }
    ]
    quiet = _quiet_pass(raw_dir, held)
    if quiet:
        when, satellite = quiet
        name = SATELLITES.get(satellite, satellite)
        events.append(
            {
                "offsetSeconds": _offset(when),
                "type": "suppression",
                "emittedAt": _iso(when),
                "id": "norte-2026",
                "action": "extinguish",
                "headline": f"No heat detected at the fire in the VIIRS {name} pass",
                "source": "NASA FIRMS VIIRS NRT",
                "satellite": satellite,
            }
        )
    return events


def _update_events(raw_dir: Path) -> list[dict]:
    """CAL FIRE status (acres, containment) and evacuation orders lifted after day one."""
    path = raw_dir / UPDATES_FILE
    if not path.exists():
        return []
    data = json.loads(path.read_text())
    events = []
    for update in data["updates"]:
        posted = _pdt(update["time"])
        if update.get("acres") is not None or update.get("contained") is not None:
            events.append(
                {
                    "offsetSeconds": _offset(posted),
                    "type": "incident_status",
                    "emittedAt": _iso(posted),
                    "id": "norte-2026",
                    "acres": update.get("acres"),
                    "containedPercent": update.get("contained"),
                    "headline": update["quote"],
                    "source": data["source"],
                    "sourceUrl": data["url"],
                }
            )
        effective = _pdt(update.get("ordersEffective") or update["time"])
        for order in update.get("orders", []):
            zone = order["zone"]
            detail = order.get("detail") or update.get("closure")
            headline = f"Evacuation order {order['level']} for {zone}" + (
                f". {detail}" if detail else ""
            )
            events.append(
                {
                    "offsetSeconds": _offset(effective),
                    "type": "official_order",
                    "emittedAt": _iso(effective),
                    "id": f"norte-order-{zone.lower()}-{order['level'].replace(' ', '-')}",
                    "communityId": zone.lower(),
                    "level": order["level"],
                    "headline": headline,
                    "source": data["source"],
                    "sourceUrl": data["url"],
                    "sourceUrls": [data["url"]],
                    "issuedAt": _iso(posted),
                    "timeApproximate": False,
                    "expiresAt": None,
                    "official": True,
                }
            )
    return events


def _perimeter_event(path: Path | None) -> list[dict]:
    """Incident event carrying a perimeter from `wildfire-norte-perimeter`.

    Sent when it was observed, but no earlier than the end of day one: the VIIRS-detected area
    closes day one, and the NIFC perimeter arrives when it was mapped.
    """
    if not path or not path.exists():
        return []
    perimeter = json.loads(path.read_text())
    observed = perimeter.get("observedAt")
    at = max(REPLAY_END, _pdt(observed)) if observed else REPLAY_END
    emitted = _iso(at)
    return [
        {
            "offsetSeconds": _offset(at),
            "type": "incident",
            "emittedAt": emitted,
            "id": "norte-2026",
            "latestAt": emitted,
            "perimeterCells": perimeter["cells"],
            "perimeterSource": perimeter["source"],
            "perimeterLabel": perimeter["label"],
            "perimeterOfficial": perimeter["official"],
            "perimeterMethod": perimeter.get("method"),
            "observedAt": perimeter.get("observedAt"),
        }
    ]


def build_events(
    raw_dir: Path,
    grid: dict | None = None,
    perimeter: Path | None = None,
    viirs_area: Path | None = None,
) -> list[dict]:
    has_updates = (raw_dir / UPDATES_FILE).exists()
    events = [
        {
            "offsetSeconds": 0,
            "type": "snapshot",
            "emittedAt": NORTE_IGNITION.isoformat().replace("+00:00", "Z"),
            "mode": "replay",
            "event": "norte",
            "dataset": "public-nrt-2026-10-18" if has_updates else "public-nrt-2026-10-16",
            "incidents": [],
            "wind": None,
            # After day one the replay runs FAST_FACTOR times faster (see _offset)
            "clock": {
                "fastAfterMinutes": (REPLAY_END - NORTE_IGNITION).total_seconds() / 60,
                "fastFactor": FAST_FACTOR,
            },
        }
    ]
    events.extend(_report_events(grid))
    events.extend(_wind_events(raw_dir / "hrrr_5x5_2026-10-15_17.json"))
    events.extend(_viirs_events(sorted(raw_dir.glob("firms_viirs_*_48h_2026-10-17.csv")), grid))
    events.extend(_order_events())
    events.extend(_perimeter_event(viirs_area))
    events.extend(_perimeter_event(perimeter))
    events.extend(_suppression_events(raw_dir))
    events.extend(_update_events(raw_dir))
    priority = {
        "snapshot": 0,
        "wind": 1,
        "hotspots": 2,
        "suppression": 3,
        "incident": 4,
        "incident_status": 5,
        "official_order": 6,
    }
    events.sort(key=lambda event: (event["offsetSeconds"], priority[event["type"]]))
    for sequence, event in enumerate(events):
        event["sequence"] = sequence
    return events


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the archived Norte Fire replay")
    parser.add_argument("--raw-dir", default="../data/norte/raw")
    parser.add_argument("--grid", help="Optional grid.json used to populate hotspot cell IDs")
    parser.add_argument("--output", default="../server/data/norte-replay.jsonl")
    parser.add_argument(
        "--perimeter",
        default="../data/norte/perimeter.json",
        help="Output of wildfire-norte-perimeter; skipped when the file does not exist",
    )
    parser.add_argument(
        "--viirs-area",
        default="../data/norte/viirs-area.json",
        help="VIIRS-detected area from wildfire-norte-perimeter, sent at the end of day one",
    )
    args = parser.parse_args()
    grid = json.loads(Path(args.grid).read_text()) if args.grid else None
    events = build_events(Path(args.raw_dir), grid, Path(args.perimeter), Path(args.viirs_area))
    Path(args.output).write_text("\n".join(json.dumps(event) for event in events) + "\n")


if __name__ == "__main__":
    main()
