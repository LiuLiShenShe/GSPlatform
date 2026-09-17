"""Phase 08 E2E integration test — exercises the full user flow
with REAL session authentication (dev-identity disabled temporarily).

Flow: register → login → favorite → list favorites → share private scene
→ resolve share → list shares → revoke share → verify revoke.
"""

from __future__ import annotations

import uuid
from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.core.rate_limit import reset_rate_limits

EMAIL = f"e2e-{uuid.uuid4().hex[:8]}@example.com"
PASSWORD = "E2E-test-123"  # noqa: S105 — deliberate test fixture credential


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
    reset_rate_limits("assistant", "testclient")


def _get_csrf(resp) -> str:
    """Extract gs_csrf cookie value from a response."""
    for key, val in resp.cookies.items():
        if key == "gs_csrf":
            return val
    raise RuntimeError("gs_csrf cookie not found")


class TestE2EFlow:
    def test_register_login_favoriate_share_revoke(self, db, client):
        """Full end-to-end happy path using real sessions."""
        # ── 1. Register ──────────────────────────────────────────────
        resp = client.post(
            "/api/v1/auth/register",
            json={"email": EMAIL, "password": PASSWORD, "displayName": "E2E User"},
        )
        assert resp.status_code in (200, 409), resp.text  # 409 if idempotent
        body = resp.json()
        user_id = body.get("userId")
        assert user_id
        from uuid import UUID

        owner_uid = UUID(user_id)

        # ── 2. Login ─────────────────────────────────────────────────
        resp = client.post(
            "/api/v1/auth/login",
            json={"email": EMAIL, "password": PASSWORD},
        )
        assert resp.status_code == 200, resp.text
        csrf = _get_csrf(resp)
        assert csrf  # double-submit CSRF cookie present

        # ── 3. Verify /me ───────────────────────────────────────────
        resp = client.get("/api/v1/auth/me")
        assert resp.status_code == 200
        me = resp.json()
        assert me["userId"] == user_id

        from uuid import UUID
        owner_uid = UUID(user_id)

        # ── 4. Favorite a public scene (owned by the E2E user) ──────
        from tests.conftest_scenes import create_scene

        scene = create_scene(
            session=db, owner_id=owner_uid, visibility="PUBLIC", status="PUBLISHED"
        )
        slug = scene.slug

        resp = client.put(
            f"/api/v1/favorites/{slug}",
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"favorited": True, "changed": True}

        # ── 5. Favorites list includes it ────────────────────────────
        resp = client.get("/api/v1/favorites")
        assert resp.status_code == 200
        slugs = [item["id"] for item in resp.json()]
        assert slug in slugs

        # ── 5b. My-works listing (owner) shows both scenes ───────────
        resp = client.get("/api/v1/me/scenes", headers={"X-CSRF-Token": csrf})
        assert resp.status_code == 200, resp.text
        my_slugs = [item["id"] for item in resp.json()["items"]]
        assert slug in my_slugs

        # ── 5c. Scene detail (owner) ─────────────────────────────────
        resp = client.get(f"/api/v1/scenes/{slug}", headers={"X-CSRF-Token": csrf})
        assert resp.status_code == 200, resp.text
        detail = resp.json()
        assert detail["title"] == "测试场景"
        assert detail["visibility"] == "PUBLIC"

        # ── 5d. Ask-AI (server-side, mocked model) returns real answer ─
        from unittest.mock import MagicMock, patch

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "choices": [{"message": {"content": "E2E 模型回答"}}]
        }
        mock_resp.text = '{"choices": [{"message": {"content": "E2E 模型回答"}}]}'

        mock_client = MagicMock()
        mock_client.__enter__.return_value = mock_client
        mock_client.post.return_value = mock_resp
        settings_mock = patch(
            "app.services.scene_assistant.get_settings",
            return_value=type(
                "S",
                (),
                {
                    "ai_api_key": "e2e-key",
                    "ai_base_url": "https://example.test/v1",
                    "ai_model": "e2e-model",
                    "ai_timeout_seconds": 10,
                    "ai_max_question_chars": 2000,
                    "ai_max_answer_chars": 4000,
                },
            )(),
        )
        with patch(
            "app.services.scene_assistant.httpx.Client",
            return_value=mock_client,
        ), settings_mock:
            resp = client.post(
                "/api/v1/assistant/ask",
                json={"sceneSlug": slug, "question": "E2E 问题"},
                headers={"X-CSRF-Token": csrf},
            )
        assert resp.status_code == 200, resp.text
        assert resp.json()["answer"] == "E2E 模型回答"
        assert "标题" in resp.json()["sources"]  # sources reported, not fixed text

        # ── 5e. Favorites status endpoint ─────────────────────────────
        resp = client.get(f"/api/v1/favorites/status?slugs={slug}")
        assert resp.status_code == 200
        assert resp.json()[slug] is True

        # ── 7. Create share for a PRIVATE scene ──────────────────────
        private = create_scene(
            session=db, owner_id=owner_uid, visibility="PRIVATE", status="PUBLISHED",
        )
        resp = client.post(
            f"/api/v1/shares/scenes/{private.slug}",
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 200, resp.text
        share_body = resp.json()
        token = share_body["token"]
        assert token  # raw token returned once
        assert share_body["shareUrl"].startswith("/s/")
        assert share_body["revoked"] is False

        # ── 8. Resolve the share (visitor context, no auth) ──────────
        from app.main import app

        visitor = TestClient(app)
        resp = visitor.get(f"/api/v1/shares/resolve/{token}")
        assert resp.status_code == 200
        resolved = resp.json()
        assert resolved["scene"]["id"] == private.slug

        # ── 9. List shares ───────────────────────────────────────────
        resp = client.get(
            f"/api/v1/shares/scenes/{private.slug}",
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 200
        items = resp.json()["items"]
        assert len(items) == 1
        share_id = items[0]["id"]
        assert "token" not in items[0]  # raw token NOT in list response

        # ── 10. Revoke the share ─────────────────────────────────────
        resp = client.delete(
            f"/api/v1/shares/{share_id}/scenes/{private.slug}",
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 200
        assert resp.json()["revoked"] is True

        # ── 11. Resolve now returns 403 (revoked) ────────────────────
        resp = visitor.get(f"/api/v1/shares/resolve/{token}")
        assert resp.status_code == 403

        # ── 12. Unfavorite ───────────────────────────────────────────
        resp = client.delete(
            f"/api/v1/favorites/{slug}",
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 200
        assert resp.json() == {"favorited": False, "changed": True}

        # ── 13. Favorites list now empty ─────────────────────────────
        resp = client.get("/api/v1/favorites")
        slugs_after = [item["id"] for item in resp.json()]
        assert slug not in slugs_after

        # ── 14. Logout ───────────────────────────────────────────────
        resp = client.post(
            "/api/v1/auth/logout",
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 200

        # ── 15. /me returns 401 after logout ─────────────────────────
        resp = client.get("/api/v1/auth/me")
        assert resp.status_code == 401

        # ── 16. Raw token never stored in DB ─────────────────────────
        stored = db.execute(
            text("SELECT COUNT(*) FROM share_links WHERE token_hash = :raw"),
            {"raw": token},
        ).scalar()
        assert stored == 0
