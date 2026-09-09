"""Application configuration for GSPlatform API."""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime settings loaded from environment variables.

    Development defaults are overridable via environment variables;
    nothing here is a production secret.
    """

    app_name: str = "gsplatform-api"
    api_host: str = "0.0.0.0"  # noqa: S104 -- dev default; overridable via GS_API_HOST
    api_port: int = 8001
    env: str = "development"

    # Future phases wire PostgreSQL/Redis here via env vars only.
    database_url: str = ""
    redis_url: str = ""

    model_config = SettingsConfigDict(env_file=".env", env_prefix="GS_", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    """Return the cached application settings singleton."""
    return Settings()


settings = get_settings()
