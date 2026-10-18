import hashlib
import json
import secrets
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from .alerts import AlertDecision
from .schemas import (
    AlertLevel,
    ArrivalRisk,
    Hotspot,
    Incident,
    OfficialOrder,
    OfficialOrderCreate,
    ResidentCreate,
    ResidentCreated,
    WindSnapshot,
)


class Store:
    def __init__(self, database_path: str) -> None:
        self.path = Path(database_path)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS hotspots (
                    id TEXT PRIMARY KEY,
                    source TEXT NOT NULL,
                    satellite TEXT,
                    lat REAL NOT NULL,
                    lon REAL NOT NULL,
                    acquired_at TEXT NOT NULL,
                    frp REAL NOT NULL,
                    confidence REAL NOT NULL,
                    raw_json TEXT NOT NULL,
                    inserted_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS hotspots_time_idx ON hotspots(acquired_at);
                CREATE TABLE IF NOT EXISTS incidents (
                    id TEXT PRIMARY KEY,
                    centroid_lat REAL NOT NULL,
                    centroid_lon REAL NOT NULL,
                    latest_at TEXT NOT NULL,
                    status TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS incident_hotspots (
                    incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
                    hotspot_id TEXT NOT NULL REFERENCES hotspots(id) ON DELETE CASCADE,
                    PRIMARY KEY (incident_id, hotspot_id)
                );
                CREATE TABLE IF NOT EXISTS wind_snapshots (
                    observed_at TEXT PRIMARY KEY,
                    points_json TEXT NOT NULL,
                    inserted_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS residents (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    phone_e164 TEXT NOT NULL,
                    language TEXT NOT NULL,
                    address TEXT NOT NULL,
                    community_id TEXT NOT NULL,
                    building_id TEXT,
                    cell INTEGER,
                    vulnerable INTEGER NOT NULL,
                    consent_at TEXT NOT NULL,
                    consent_source TEXT NOT NULL,
                    revoke_token_hash TEXT,
                    revoked_at TEXT
                );
                CREATE INDEX IF NOT EXISTS resident_community_idx
                    ON residents(community_id, revoked_at);
                CREATE TABLE IF NOT EXISTS alerts (
                    incident_id TEXT NOT NULL,
                    community_id TEXT NOT NULL,
                    level INTEGER NOT NULL,
                    eta_min REAL NOT NULL,
                    probability_1h REAL NOT NULL,
                    probability_3h REAL NOT NULL,
                    probability_6h REAL NOT NULL,
                    below_count INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (incident_id, community_id)
                );
                CREATE TABLE IF NOT EXISTS alert_events (
                    id TEXT PRIMARY KEY,
                    incident_id TEXT NOT NULL,
                    community_id TEXT NOT NULL,
                    previous_level INTEGER NOT NULL,
                    current_level INTEGER NOT NULL,
                    reason TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS call_attempts (
                    id TEXT PRIMARY KEY,
                    alert_event_id TEXT NOT NULL REFERENCES alert_events(id),
                    resident_id TEXT NOT NULL REFERENCES residents(id),
                    retell_call_id TEXT,
                    status TEXT NOT NULL,
                    details_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(alert_event_id, resident_id)
                );
                CREATE TABLE IF NOT EXISTS provider_state (
                    provider TEXT PRIMARY KEY,
                    watermark TEXT,
                    last_success_at TEXT,
                    metadata_json TEXT NOT NULL DEFAULT '{}'
                );
                CREATE TABLE IF NOT EXISTS official_orders (
                    id TEXT PRIMARY KEY,
                    community_id TEXT NOT NULL,
                    level TEXT NOT NULL,
                    headline TEXT NOT NULL,
                    source TEXT NOT NULL,
                    source_url TEXT,
                    issued_at TEXT NOT NULL,
                    expires_at TEXT,
                    received_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS official_order_community_idx
                    ON official_orders(community_id, issued_at);
                """
            )
            resident_columns = {
                row["name"] for row in connection.execute("PRAGMA table_info(residents)")
            }
            if "revoke_token_hash" not in resident_columns:
                connection.execute("ALTER TABLE residents ADD COLUMN revoke_token_hash TEXT")

    def ready(self) -> bool:
        try:
            with self.connect() as connection:
                connection.execute("SELECT 1").fetchone()
            return True
        except sqlite3.Error:
            return False

    def record_provider_success(
        self, provider: str, *, watermark: str | None = None, metadata: dict | None = None
    ) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO provider_state(provider, watermark, last_success_at, metadata_json)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(provider) DO UPDATE SET
                  watermark=excluded.watermark,
                  last_success_at=excluded.last_success_at,
                  metadata_json=excluded.metadata_json
                """,
                (provider, watermark, datetime.now(UTC).isoformat(), json.dumps(metadata or {})),
            )

    def upsert_hotspots(self, hotspots: list[Hotspot]) -> list[Hotspot]:
        inserted: list[Hotspot] = []
        now = datetime.now(UTC).isoformat()
        with self.connect() as connection:
            for item in hotspots:
                result = connection.execute(
                    """
                    INSERT OR IGNORE INTO hotspots(
                      id, source, satellite, lat, lon, acquired_at, frp,
                      confidence, raw_json, inserted_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        item.id,
                        item.source,
                        item.satellite,
                        item.lat,
                        item.lon,
                        item.acquired_at.isoformat(),
                        item.frp,
                        item.confidence,
                        json.dumps(item.raw),
                        now,
                    ),
                )
                if result.rowcount:
                    inserted.append(item)
        return inserted

    def recent_hotspots(self, hours: int = 24) -> list[Hotspot]:
        cutoff = (datetime.now(UTC) - timedelta(hours=hours)).isoformat()
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM hotspots WHERE acquired_at >= ? ORDER BY acquired_at", (cutoff,)
            ).fetchall()
        return [self._hotspot(row) for row in rows]

    def upsert_incident(self, incident: Incident) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO incidents(id, centroid_lat, centroid_lon, latest_at, status, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  centroid_lat=excluded.centroid_lat, centroid_lon=excluded.centroid_lon,
                  latest_at=excluded.latest_at, status=excluded.status,
                  updated_at=excluded.updated_at
                """,
                (
                    incident.id,
                    incident.centroid_lat,
                    incident.centroid_lon,
                    incident.latest_at.isoformat(),
                    incident.status,
                    datetime.now(UTC).isoformat(),
                ),
            )
            connection.executemany(
                "INSERT OR IGNORE INTO incident_hotspots(incident_id, hotspot_id) VALUES (?, ?)",
                [(incident.id, hotspot_id) for hotspot_id in incident.hotspot_ids],
            )

    def close_stale_incidents(self, hours: int) -> int:
        cutoff = (datetime.now(UTC) - timedelta(hours=hours)).isoformat()
        with self.connect() as connection:
            result = connection.execute(
                "UPDATE incidents SET status='closed' WHERE status='active' AND latest_at < ?",
                (cutoff,),
            )
        return result.rowcount

    def list_incidents(self, active_only: bool = True) -> list[Incident]:
        where = "WHERE i.status='active'" if active_only else ""
        with self.connect() as connection:
            rows = connection.execute(
                f"""
                SELECT i.*, COUNT(ih.hotspot_id) AS hotspot_count,
                       GROUP_CONCAT(ih.hotspot_id) AS hotspot_ids
                FROM incidents i LEFT JOIN incident_hotspots ih ON ih.incident_id=i.id
                {where} GROUP BY i.id ORDER BY i.latest_at DESC
                """
            ).fetchall()
        return [
            Incident(
                id=row["id"],
                hotspot_ids=(row["hotspot_ids"] or "").split(",") if row["hotspot_ids"] else [],
                centroid_lat=row["centroid_lat"],
                centroid_lon=row["centroid_lon"],
                latest_at=row["latest_at"],
                status=row["status"],
                hotspot_count=row["hotspot_count"],
            )
            for row in rows
        ]

    def get_incident(self, incident_id: str) -> tuple[Incident, list[Hotspot]] | None:
        incident = next(
            (item for item in self.list_incidents(active_only=False) if item.id == incident_id),
            None,
        )
        if incident is None:
            return None
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT h.* FROM hotspots h JOIN incident_hotspots ih ON ih.hotspot_id=h.id
                WHERE ih.incident_id=? ORDER BY h.acquired_at
                """,
                (incident_id,),
            ).fetchall()
        return incident, [self._hotspot(row) for row in rows]

    def save_wind(self, snapshot: WindSnapshot) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO wind_snapshots(observed_at, points_json, inserted_at)
                VALUES (?, ?, ?)
                """,
                (
                    snapshot.observed_at.isoformat(),
                    json.dumps([point.model_dump() for point in snapshot.points]),
                    datetime.now(UTC).isoformat(),
                ),
            )

    def latest_wind(self) -> WindSnapshot | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM wind_snapshots ORDER BY observed_at DESC LIMIT 1"
            ).fetchone()
        if row is None:
            return None
        return WindSnapshot(observed_at=row["observed_at"], points=json.loads(row["points_json"]))

    def create_resident(self, resident: ResidentCreate) -> ResidentCreated:
        resident_id = str(uuid4())
        consent_at = datetime.now(UTC)
        revoke_token = secrets.token_urlsafe(32)
        revoke_token_hash = hashlib.sha256(revoke_token.encode()).hexdigest()
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO residents (
                    id, name, phone_e164, language, address, community_id,
                    building_id, cell, vulnerable, consent_at, consent_source, revoke_token_hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    resident_id,
                    resident.name,
                    resident.phone_e164,
                    resident.language,
                    resident.address,
                    resident.community_id,
                    resident.building_id,
                    resident.cell,
                    resident.vulnerable,
                    consent_at.isoformat(),
                    resident.consent_source,
                    revoke_token_hash,
                ),
            )
        return ResidentCreated(
            id=resident_id,
            phone_masked=f"***{resident.phone_e164[-4:]}",
            consent_at=consent_at,
            revoke_token=revoke_token,
        )

    def active_residents(self, community_id: str) -> list[dict]:
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT * FROM residents WHERE community_id=? AND revoked_at IS NULL
                ORDER BY vulnerable DESC, consent_at
                """,
                (community_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def resident_for_building(self, building_id: str) -> dict | None:
        """The consented, active resident registered for a building, if any."""
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT * FROM residents WHERE building_id=? AND revoked_at IS NULL
                ORDER BY consent_at DESC LIMIT 1
                """,
                (building_id,),
            ).fetchone()
        return dict(row) if row else None

    def revoke_resident(self, resident_id: str, revoke_token: str) -> bool:
        token_hash = hashlib.sha256(revoke_token.encode()).hexdigest()
        with self.connect() as connection:
            result = connection.execute(
                """
                UPDATE residents SET revoked_at = ?
                WHERE id = ? AND revoked_at IS NULL AND revoke_token_hash = ?
                """,
                (datetime.now(UTC).isoformat(), resident_id, token_hash),
            )
        return result.rowcount == 1

    def save_official_order(self, order: OfficialOrderCreate) -> tuple[OfficialOrder, bool]:
        received_at = datetime.now(UTC)
        with self.connect() as connection:
            existing = connection.execute(
                "SELECT level, headline, issued_at FROM official_orders WHERE id=?", (order.id,)
            ).fetchone()
            connection.execute(
                """
                INSERT INTO official_orders(
                  id, community_id, level, headline, source, source_url,
                  issued_at, expires_at, received_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  community_id=excluded.community_id, level=excluded.level,
                  headline=excluded.headline, source=excluded.source,
                  source_url=excluded.source_url, issued_at=excluded.issued_at,
                  expires_at=excluded.expires_at, received_at=excluded.received_at
                """,
                (
                    order.id,
                    order.community_id,
                    order.level,
                    order.headline,
                    order.source,
                    order.source_url,
                    order.issued_at.isoformat(),
                    order.expires_at.isoformat() if order.expires_at else None,
                    received_at.isoformat(),
                ),
            )
        changed = existing is None or (
            existing["level"],
            existing["headline"],
            existing["issued_at"],
        ) != (order.level, order.headline, order.issued_at.isoformat())
        return OfficialOrder(**order.model_dump(), received_at=received_at), changed

    def active_official_orders(self, community_id: str | None = None) -> list[OfficialOrder]:
        now = datetime.now(UTC).isoformat()
        query = "SELECT * FROM official_orders WHERE (expires_at IS NULL OR expires_at > ?)"
        params: list[str] = [now]
        if community_id:
            query += " AND community_id=?"
            params.append(community_id)
        query += " ORDER BY issued_at DESC"
        with self.connect() as connection:
            rows = connection.execute(query, params).fetchall()
        return [
            OfficialOrder(
                id=row["id"],
                community_id=row["community_id"],
                level=row["level"],
                headline=row["headline"],
                source=row["source"],
                source_url=row["source_url"],
                issued_at=row["issued_at"],
                expires_at=row["expires_at"],
                received_at=row["received_at"],
            )
            for row in rows
        ]

    def alert_state(self, incident_id: str, community_id: str) -> tuple[AlertLevel, int]:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT level, below_count FROM alerts WHERE incident_id=? AND community_id=?",
                (incident_id, community_id),
            ).fetchone()
        return (AlertLevel(row["level"]), row["below_count"]) if row else (AlertLevel.NONE, 0)

    def save_alert(self, risk: ArrivalRisk, decision: AlertDecision) -> str | None:
        now = datetime.now(UTC).isoformat()
        event_id = str(uuid4()) if decision.changed else None
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO alerts(
                  incident_id, community_id, level, eta_min, probability_1h,
                  probability_3h, probability_6h, below_count, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(incident_id, community_id) DO UPDATE SET
                  level=excluded.level, eta_min=excluded.eta_min,
                  probability_1h=excluded.probability_1h,
                  probability_3h=excluded.probability_3h,
                  probability_6h=excluded.probability_6h,
                  below_count=excluded.below_count, updated_at=excluded.updated_at
                """,
                (
                    risk.incident_id,
                    risk.community_id,
                    int(decision.current),
                    risk.eta_min,
                    risk.probability_1h,
                    risk.probability_3h,
                    risk.probability_6h,
                    decision.below_count,
                    now,
                ),
            )
            if event_id:
                connection.execute(
                    "INSERT INTO alert_events VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        event_id,
                        risk.incident_id,
                        risk.community_id,
                        int(decision.previous),
                        int(decision.current),
                        decision.reason,
                        now,
                    ),
                )
        return event_id

    def create_call_attempt(self, alert_event_id: str, resident_id: str) -> str | None:
        attempt_id = str(uuid4())
        now = datetime.now(UTC).isoformat()
        try:
            with self.connect() as connection:
                connection.execute(
                    """
                    INSERT INTO call_attempts(
                      id, alert_event_id, resident_id, status, created_at, updated_at
                    ) VALUES (?, ?, ?, 'pending', ?, ?)
                    """,
                    (attempt_id, alert_event_id, resident_id, now, now),
                )
            return attempt_id
        except sqlite3.IntegrityError:
            return None

    def update_call_attempt(
        self,
        *,
        status: str,
        details: dict,
        attempt_id: str | None = None,
        retell_call_id: str | None = None,
    ) -> bool:
        key, value = ("id", attempt_id) if attempt_id else ("retell_call_id", retell_call_id)
        if value is None:
            return False
        with self.connect() as connection:
            result = connection.execute(
                f"""
                UPDATE call_attempts SET retell_call_id=COALESCE(?, retell_call_id),
                  status=?, details_json=?, updated_at=? WHERE {key}=?
                """,
                (
                    retell_call_id,
                    status,
                    json.dumps(details),
                    datetime.now(UTC).isoformat(),
                    value,
                ),
            )
        return result.rowcount == 1

    def provider_status(self) -> list[dict]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT provider, watermark, last_success_at, metadata_json FROM provider_state"
            ).fetchall()
        return [
            {
                "provider": row["provider"],
                "watermark": row["watermark"],
                "last_success_at": row["last_success_at"],
                "metadata": json.loads(row["metadata_json"]),
            }
            for row in rows
        ]

    def metrics(self) -> dict[str, int]:
        tables = ("hotspots", "incidents", "residents", "alerts", "call_attempts")
        with self.connect() as connection:
            counts = {
                table: int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
                for table in tables
            }
            counts["active_official_orders"] = int(
                connection.execute(
                    """
                    SELECT COUNT(*) FROM official_orders
                    WHERE expires_at IS NULL OR expires_at > ?
                    """,
                    (datetime.now(UTC).isoformat(),),
                ).fetchone()[0]
            )
        return counts

    @staticmethod
    def _hotspot(row: sqlite3.Row) -> Hotspot:
        return Hotspot(
            id=row["id"],
            source=row["source"],
            satellite=row["satellite"],
            lat=row["lat"],
            lon=row["lon"],
            acquired_at=row["acquired_at"],
            frp=row["frp"],
            confidence=row["confidence"],
            raw=json.loads(row["raw_json"]),
        )
