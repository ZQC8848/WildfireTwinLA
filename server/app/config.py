from functools import lru_cache

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="WILDFIRE_")

    env: str = "development"
    database_path: str = "./wildfire.db"
    bbox: tuple[float, float, float, float] = (-118.20, 34.17, -118.06, 34.27)
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
    replay_path: str = "./data/eaton-replay.jsonl"
    registration_rate_limit: int = 10

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
