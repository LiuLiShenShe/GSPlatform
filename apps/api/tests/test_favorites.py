"""Phase 08 — favorites endpoint tests: idempotent add/remove, list, status,
privatized-scene invisibility, auth gating.
"""

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _dev_auth_headers() -> dict:
    # Dev-identity bypass: identity is injected automatically.
    return {}


def _other_owner() -> uuid.UUID:
    """Create a *different* owner's scene via ORM."""
    from app.db.models.user import User
    from app.db.session import SessionLocal

    db = SessionLocal()
    try:
        user = User(email=f"other-{uuid.uuid4().hex[:8]}@example.com", display_name="他人用户")
        db.add(user)
        db.flush()
        from tests.conftest_scenes import create_scene

        scene = create_scene(session=db, owner_id=user.id)
        return scene.id
    finally:
        db.close()


# ─── add / remove idempotency ────────────────────────────────────────────────
class TestAddRemove:
    def test_add_then_remove_then_add(self, db, public_scene):
        slug = public_scene.slug
        resp = client.put(f"/api/v1/favorites/{slug}", headers=_dev_auth_headers())
        assert resp.status_code == 200
        assert resp.json() == {"favorited": True, "changed": True}

        # idempotent no-op
        resp = client.put(f"/api/v1/favorites/{slug}", headers=_dev_auth_headers())
        assert resp.status_code == 200
        assert resp.json() == {"favorited": True, "changed": False}

        resp = client.delete(f"/api/v1/favorites/{slug}", headers=_dev_auth_headers())
        assert resp.status_code == 200
        assert resp.json() == {"favorited": False, "changed": True}

        resp = client.delete(f"/api/v1/favorites/{slug}", headers=_dev_auth_headers())
        assert resp.status_code == 200
        assert resp.json() == {"favorited": False, "changed": False}

    def test_favorite_missing_scene_404(self, db):
        resp = client.put("/api/v1/favorites/does-not-exist", headers=_dev_auth_headers())
        assert resp.status_code == 404

    def test_favorite_private_other_owner_404(self, db):
        """Favoriting a scene owned by someone else that is private → 404 (not visible)."""
        from app.db.models.user import User
        from app.db.session import SessionLocal

        db2 = SessionLocal()
        try:
            other = User(email=f"o-{uuid.uuid4().hex[:8]}@example.com", display_name="他人")
            db2.add(other)
            db2.flush()
            from tests.conftest_scenes import create_scene

            scene = create_scene(
                session=db2,
                owner_id=other.id,
                visibility="PRIVATE",
                status="PUBLISHED",
            )
        finally:
            db2.close()

        resp = client.put(
            f"/api/v1/favorites/{scene.slug}", headers=_dev_auth_headers()
        )
        assert resp.status_code == 404

    def test_favorite_own_private_ok(self, db, private_scene):
        """Owner can favorite their own private scene."""
        resp = client.put(
            f"/api/v1/favorites/{private_scene.slug}", headers=_dev_auth_headers()
        )
        assert resp.status_code == 200
        assert resp.json()["favorited"] is True


# ─── list / status ───────────────────────────────────────────────────────────
class TestListStatus:
    def test_status_empty_then_toggled(self, db, public_scene):
        slug = public_scene.slug
        resp = client.get(
            f"/api/v1/favorites/status?slugs={slug}", headers=_dev_auth_headers()
        )
        assert resp.status_code == 200
        assert resp.json() == {slug: False}

        client.put(f"/api/v1/favorites/{slug}", headers=_dev_auth_headers())
        resp = client.get(
            f"/api/v1/favorites/status?slugs={slug}", headers=_dev_auth_headers()
        )
        assert resp.status_code == 200
        assert resp.json() == {slug: True}

    def test_list_contains_favorited(self, db, public_scene, private_scene):
        client.put(f"/api/v1/favorites/{public_scene.slug}", headers=_dev_auth_headers())
        resp = client.get("/api/v1/favorites", headers=_dev_auth_headers())
        assert resp.status_code == 200
        slugs = [item["id"] for item in resp.json()]
        assert public_scene.slug in slugs

    def test_list_excludes_deleted(self, db, public_scene):

        from app.db.models.scene import Scene
        from app.db.session import SessionLocal

        client.put(f"/api/v1/favorites/{public_scene.slug}", headers=_dev_auth_headers())

        # Soft-delete the scene via a fresh session (re-query to avoid
        # attaching an object bound to the fixture session).
        db2 = SessionLocal()
        try:
            row = db2.get(Scene, public_scene.id)
            assert row is not None
            from datetime import UTC, datetime

            row.deleted_at = datetime.now(UTC)
            db2.commit()
        finally:
            db2.close()

        resp = client.get("/api/v1/favorites", headers=_dev_auth_headers())
        slugs = [item["id"] for item in resp.json()]
        assert public_scene.slug not in slugs
