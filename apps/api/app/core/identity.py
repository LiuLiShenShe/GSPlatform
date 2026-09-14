"""Request identity and the replaceable ``get_current_user`` dependency.

Phase 05 only establishes the *boundary*: no real login/session exists until
Phase 08. A development identity bypass is allowed to shape the local loop,
but it must be:

- enabled ONLY when ``GS_ENV=development`` AND ``GS_DEV_IDENTITY_ENABLED=true``
- refused by production startup checks (see ``app.main``)
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from fastapi import Depends

from app.core.config import Settings, get_settings
from app.core.errors import UnauthorizedError
from app.db.session import SessionLocal


@dataclass(frozen=True)
class RequestIdentity:
    """Identity of the caller after the auth boundary is enforced."""

    user_id: UUID
    email: str
    display_name: str
    # "dev" when the development bypass supplied it; real sessions arrive in
    # Phase 08 (source="session").
    source: str = "dev"

    @property
    def is_authenticated(self) -> bool:
        return self.source in ("dev", "session")


DEV_USER_EMAIL = "dev@gsplatform.local"
DEV_USER_DISPLAY_NAME = "本地开发用户"


def _resolve_dev_user_id(settings: Settings) -> UUID:
    """Return (creating if needed) the fixed dev user used by the bypass.

    Fails loudly if the bypass is configured outside development, which the
    startup check also refuses. The dev user is created lazily on first
    authenticated request so the app stays seed-independent.
    """
    session = SessionLocal()
    try:
        from app.repositories.users import find_or_create_dev_user

        user_id = find_or_create_dev_user(
            session,
            email=settings.dev_identity_email
            if settings.dev_identity_email
            else DEV_USER_EMAIL,
            display_name=settings.dev_identity_display_name
            if settings.dev_identity_display_name
            else DEV_USER_DISPLAY_NAME,
        )
        return user_id
    finally:
        session.close()


def get_current_user(
    settings: Settings = Depends(get_settings),
) -> RequestIdentity:
    """Resolve the caller's identity (Phase 05: development bypass only).

    Replaceable in Phase 08 with real session verification without touching
    service-layer permission logic.
    """
    if settings.env == "development" and settings.dev_identity_enabled:
        user_id = _resolve_dev_user_id(settings)
        return RequestIdentity(
            user_id=user_id,
            email=settings.dev_identity_email or DEV_USER_EMAIL,
            display_name=settings.dev_identity_display_name or DEV_USER_DISPLAY_NAME,
            source="dev",
        )
    raise UnauthorizedError("未登录或会话已过期")


def get_optional_current_user(
    settings: Settings = Depends(get_settings),
) -> RequestIdentity | None:
    """Identity dependency that never raises: anonymous callers get None."""
    try:
        return get_current_user(settings=settings)
    except UnauthorizedError:
        return None


CurrentUser = RequestIdentity
