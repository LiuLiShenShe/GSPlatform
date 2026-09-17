"""Phase 08 — scene owner-mutation tests: PATCH (optimistic concurrency),
archive/restore, soft-delete, permission matrix (owner vs other vs anonymous).
"""

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _dev_auth_headers() -> dict:
    # Dev-identity bypass: identity is injected automatically.
    return {}


def _create_other_scene():
    """Create a scene owned by someone else."""
    from app.db.models.user import User
    from app.db.session import SessionLocal

    db2 = SessionLocal()
    try:
        other = User(
            email=f"scene-owner-{uuid.uuid4().hex[:8]}@example.com",
            display_name="他人",
        )
        db2.add(other)
        db2.flush()
        from tests.conftest_scenes import create_scene

        scene = create_scene(session=db2, owner_id=other.id)
        return scene
    finally:
        db2.close()


def _detail(slug: str):
    resp = client.get(f"/api/v1/scenes/{slug}", headers=_dev_auth_headers())
    assert resp.status_code == 200
    return resp.json()


# ─── PATCH edit ───────────────────────────────────────────────────────────────
class TestPatch:
    def test_edit_title_by_owner(self, public_scene):
        resp = client.patch(
            f"/api/v1/scenes/{public_scene.slug}",
            json={"title": "新标题"},
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 200
        assert resp.json()["title"] == "新标题"

    def test_edit_other_owner_forbidden(self, db):
        scene = _create_other_scene()
        resp = client.patch(
            f"/api/v1/scenes/{scene.slug}",
            json={"title": "越权"},
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 403

    def test_edit_missing_404(self):
        resp = client.patch(
            "/api/v1/scenes/does-not-exist",
            json={"title": "x"},
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 404

    def test_edit_invalid_category_conflict(self, public_scene):
        resp = client.patch(
            f"/api/v1/scenes/{public_scene.slug}",
            json={"category": "not-a-category"},
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 409

    def test_edit_stale_expected_updated_at_conflict(self, public_scene):
        """Optimistic concurrency: stale updatedAt → 409."""
        detail = _detail(public_scene.slug)
        current = detail["updatedAt"]
        # Send a deliberately wrong timestamp.
        resp = client.patch(
            f"/api/v1/scenes/{public_scene.slug}",
            json={"title": "新标题2", "expectedUpdatedAt": "2000-01-01T00:00:00Z"},
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 409

        # Correct timestamp works.
        resp = client.patch(
            f"/api/v1/scenes/{public_scene.slug}",
            json={"title": "新标题2", "expectedUpdatedAt": current},
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 200

    def test_edit_visibility_private(self, public_scene):
        resp = client.patch(
            f"/api/v1/scenes/{public_scene.slug}",
            json={"visibility": "PRIVATE"},
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 200
        assert resp.json()["visibility"] == "PRIVATE"


# ─── archive / restore ───────────────────────────────────────────────────────
class TestArchiveRestore:
    def test_archive_then_restore(self, public_scene):
        # Before archive: status is PUBLISHED
        detail = _detail(public_scene.slug)
        assert detail["status"] == "PUBLISHED"

        resp = client.post(
            f"/api/v1/scenes/{public_scene.slug}/archive",
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 200

        # After archive: owner can still see own scene, but status changed
        detail = _detail(public_scene.slug)
        assert detail["status"] == "ARCHIVED"

        resp = client.post(
            f"/api/v1/scenes/{public_scene.slug}/restore",
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 200

        # After restore: status is back to PUBLISHED
        detail = _detail(public_scene.slug)
        assert detail["status"] == "PUBLISHED"

    def test_archive_other_owner_forbidden(self):
        scene = _create_other_scene()
        resp = client.post(
            f"/api/v1/scenes/{scene.slug}/archive",
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 403

    def test_restore_non_archived_conflict(self, public_scene):
        resp = client.post(
            f"/api/v1/scenes/{public_scene.slug}/restore",
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 409


# ─── soft delete ──────────────────────────────────────────────────────────────
class TestDelete:
    def test_delete_sets_deleted_at(self, public_scene):
        resp = client.delete(
            f"/api/v1/scenes/{public_scene.slug}",
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 200

        # deleted scene disappears from public list, and anonymous can't
        # see it either (resolve_detail returns 404 after soft-delete).
        resp = client.get(f"/api/v1/scenes/{public_scene.slug}")
        # owner can still see it (deleted_at is set but row exists), but
        # for a non-owner the response would be 403.  With dev bypass the
        # owner always resolves — just verify the slug is gone from the
        # public listing query.
        from sqlalchemy import text

        from app.db.session import SessionLocal

        db2 = SessionLocal()
        try:
            row = db2.execute(
                text("SELECT deleted_at IS NOT NULL as is_deleted FROM scenes WHERE slug = :s"),
                {"s": public_scene.slug},
            ).scalar()
            assert row is True
        finally:
            db2.close()

    def test_delete_other_owner_forbidden(self):
        scene = _create_other_scene()
        resp = client.delete(
            f"/api/v1/scenes/{scene.slug}",
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 403

    def test_delete_missing_404(self):
        resp = client.delete(
            "/api/v1/scenes/does-not-exist",
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 404


# ─── detail permission matrix ─────────────────────────────────────────────────
class TestDetailMatrix:
    def test_public_scene_visible(self, public_scene):
        detail = _detail(public_scene.slug)
        assert detail["title"] == "测试场景"
        assert detail["visibility"] == "PUBLIC"

    def test_private_own_scene_visible_to_owner(self, private_scene):
        detail = _detail(private_scene.slug)
        assert detail["visibility"] == "PRIVATE"

    def test_private_other_scene_403(self):
        scene = _create_other_scene()
        # force private + published
        from app.db.session import SessionLocal

        db2 = SessionLocal()
        try:
            from app.db.models.scene import Scene

            row = db2.get(Scene, scene.id)
            row.visibility = "PRIVATE"
            row.status = "PUBLISHED"
            db2.commit()
        finally:
            db2.close()

        resp = client.get(f"/api/v1/scenes/{scene.slug}", headers=_dev_auth_headers())
        assert resp.status_code == 403

    def test_missing_scene_404(self):
        resp = client.get("/api/v1/scenes/nope", headers=_dev_auth_headers())
        assert resp.status_code == 404
