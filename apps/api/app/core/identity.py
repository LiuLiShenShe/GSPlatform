"""Request identity and the ``get_current_user`` dependency.

Phase 08 introduces real sessions backed by HttpOnly cookies.  Every
authenticated request resolves identity from the ``gs_session`` cookie:

- cookie value → sha256 → sessions.token_hash → (user, expiry, revocation)
- CSRF double-submit token hash lives on the same session row.

The development bypass remains supported in ``development`` + explicit flag,
and is refused by production startup checks (see ``app.main``).
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from fastapi import Depends, Request

from app.core.config import Settings, get_settings
from app.core.csrf import verify_csrf
from app.core.errors import UnauthorizedError
from app.db.session import SessionLocal


@dataclass(frozen=True)
class RequestIdentity:
    """Identity of the caller after the auth boundary is enforced."""

    user_id: UUID
    email: str
    display_name: str
    # "dev" when the development bypass supplied it; "session" for real sessions.
    source: str = "dev"
    # sha256 of the double-submit CSRF value (session-based calls only).
    csrf_token_hash: str | None = None
    # session row id (session-based calls only).
    session_id: UUID | None = None

    @property
    def is_authenticated(self) -> bool:
        return self.source in ("dev", "session")


DEV_USER_EMAIL = "dev@gsplatform.local"
DEV_USER_DISPLAY_NAME = "本地开发用户"


def _resolve_dev_user_id(settings: Settings) -> UUID:
    """Return (creating if needed) the fixed dev user used by the bypass."""
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


def _resolve_request_identity(request: Request, settings: Settings) -> RequestIdentity:
    """Resolve identity from the session cookie, falling back to dev bypass."""
    cookie_name = settings.session_cookie_name
    raw_token = request.cookies.get(cookie_name)

    def _dev_fallback() -> RequestIdentity:
        user_id = _resolve_dev_user_id(settings)
        return RequestIdentity(
            user_id=user_id,
            email=settings.dev_identity_email or DEV_USER_EMAIL,
            display_name=settings.dev_identity_display_name or DEV_USER_DISPLAY_NAME,
            source="dev",
        )

    # Dev bypass short-circuits session lookups in development only.
    if settings.env == "development" and settings.dev_identity_enabled:
        return _dev_fallback()

    if not raw_token:
        raise UnauthorizedError("未登录或会话已过期")

    db = SessionLocal()
    try:
        # 延迟导入避免与 services/__init__ 的循环依赖：
        # identity ← auth_service ← services ← identity。
        from app.services.auth_service import AuthService

        service = AuthService(db)
        user_id, email, display_name, _source, session_id = service.resolve_session(raw_token)
        from app.db.models.session import Session as SessionModel

        session_row = db.get(SessionModel, session_id)
        csrf_hash = session_row.csrf_token_hash if session_row is not None else None
        return RequestIdentity(
            user_id=user_id,
            email=email,
            display_name=display_name,
            source="session",
            csrf_token_hash=csrf_hash,
            session_id=session_id,
        )
    except UnauthorizedError:
        raise
    finally:
        db.close()


def _ensure_csrf(request: Request, identity: RequestIdentity, settings: Settings) -> None:
    """Verify the double-submit CSRF token for session-based callers.

    The dev bypass is not itself CSRF-exempt for state-changes; however the
    API layer calls ``verify_csrf`` explicitly on mutating routes with the
    identity's stored hash, so this is the single enforcement point.
    """
    if identity.source != "session":
        return
    if identity.csrf_token_hash is None:
        raise UnauthorizedError("会话状态无效")
    verify_csrf(request, identity.csrf_token_hash)


def get_current_user(
    request: Request,
    settings: Settings = Depends(get_settings),
) -> RequestIdentity:
    """Resolve the caller's identity via session cookie (or dev bypass)."""
    return _resolve_request_identity(request, settings)


def get_optional_current_user(
    request: Request,
    settings: Settings = Depends(get_settings),
) -> RequestIdentity | None:
    """Identity dependency that never raises: anonymous callers get None."""
    try:
        return _resolve_request_identity(request, settings)
    except UnauthorizedError:
        return None


def require_csrf(
    request: Request,
    identity: RequestIdentity = Depends(get_current_user),
) -> RequestIdentity:
    """Identity + CSRF dependency for state-changing routes.

    - Resolves the session (or dev bypass) exactly like ``get_current_user``.
    - For session-based callers, verifies the double-submit CSRF token.
    - Returns the verified identity so handlers can use it directly.

    Usage: ``identity: RequestIdentity = Depends(require_csrf)``
    """
    if identity.source == "session":
        if identity.csrf_token_hash is None:
            raise UnauthorizedError("会话状态无效")
        verify_csrf(request, identity.csrf_token_hash)
    return identity


CurrentUser = RequestIdentity
