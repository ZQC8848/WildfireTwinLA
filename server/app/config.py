from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="WILDFIRE_")

    env: str = "development"
    database_path: str = "./wildfire.db"
    bbox: tuple[float, float, float, float] = (-118.20, 34.17, -118.06, 34.27)
    firms_map_key: str = ""
    retell_api_key: str = ""
    retell_webhook_secret: str = ""
    enable_pollers: bool = False

    @field_validator("bbox", mode="before")
    @classmethod
    def parse_bbox(cls, value: object) -> object:
        if isinstance(value, str):
            return tuple(float(part.strip()) for part in value.split(","))
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
