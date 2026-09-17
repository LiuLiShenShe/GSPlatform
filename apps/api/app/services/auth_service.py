"""Auth service — register, login, logout, session management.

Every mutation records an audit event.  Passwords are hashed with argon2id;
tokens are random, high-entropy values stored only as SHA-256 hashes in the
``sessions`` table.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.errors import ConflictError, UnauthorizedError
from app.core.security import (
    generate_csrf_token,
    generate_session_token,
    hash_password,
    sha256_hex,
    verify_password,
)
from app.db.models.session import Session as SessionModel
from app.db.models.user import User
from app.services.audit import log_audit

logger = logging.getLogger("gsplatform.auth")


def _client_ip(request: object) -> str:
    """Best-effort extract of client IP from a Starlette Request."""
    try:
        req = getattr(request, "headers", None)
        if req is not None:
            forwarded = req.get("x-forwarded-for")
            if forwarded:
                return str(forwarded).split(",")[0].strip()
        client = getattr(request, "client", None)
        host = getattr(client, "host", None)
        return str(host) if host is not None else ""
    except Exception:
        return ""


class AuthService:
    def __init__(self, db: Session) -> None:
        self._db = db
        self._settings = get_settings()

    # ------------------------------------------------------------------
    # register
    # ------------------------------------------------------------------
    def register(
        self,
        *,
        email: str,
        password: str,
        display_name: str,
        ip: str | None = None,
    ) -> dict[str, str]:
        """Create a new user.  Returns raw session + CSRF tokens."""
        email = email.strip().lower()
        if len(email) > 320:
            raise ConflictError("邮箱格式无效")
        if len(password) < 8:
            raise ConflictError("密码长度至少 8 位")
        if len(display_name) > 120 or not display_name.strip():
            raise ConflictError("显示名称无效")

        existing = self._db.execute(select(User).where(User.email == email)).scalar_one_or_none()
        if existing is not None:
            raise ConflictError("该邮箱已被注册")

        user = User(
            email=email,
            password_hash=hash_password(password),
            display_name=display_name.strip(),
            is_active=True,
        )
        self._db.add(user)
        self._db.flush()

        tokens = self._create_session(user, ip=ip)
        log_audit(self._db, action="REGISTER", user_id=user.id,
                ip_address=ip, detail=f"email={email}")
        return tokens

    # ------------------------------------------------------------------
    # login
    # ------------------------------------------------------------------
    def login(
        self,
        *,
        email: str,
        password: str,
        ip: str | None = None,
    ) -> dict[str, str]:
        """Verify credentials and create a session."""
        email = email.strip().lower()
        user = self._db.execute(select(User).where(User.email == email)).scalar_one_or_none()
        if user is None or not user.is_active:
            log_audit(
                self._db,
                action="LOGIN_FAILED",
                user_id=user.id if user else None,
                ip_address=ip,
                detail="user not found or inactive",
            )
            raise UnauthorizedError("邮箱或密码错误")

        if not verify_password(user.password_hash or "", password):
            log_audit(
                self._db,
                action="LOGIN_FAILED",
                user_id=user.id,
                ip_address=ip,
                detail="bad password",
            )
            raise UnauthorizedError("邮箱或密码错误")

        tokens = self._create_session(user, ip=ip)
        log_audit(
            self._db, action="LOGIN", user_id=user.id, ip_address=ip
        )
        return tokens

    # ------------------------------------------------------------------
    # logout
    # ------------------------------------------------------------------
    def logout(
        self, *, user_id: uuid.UUID, session_id: uuid.UUID, ip: str | None = None
    ) -> None:
        now = datetime.now(UTC)
        stmt = (
            select(SessionModel)
            .where(
                SessionModel.id == session_id,
                SessionModel.user_id == user_id,
                SessionModel.revoked_at.is_(None),
            )
        )
        session_obj = self._db.execute(stmt).scalar_one_or_none()
        if session_obj is None:
            return
        session_obj.revoked_at = now
        self._db.flush()
        log_audit(
            self._db, action="LOGOUT", user_id=user_id, ip_address=ip
        )

    # ------------------------------------------------------------------
    # revoke all sessions for a user
    # ------------------------------------------------------------------
    def revoke_all(self, *, user_id: uuid.UUID, ip: str | None = None) -> None:
        now = datetime.now(UTC)
        self._db.execute(
            select(SessionModel).where(
                SessionModel.user_id == user_id,
                SessionModel.revoked_at.is_(None),
            )
        )
        stmt = (
            select(SessionModel)
            .where(
                SessionModel.user_id == user_id,
                SessionModel.revoked_at.is_(None),
            )
        )
        rows = self._db.execute(stmt).scalars().all()
        for row in rows:
            row.revoked_at = now
        self._db.flush()
        log_audit(
            self._db,
            action="REVOKE_ALL_SESSIONS",
            user_id=user_id,
            ip_address=ip,
            detail=f"revoked {len(rows)} sessions",
        )

    # ------------------------------------------------------------------
    # resolve session → user (called by get_current_user)
    # ------------------------------------------------------------------
    def resolve_session(self, raw_token: str) -> tuple[uuid.UUID, str, str, str, uuid.UUID]:
        """Look up session by raw token, update last_seen_at.

        Returns (user_id, email, display_name, source, session_id).
        Raises UnauthorizedError on invalid/expired/revoked.
        """
        now = datetime.now(UTC)
        token_hash = sha256_hex(raw_token)

        stmt = (
            select(SessionModel)
            .where(SessionModel.token_hash == token_hash)
        )
        sess = self._db.execute(stmt).scalar_one_or_none()
        if sess is None:
            raise UnauthorizedError("会话无效")

        if sess.revoked_at is not None:
            raise UnauthorizedError("会话已撤销")
        if sess.expires_at < now:
            raise UnauthorizedError("会话已过期")

        # Touch last_seen_at (throttled to once per 60s to avoid write amplification).
        if (now - sess.last_seen_at).total_seconds() > 60:
            sess.last_seen_at = now
            self._db.flush()

        user = self._db.execute(select(User).where(User.id == sess.user_id)).scalar_one_or_none()
        if user is None or not user.is_active:
            raise UnauthorizedError("用户不存在或已停用")

        return user.id, user.email, user.display_name, "session", sess.id

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    def _create_session(self, user: User, *, ip: str | None = None) -> dict[str, str]:
        """Create a new session and return {raw_token, csrf_token}."""
        settings = self._settings
        raw_token = generate_session_token()
        csrf_raw = generate_csrf_token()
        ttl = timedelta(hours=settings.session_ttl_hours)

        sess = SessionModel(
            user_id=user.id,
            token_hash=sha256_hex(raw_token),
            csrf_token_hash=sha256_hex(csrf_raw),
            expires_at=datetime.now(UTC) + ttl,
        )
        self._db.add(sess)
        self._db.flush()
        return {"raw_token": raw_token, "csrf_token": csrf_raw, "session_id": str(sess.id)}
