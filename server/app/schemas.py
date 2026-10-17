from datetime import UTC, datetime
from enum import IntEnum
from typing import Literal

from pydantic import BaseModel, Field


class AlertLevel(IntEnum):
    NONE = 0
    WATCH = 1
    WARNING = 2
    IMMINENT = 3


class Hotspot(BaseModel):
    id: str
    source: Literal["VIIRS", "MODIS", "GOES"]
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    acquired_at: datetime
    frp: float = Field(default=0, ge=0)
    confidence: float = Field(ge=0, le=1)


class Incident(BaseModel):
    id: str
    hotspot_ids: list[str]
    centroid_lat: float
    centroid_lon: float
    latest_at: datetime


class ResidentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    phone_e164: str = Field(pattern=r"^\+[1-9]\d{7,14}$")
    language: str = Field(default="en", max_length=16)
    address: str = Field(min_length=4, max_length=300)
    community_id: str
    building_id: str | None = None
    cell: int | None = Field(default=None, ge=0)
    vulnerable: bool = False
    consent: Literal[True]
    consent_source: str = Field(default="web", max_length=40)


class ResidentCreated(BaseModel):
    id: str
    phone_masked: str
    consent_at: datetime


class ArrivalRisk(BaseModel):
    community_id: str
    incident_id: str
    probability_1h: float = Field(ge=0, le=1)
    probability_3h: float = Field(ge=0, le=1)
    probability_6h: float = Field(ge=0, le=1)
    eta_min: float = Field(ge=0)


class ServerMessage(BaseModel):
    type: str
    sequence: int
    emitted_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    data: dict
