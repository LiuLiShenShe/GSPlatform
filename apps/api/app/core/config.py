"""Application configuration for GSPlatform API.

Env vars are prefixed with ``GS_`` (e.g. ``GS_DATABASE_URL``). Values here
are local *development* defaults only; real credentials are injected via env /
deployment system and never committed.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

APP_NAME = "gsplatform-api"


class Settings(BaseSettings):
    """Runtime settings. All fields are overridable via ``GS_*`` env vars."""

    app_name: str = APP_NAME
    api_host: str = "0.0.0.0"  # noqa: S104 -- dev default; overridable via GS_API_HOST
    api_port: int = 8001
    env: str = "development"  # development | test | production

    # Local development defaults — the same credentials the repo documents in
    # .env.example. Production injects a real URL via GS_DATABASE_URL.
    database_url: str = (
        "postgresql+psycopg2://postgres:postgres@127.0.0.1:5432/gsplatform"
    )
    test_database_url: str = (
        "postgresql+psycopg2://postgres:postgres@127.0.0.1:5432/gsplatform_test"
    )

    # Connection pool tuning (SQLAlchemy engine).
    database_pool_size: int = 5
    database_max_overflow: int = 10
    database_pool_timeout: int = 30
    database_pool_recycle: int = 1800

    # Application name shown on the PostgreSQL server (pg_stat_activity).
    database_application_name: str = "gsplatform-api"

    # --- Identity / auth boundary (Phase 05) ---
    # Dev identity bypass: honored ONLY when env == "development" AND this
    # flag is explicitly true. Production startup refuses this configuration.
    dev_identity_enabled: bool = False
    dev_identity_email: str = "dev@gsplatform.local"
    dev_identity_display_name: str = "本地开发用户"
    dev_identity_user_role: str = "user"

    # --- Sessions (Phase 08) ---
    session_cookie_name: str = "gs_session"
    session_ttl_hours: int = 7 * 24        # 7 days
    session_secure_cookie: bool = False     # production injects GS_SESSION_SECURE_COOKIE=true
    session_same_site: str = "lax"          # strict | lax | none
    # Double-submit CSRF cookie (must be JS-readable; never HttpOnly).
    csrf_cookie_name: str = "gs_csrf"
    # Rate limiting
    rate_limit_login_per_minute: int = 5
    rate_limit_register_per_hour: int = 10
    rate_limit_share_per_hour: int = 20
    rate_limit_assistant_per_minute: int = 10
    audit_enabled: bool = True

    # --- Scene Assistant (Phase 08) ---
    # Only server-side configuration; the API key must never reach the browser.
    ai_base_url: str = "https://apihub.agnes-ai.cn/v1"
    ai_model: str = "agnes-2.5-flash"
    ai_api_key: str = ""          # GS_AI_API_KEY injected at runtime, never committed
    ai_timeout_seconds: float = 30.0
    ai_max_question_chars: int = 2000
    ai_max_answer_chars: int = 4000

    # --- Storage roots (Phase 06) ---
    # Logical names; deployment overrides via GS_STORAGE_ROOT env var.
    storage_root: str = "/home/test/gsplatform-data"

    # Scene asset origin tree (Phase 09).
    # Production Nginx serves `/local-scenes/<slug>/...` from this tree.
    # Empty string = no production origin tree (dev uses repo `scenes/` instead).
    scene_origin_root: str = ""

    # Upload constraints (Phase 06)
    upload_max_bytes: int = 5 * 1024 * 1024 * 1024      # 5 GB
    upload_chunk_max_bytes: int = 64 * 1024 * 1024       # 64 MB per chunk
    upload_expiry_hours: int = 24                         # session TTL
    max_concurrent_uploads_per_user: int = 5
    allowed_upload_formats: list[str] = ["ply", "sog", "splat", "zip"]
    allowed_upload_mime_types: list[str] = [
        "model/ply",
        "model/sog",
        "application/octet-stream",
        "application/zip",
        "application/x-zip-compressed",
    ]

    # Phase 07: formats accepted for RECONSTRUCT-purpose uploads (video + images).
    reconstruct_upload_formats: list[str] = [
        "mp4", "mov", "avi", "mkv", "jpg", "jpeg", "png", "webp",
    ]
    reconstruct_upload_mime_types: list[str] = [
        "video/mp4",
        "video/quicktime",
        "video/x-msvideo",
        "video/x-matroska",
        "image/jpeg",
        "image/png",
        "image/webp",
        "application/octet-stream",
    ]

    # Redis / Celery (Phase 06)
    redis_url: str = "redis://localhost:6379/0"
    celery_broker_url: str = "redis://localhost:6379/0"
    celery_result_backend: str = "redis://localhost:6379/1"

    # Allowed CORS origins for browser callers (Vite dev server).
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="GS_",
        extra="ignore",
        case_sensitive=False,
    )


@lru_cache
def get_settings() -> Settings:
    """Return the cached application settings singleton."""
    return Settings()


settings = get_settings()
