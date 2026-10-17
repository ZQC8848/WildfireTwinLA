import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from .schemas import ResidentCreate, ResidentCreated


class Store:
    def __init__(self, database_path: str) -> None:
        self.path = Path(database_path)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def initialize(self) -> None:
        with self.connect() as connection:
            connection.executescript(
                """
                PRAGMA journal_mode=WAL;
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
                    revoked_at TEXT
                );
                CREATE TABLE IF NOT EXISTS provider_state (
                    provider TEXT PRIMARY KEY,
                    watermark TEXT,
                    last_success_at TEXT,
                    metadata_json TEXT NOT NULL DEFAULT '{}'
                );
                """
            )

    def ready(self) -> bool:
        try:
            with self.connect() as connection:
                connection.execute("SELECT 1").fetchone()
            return True
        except sqlite3.Error:
            return False

    def create_resident(self, resident: ResidentCreate) -> ResidentCreated:
        resident_id = str(uuid4())
        consent_at = datetime.now(UTC)
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO residents (
                    id, name, phone_e164, language, address, community_id,
                    building_id, cell, vulnerable, consent_at, consent_source
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                ),
            )
        return ResidentCreated(
            id=resident_id,
            phone_masked=f"***{resident.phone_e164[-4:]}",
            consent_at=consent_at,
        )

    def revoke_resident(self, resident_id: str) -> bool:
        with self.connect() as connection:
            result = connection.execute(
                "UPDATE residents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
                (datetime.now(UTC).isoformat(), resident_id),
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
