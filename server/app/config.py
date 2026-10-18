from functools import lru_cache

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="WILDFIRE_")

    env: str = "development"
    database_path: str = "./wildfire.db"
    bbox: tuple[float, float, float, float] = (-117.714, 33.427, -117.576, 33.543)
    firms_map_key: str = ""
    enable_direct_goes: bool = False
    goes_satellite: str = "goes18"
    official_feed_url: str = ""
    retell_api_key: str = ""
    retell_from_number: str = ""
    retell_agent_id: str = ""
    internal_api_key: str = ""
    enable_pollers: bool = False
    firms_poll_seconds: int = 300
    weather_poll_seconds: int = 3600
    cluster_seconds: int = 60
    goes_poll_seconds: int = 300
    official_poll_seconds: int = 60
    incident_close_hours: int = 24
    request_timeout_seconds: float = 20
    grid_width: int = 512
    grid_height: int = 512
    grid_crs: str = "EPSG:32611"
    replay_path: str = "./data/norte-replay.jsonl"
    eaton_replay_path: str = "./data/eaton-replay.jsonl"
    registration_rate_limit: int = 10
    # Browser origins allowed to call the HTTP API (the WebSocket is not subject to CORS)
    cors_origins: tuple[str, ...] = ("http://localhost:5173", "http://127.0.0.1:5173")
    # Emergency contact dispatcher (app/dispatch.py)
    grid_dir: str = "../web/public/data"
    dispatch_call_lines: int = 6
    dispatch_sms_per_second: float = 25.0
    dispatch_demo_speed: float = 10.0
    # Only with this switch on, a home whose building has a consented, registered resident is
    # called through Retell. Synthetic households are never dialled.
    dispatch_real_calls: bool = False

    @field_validator("cors_origins", mode="before")
    @classmethod
    def parse_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return tuple(part.strip() for part in value.split(",") if part.strip())
        return value

    @field_validator("bbox", mode="before")
    @classmethod
    def parse_bbox(cls, value: object) -> object:
        if isinstance(value, str):
            return tuple(float(part.strip()) for part in value.split(","))
        return value

    @model_validator(mode="after")
    def production_secrets(self):
        if self.env == "production" and not self.internal_api_key:
            raise ValueError("WILDFIRE_INTERNAL_API_KEY is required in production")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
