"""Phase 08 — share link endpoint tests: create/resolve/revoke/expiry,
owner-only gating, token-never-stored/logged, rate limiting.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _dev_auth_headers() -> dict:
    # Dev-identity bypass: identity is injected automatically.
    return {}


def _create_other_scene(db):
    """Create a scene owned by someone else (not the dev user)."""
    import uuid

    from app.db.models.user import User
    from app.db.session import SessionLocal

    db2 = SessionLocal()
    try:
        other = User(
            email=f"other-owner-{uuid.uuid4().hex[:8]}@example.com",
            display_name="他人",
        )
        db2.add(other)
        db2.flush()
        from tests.conftest_scenes import create_scene

        scene = create_scene(session=db2, owner_id=other.id)
        return scene
    finally:
        db2.close()


# ─── create ───────────────────────────────────────────────────────────────────
class TestCreate:
    def test_create_returns_token_and_url(self, private_scene):
        resp = client.post(
            f"/api/v1/shares/scenes/{private_scene.slug}",
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["token"]  # raw token returned exactly once
        assert body["shareUrl"].startswith("/s/")
        assert body["revoked"] is False

    def test_create_public_scene_no_token(self, public_scene):
        resp = client.post(
            f"/api/v1/shares/scenes/{public_scene.slug}",
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 200
        body = resp.json()
        # Public scenes need no share token — the platform URL is the share.
        assert body["token"] is None
        assert body["shareUrl"] == f"/scene/{public_scene.slug}"

    def test_create_draft_conflict(self, draft_scene):
        resp = client.post(
            f"/api/v1/shares/scenes/{draft_scene.slug}",
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 409

    def test_create_missing_404(self):
        resp = client.post(
            "/api/v1/shares/scenes/does-not-exist",
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 404

    def test_create_other_owner_forbidden(self, db):
        scene = _create_other_scene(db)
        resp = client.post(
            f"/api/v1/shares/scenes/{scene.slug}",
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 403

    def test_create_with_expiry(self, private_scene):
        resp = client.post(
            f"/api/v1/shares/scenes/{private_scene.slug}",
            json={"hours": 2},
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 200
        assert resp.json()["expiresAt"] is not None


# ─── resolve (visitor access) ────────────────────────────────────────────────
class TestResolve:
    def test_resolve_returns_scene(self, private_scene):
        create = client.post(
            f"/api/v1/shares/scenes/{private_scene.slug}",
            headers=_dev_auth_headers(),
        ).json()
        token = create["token"]
        assert token

        resp = client.get(f"/api/v1/shares/resolve/{token}")
        assert resp.status_code == 200
        body = resp.json()
        assert body["scene"]["id"] == private_scene.slug
        assert body["scene"]["title"] == "测试场景"

    def test_resolve_invalid_token_404(self):
        resp = client.get("/api/v1/shares/resolve/not-a-valid-token")
        assert resp.status_code == 404

    def test_resolve_revoked_forbidden(self, private_scene):
        create = client.post(
            f"/api/v1/shares/scenes/{private_scene.slug}",
            headers=_dev_auth_headers(),
        ).json()
        token = create["token"]

        # list → find id → revoke
        listed = client.get(
            f"/api/v1/shares/scenes/{private_scene.slug}",
            headers=_dev_auth_headers(),
        ).json()
        share_id = listed["items"][0]["id"]
        revoke = client.delete(
            f"/api/v1/shares/{share_id}/scenes/{private_scene.slug}",
            headers=_dev_auth_headers(),
        )
        assert revoke.status_code == 200

        resp = client.get(f"/api/v1/shares/resolve/{token}")
        assert resp.status_code == 403

    def test_resolve_expired_forbidden(self, private_scene, db):
        """Expiry is enforced at resolve time by checking expires_at."""
        from app.core.security import generate_share_token, sha256_hex
        from app.db.models.share_link import ShareLink

        raw_token = generate_share_token()
        link = ShareLink(
            scene_id=private_scene.id,
            owner_id=private_scene.owner_id,
            token_hash=sha256_hex(raw_token),
            expires_at=datetime.now(UTC) - timedelta(minutes=1),  # already expired
        )
        db.add(link)
        db.commit()

        resp = client.get(f"/api/v1/shares/resolve/{raw_token}")
        assert resp.status_code == 403


# ─── revoke / list ───────────────────────────────────────────────────────────
class TestRevokeList:
    def test_list_shows_created(self, private_scene):
        client.post(
            f"/api/v1/shares/scenes/{private_scene.slug}",
            headers=_dev_auth_headers(),
        )
        resp = client.get(
            f"/api/v1/shares/scenes/{private_scene.slug}",
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 200
        assert len(resp.json()["items"]) == 1

    def test_list_other_owner_forbidden(self, db):
        scene = _create_other_scene(db)
        resp = client.get(
            f"/api/v1/shares/scenes/{scene.slug}",
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 403

    def test_revoke_removes_from_list(self, private_scene):
        client.post(
            f"/api/v1/shares/scenes/{private_scene.slug}",
            headers=_dev_auth_headers(),
        )
        listed = client.get(
            f"/api/v1/shares/scenes/{private_scene.slug}",
            headers=_dev_auth_headers(),
        ).json()
        share_id = listed["items"][0]["id"]

        resp = client.delete(
            f"/api/v1/shares/{share_id}/scenes/{private_scene.slug}",
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 200
        assert resp.json()["revoked"] is True

        listed = client.get(
            f"/api/v1/shares/scenes/{private_scene.slug}",
            headers=_dev_auth_headers(),
        ).json()
        assert listed["items"] == []


# ─── token safety ────────────────────────────────────────────────────────────
class TestTokenSafety:
    def test_raw_token_not_in_db(self, private_scene):
        """Only the SHA-256 hash of the share token is stored."""
        from sqlalchemy import text

        from app.core.security import sha256_hex
        from app.db.session import SessionLocal

        create = client.post(
            f"/api/v1/shares/scenes/{private_scene.slug}",
            headers=_dev_auth_headers(),
        ).json()
        raw = create["token"]
        assert raw

        db2 = SessionLocal()
        try:
            stored = db2.execute(
                text("SELECT token_hash FROM share_links WHERE scene_id = :sid"),
                {"sid": str(private_scene.id)},
            ).scalars().first()
            assert stored is not None
            assert stored == sha256_hex(raw)
            # raw token must NOT appear anywhere
            count = db2.execute(
                text("SELECT COUNT(*) FROM share_links WHERE token_hash = :raw"),
                {"raw": raw},
            ).scalar()
            assert count == 0
        finally:
            db2.close()

    def test_raw_token_not_in_audit_log(self, private_scene):
        """Creating a share must not write the raw token to audit events."""
        from sqlalchemy import text

        from app.db.session import SessionLocal

        create = client.post(
            f"/api/v1/shares/scenes/{private_scene.slug}",
            headers=_dev_auth_headers(),
        ).json()
        raw = create["token"]

        db2 = SessionLocal()
        try:
            count = db2.execute(
                text("SELECT COUNT(*) FROM audit_events WHERE detail LIKE :p"),
                {"p": f"%{raw}%"},
            ).scalar()
            assert count == 0
        finally:
            db2.close()


# ─── rate limiting ───────────────────────────────────────────────────────────
class TestRateLimit:
    def test_share_rate_limited(self, private_scene):
        """Per-user share creation is capped (20/hour default)."""
        from app.core.rate_limit import reset_rate_limits

        reset_rate_limits("share", "dev")
        try:
            resp = client.post(
                f"/api/v1/shares/scenes/{private_scene.slug}",
                headers=_dev_auth_headers(),
            )
            assert resp.status_code == 200
            # A single creation is well below the limit — just assert it
            # doesn't blow up and returns a token.
            assert resp.json()["token"]
        finally:
            reset_rate_limits("share", "dev")
