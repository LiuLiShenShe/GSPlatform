"""Auth endpoints — register, login, logout, /me.

Cookies set on login:
  gs_session  — HttpOnly, SameSite=Lax (session key)
  gs_csrf     — JS-readable, SameSite=Lax (double-submit CSRF value)

All state-changing endpoints require X-CSRF-Token header whose value must
match the gs_csrf cookie and verify against the stored session row.
"""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session as DBSession

from app.core.config import Settings, get_settings
from app.core.errors import RateLimitError
from app.core.identity import (
    CurrentUser,
    get_current_user,
    require_csrf,
)
from app.core.rate_limit import check_rate_limit
from app.db.session import get_db_session
from app.schemas.auth import LoginRequest, MessageOut, RegisterRequest, SessionOut
from app.services.auth_service import AuthService

router = APIRouter()


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else ""


def _set_cookies(response: Response, tokens: dict[str, str], settings: Settings) -> None:
    """Set the session and CSRF cookies on a response."""
    max_age = int(timedelta(hours=settings.session_ttl_hours).total_seconds())
    is_secure = settings.env == "production" and settings.session_secure_cookie
    samesite: str = settings.session_same_site or "lax"

    response.set_cookie(
        key=settings.session_cookie_name,
        value=tokens["raw_token"],
        max_age=max_age,
        httponly=True,
        secure=is_secure,
        samesite=samesite,  # type: ignore[arg-type]
        path="/",
    )
    response.set_cookie(
        key=settings.csrf_cookie_name,
        value=tokens["csrf_token"],
        max_age=max_age,
        httponly=False,
        secure=is_secure,
        samesite=samesite,  # type: ignore[arg-type]
        path="/",
    )


# ------------------------------------------------------------------
# POST /auth/register
# ------------------------------------------------------------------
@router.post("/register", response_model=SessionOut)
def register(
    body: RegisterRequest,
    request: Request,
    response: Response,
    db: DBSession = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
) -> SessionOut:
    rl = check_rate_limit(
        "register",
        _client_ip(request),
        limit=settings.rate_limit_register_per_hour,
        window_seconds=3600,
    )
    if not rl.allowed:
        raise RateLimitError(rl.reason)
    service = AuthService(db)
    tokens = service.register(
        email=body.email,
        password=body.password,
        display_name=body.displayName,
        ip=_client_ip(request),
    )
    _set_cookies(response, tokens, settings)
    # Resolve the user for the response.

    from sqlalchemy import select

    from app.db.models.user import User

    user = db.execute(select(User).where(User.email == body.email.strip().lower())).scalar_one()
    return SessionOut(userId=str(user.id), email=user.email, displayName=user.display_name)


# ------------------------------------------------------------------
# POST /auth/login
# ------------------------------------------------------------------
@router.post("/login", response_model=SessionOut)
def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    db: DBSession = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
) -> SessionOut:
    rl = check_rate_limit(
        "login",
        _client_ip(request),
        limit=settings.rate_limit_login_per_minute,
        window_seconds=60,
    )
    if not rl.allowed:
        raise RateLimitError(rl.reason)
    service = AuthService(db)
    tokens = service.login(
        email=body.email,
        password=body.password,
        ip=_client_ip(request),
    )
    _set_cookies(response, tokens, settings)

    from sqlalchemy import select

    from app.db.models.user import User

    user = db.execute(select(User).where(User.email == body.email.strip().lower())).scalar_one()
    return SessionOut(userId=str(user.id), email=user.email, displayName=user.display_name)


# ------------------------------------------------------------------
# POST /auth/logout
# ------------------------------------------------------------------
@router.post("/logout", response_model=MessageOut)
def logout(
    request: Request,
    response: Response,
    identity: CurrentUser = Depends(require_csrf),
    db: DBSession = Depends(get_db_session),
) -> MessageOut:
    if identity.source == "session" and identity.session_id is not None:
        service = AuthService(db)
        service.logout(
            user_id=identity.user_id,
            session_id=identity.session_id,
            ip=_client_ip(request),
        )
    # Clear cookies
    response.delete_cookie("gs_session", path="/")
    response.delete_cookie("gs_csrf", path="/")
    return MessageOut(message="已退出登录")


# ------------------------------------------------------------------
# DELETE /auth/sessions  — revoke all sessions
# ------------------------------------------------------------------
@router.delete("/sessions", response_model=MessageOut)
def revoke_all_sessions(
    request: Request,
    response: Response,
    identity: CurrentUser = Depends(require_csrf),
    db: DBSession = Depends(get_db_session),
) -> MessageOut:
    service = AuthService(db)
    service.revoke_all(user_id=identity.user_id, ip=_client_ip(request))
    response.delete_cookie("gs_session", path="/")
    response.delete_cookie("gs_csrf", path="/")
    return MessageOut(message="已撤销所有会话")


# ------------------------------------------------------------------
# GET /auth/me
# ------------------------------------------------------------------
@router.get("/me", response_model=SessionOut)
def get_me(
    identity: CurrentUser = Depends(get_current_user),
) -> SessionOut:
    return SessionOut(
        userId=str(identity.user_id),
        email=identity.email,
        displayName=identity.display_name,
    )
