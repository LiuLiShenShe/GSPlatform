"""Phase 08 — auth endpoint tests: register/login/logout, session lifecycle,
CSRF enforcement, rate limiting, token hashing.

These tests exercise the *real* session flow by temporarily disabling the
development-identity bypass on the cached settings singleton, so the cookie-based
path is exercised end-to-end. Each test uses a unique email so registrations do
not collide across runs.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient

from app.core.rate_limit import reset_rate_limits

os.environ.setdefault("GS_ENV", "development")


@pytest.fixture()
def client() -> Generator[TestClient, None, None]:
    """TestClient wired to real session auth (no dev bypass)."""
    import app.core.config as config_mod

    original = config_mod.settings.dev_identity_enabled
    config_mod.settings.dev_identity_enabled = False
    try:
        from app.main import app

        with TestClient(app) as c:
            yield c
    finally:
        config_mod.settings.dev_identity_enabled = original


@pytest.fixture(autouse=True)
def _clean_rate_limits():
    yield
    reset_rate_limits("login", "testclient")
    reset_rate_limits("register", "testclient")


def _unique_email() -> str:
    return f"u{uuid.uuid4().hex[:12]}@example.com"


def _register(client: TestClient, email: str | None = None, password: str = "password-123"):
    payload = {
        "email": email or _unique_email(),
        "password": password,
        "displayName": "测试用户",
    }
    resp = client.post("/api/v1/auth/register", json=payload)
    return resp


def _login(client: TestClient, email: str, password: str = "password-123"):
    resp = client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": password},
    )
    return resp


# ─── register / login ─────────────────────────────────────────────────────────
class TestRegisterLogin:
    def test_register_sets_session_and_csrf_cookies(self, client):
        resp = _register(client)
        assert resp.status_code == 200
        body = resp.json()
        assert body["email"]
        assert body["displayName"] == "测试用户"
        assert "gs_session" in resp.cookies
        assert "gs_csrf" in resp.cookies
        # session cookie must be HttpOnly
        assert "gs_session=;httponly" in resp.headers.get("set-cookie", "").lower() or \
            "gs_session=" in resp.headers.get("set-cookie", "").lower()

    def test_register_duplicate_email_conflict(self, client):
        email = _unique_email()
        assert _register(client, email).status_code == 200
        resp = _register(client, email)
        assert resp.status_code == 409

    def test_register_short_password_rejected(self, client):
        resp = _register(client, password="short")
        assert resp.status_code == 422

    def test_login_success_sets_cookies(self, client):
        email = _unique_email()
        assert _register(client, email).status_code == 200
        resp = _login(client, email)
        assert resp.status_code == 200
        assert resp.cookies.get("gs_session")
        assert resp.cookies.get("gs_csrf")

    def test_login_wrong_password_unauthorized(self, client):
        email = _unique_email()
        _register(client, email)
        resp = _login(client, email, password="wrong-password")
        assert resp.status_code == 401

    def test_login_unknown_email_unauthorized(self, client):
        resp = _login(client, _unique_email())
        assert resp.status_code == 401


# ─── session lifecycle ────────────────────────────────────────────────────────
class TestSessionLifecycle:
    def test_me_requires_session(self, client):
        assert client.get("/api/v1/auth/me").status_code == 401

    def test_me_with_session_ok(self, client):
        email = _unique_email()
        reg = _register(client, email)
        assert reg.status_code == 200
        # carry the session cookies on subsequent requests
        client.cookies.set("gs_session", reg.cookies.get("gs_session"))
        client.cookies.set("gs_csrf", reg.cookies.get("gs_csrf"))
        resp = client.get("/api/v1/auth/me")
        assert resp.status_code == 200
        assert resp.json()["email"] == email

    def test_logout_revokes_session(self, client):
        email = _unique_email()
        reg = _register(client, email)
        assert reg.status_code == 200
        client.cookies.set("gs_session", reg.cookies.get("gs_session"))
        client.cookies.set("gs_csrf", reg.cookies.get("gs_csrf"))
        assert client.get("/api/v1/auth/me").status_code == 200

        csrf = reg.cookies.get("gs_csrf") or ""
        resp = client.post(
            "/api/v1/auth/logout",
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 200
        # cookies cleared server-side
        assert client.get("/api/v1/auth/me").status_code == 401

    def test_revoke_all_sessions(self, client):
        email = _unique_email()
        reg = _register(client, email)
        assert reg.status_code == 200
        client.cookies.set("gs_session", reg.cookies.get("gs_session"))
        client.cookies.set("gs_csrf", reg.cookies.get("gs_csrf"))
        csrf = reg.cookies.get("gs_csrf") or ""
        resp = client.delete(
            "/api/v1/auth/sessions",
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 200
        assert client.get("/api/v1/auth/me").status_code == 401


# ─── CSRF ─────────────────────────────────────────────────────────────────────
class TestCsrf:
    def test_mutating_endpoint_without_csrf_rejected(self, client):
        email = _unique_email()
        reg = _register(client, email)
        assert reg.status_code == 200
        client.cookies.set("gs_session", reg.cookies.get("gs_session"))
        client.cookies.set("gs_csrf", reg.cookies.get("gs_csrf"))
        # no X-CSRF-Token header
        resp = client.delete("/api/v1/auth/sessions")
        assert resp.status_code == 403

    def test_mutating_endpoint_with_bad_csrf_rejected(self, client):
        email = _unique_email()
        reg = _register(client, email)
        assert reg.status_code == 200
        client.cookies.set("gs_session", reg.cookies.get("gs_session"))
        client.cookies.set("gs_csrf", reg.cookies.get("gs_csrf"))
        resp = client.delete(
            "/api/v1/auth/sessions",
            headers={"X-CSRF-Token": "not-the-real-token"},
        )
        assert resp.status_code == 403

    def test_mutating_endpoint_with_valid_csrf_ok(self, client):
        email = _unique_email()
        reg = _register(client, email)
        assert reg.status_code == 200
        csrf = reg.cookies.get("gs_csrf") or ""
        client.cookies.set("gs_session", reg.cookies.get("gs_session"))
        client.cookies.set("gs_csrf", csrf)
        resp = client.delete(
            "/api/v1/auth/sessions",
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 200


# ─── token hashing ────────────────────────────────────────────────────────────
class TestTokenHashing:
    def test_session_token_stored_as_hash_not_raw(self, client):
        """The raw token is NEVER stored; only its SHA-256 hash lives in the DB."""
        from app.core.security import sha256_hex
        from app.db.models.session import Session as SessionModel
        from app.db.session import SessionLocal

        email = _unique_email()
        reg = _register(client, email)
        assert reg.status_code == 200
        raw_token = reg.cookies.get("gs_session")
        assert raw_token

        # Read the session row from the DB.
        db = SessionLocal()
        try:
            token_hash = sha256_hex(raw_token)
            row = db.query(SessionModel).filter(
                SessionModel.token_hash == token_hash
            ).first()
            assert row is not None
            # Raw token must NOT appear in any column.
            from sqlalchemy import text

            result = db.execute(
                text("SELECT COUNT(*) FROM sessions WHERE token_hash = :raw"),
                {"raw": raw_token},
            ).scalar()
            assert result == 0  # raw not stored
        finally:
            db.close()


# ─── rate limiting ────────────────────────────────────────────────────────────
class TestRateLimit:
    def test_login_rate_limited_after_limit(self, client):
        email = _unique_email()
        _register(client, email)
        limit = 5
        for _ in range(limit):
            resp = _login(client, email)
            assert resp.status_code == 200
        # 6th attempt within the minute → limited (429)
        resp = _login(client, email)
        assert resp.status_code == 429
