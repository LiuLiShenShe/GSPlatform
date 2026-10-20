"""GS-NEXT-10 — scene archive/soft-delete **recovery** integration tests.

These exercise the real HTTP surface (``TestClient``) against an isolated DB and
then verify the persisted row through a *separate* database session, so nothing
is inferred from the response body alone.

Covered product defects (see docs/reports/GS_NEXT_10_RECOVERY_AND_E2E_FIX.md):

* A1 archive → *immediate* restore must succeed (the request-scoped session used
  to commit after the response was sent, so the next call read a stale row and
  got a bogus 409).
* A2 restore returns the scene to its pre-archive status (never a blanket
  PUBLISHED).
* B1 soft-deleted scenes are recoverable; the ``deleted_at`` marker is cleared.
* B2 deleted scenes are hidden by default and reachable through the recycle bin.
"""

from __future__ import annotations

import datetime
import uuid

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
H = {}  # dev-identity bypass runs automatically


def _fresh_session():
    from app.db.session import SessionLocal

    return SessionLocal()


def _row(slug: str):
    """Read the scene straight from a NEW session (server truth, not the DTO)."""
    from sqlalchemy import text

    db = _fresh_session()
    try:
        return db.execute(
            text(
                "SELECT id, status, deleted_at, archived_from_status,"
                " current_version_id FROM scenes WHERE slug = :s"
            ),
            {"s": slug},
        ).first()
    finally:
        db.close()


def _version_ids(slug: str) -> list[str]:
    from sqlalchemy import text

    db = _fresh_session()
    try:
        rows = db.execute(
            text(
                "SELECT sv.id FROM scene_versions sv JOIN scenes s"
                " ON s.id = sv.scene_id WHERE s.slug = :s ORDER BY sv.id"
            ),
            {"s": slug},
        ).fetchall()
        return [str(r[0]) for r in rows]
    finally:
        db.close()


def _make_other_owner_scene():
    from app.db.models.user import User
    from tests.conftest_scenes import create_scene

    db = _fresh_session()
    try:
        other = User(
            email=f"gsnext10-other-{uuid.uuid4().hex[:8]}@example.com",
            display_name="他人",
        )
        db.add(other)
        db.flush()
        scene = create_scene(session=db, owner_id=other.id)
        return scene.slug
    finally:
        db.close()


# ─── A. archive / restore ────────────────────────────────────────────────────
class TestArchiveRestoreRace:
    def test_archive_then_immediate_restore_succeeds(self, public_scene):
        """The exact defect: no sleep, no retry — restore right after archive."""
        slug = public_scene.slug
        assert client.post(f"/api/v1/scenes/{slug}/archive", headers=H).status_code == 200
        # Immediately, without any delay:
        resp = client.post(f"/api/v1/scenes/{slug}/restore", headers=H)
        assert resp.status_code == 200, resp.text

        row = _row(slug)
        assert row.status == "PUBLISHED"
        assert row.deleted_at is None
        assert row.archived_from_status is None

    def test_restore_returns_pre_archive_status_not_published(self, db, dev_user_id):
        """A READY scene must come back READY — never promoted to PUBLISHED."""
        from tests.conftest_scenes import create_scene

        scene = create_scene(session=db, owner_id=dev_user_id, status="READY")
        slug = scene.slug

        assert client.post(f"/api/v1/scenes/{slug}/archive", headers=H).status_code == 200
        assert _row(slug).status == "ARCHIVED"

        assert client.post(f"/api/v1/scenes/{slug}/restore", headers=H).status_code == 200
        row = _row(slug)
        assert row.status == "READY"
        assert row.archived_from_status is None

    def test_restore_live_scene_is_conflict(self, public_scene):
        """A scene that is neither archived nor deleted cannot be 'restored'."""
        resp = client.post(f"/api/v1/scenes/{public_scene.slug}/restore", headers=H)
        assert resp.status_code == 409

    def test_duplicate_archive_is_conflict(self, public_scene):
        slug = public_scene.slug
        first = client.post(f"/api/v1/scenes/{slug}/archive", headers=H)
        assert first.status_code == 200
        second = client.post(f"/api/v1/scenes/{slug}/archive", headers=H)
        assert second.status_code == 409

    def test_archive_other_owner_forbidden(self):
        slug = _make_other_owner_scene()
        assert client.post(f"/api/v1/scenes/{slug}/archive", headers=H).status_code == 403


# ─── B. soft delete / recovery ───────────────────────────────────────────────
class TestSoftDeleteRecovery:
    def test_delete_then_restore_clears_marker(self, public_scene):
        slug = public_scene.slug
        assert client.delete(f"/api/v1/scenes/{slug}", headers=H).status_code == 200
        assert _row(slug).deleted_at is not None

        resp = client.post(f"/api/v1/scenes/{slug}/restore", headers=H)
        assert resp.status_code == 200, resp.text
        row = _row(slug)
        assert row.deleted_at is None
        # A deleted PUBLISHED scene comes back PUBLISHED (status was preserved).
        assert row.status == "PUBLISHED"

    def test_duplicate_delete_is_idempotent(self, public_scene):
        """Repeated delete must not corrupt state (and must not touch jobs)."""
        slug = public_scene.slug
        assert client.delete(f"/api/v1/scenes/{slug}", headers=H).status_code == 200
        first = _row(slug).deleted_at
        # Second delete: no error, marker unchanged (not refreshed to "now").
        assert client.delete(f"/api/v1/scenes/{slug}", headers=H).status_code == 200
        assert _row(slug).deleted_at == first

    def test_duplicate_restore_after_delete_is_conflict(self, public_scene):
        """A second restore finds neither archived nor deleted → 409, not a
        silent re-write that could wipe an unrelated marker."""
        slug = public_scene.slug
        client.delete(f"/api/v1/scenes/{slug}", headers=H)
        assert client.post(f"/api/v1/scenes/{slug}/restore", headers=H).status_code == 200
        assert client.post(f"/api/v1/scenes/{slug}/restore", headers=H).status_code == 409

    def test_delete_keeps_versions_and_current_pointer(self, public_scene):
        slug = public_scene.slug
        before_versions = _version_ids(slug)
        before_current = _row(slug).current_version_id
        assert before_versions, "fixture must have a version"

        client.delete(f"/api/v1/scenes/{slug}", headers=H)
        client.post(f"/api/v1/scenes/{slug}/restore", headers=H)

        assert _version_ids(slug) == before_versions
        assert _row(slug).current_version_id == before_current

    def test_deleted_scene_hidden_by_default_and_in_recycle_bin(self, public_scene):
        slug = public_scene.slug
        client.delete(f"/api/v1/scenes/{slug}", headers=H)

        default = client.get("/api/v1/me/scenes", headers=H).json()["items"]
        assert slug not in {i["id"] for i in default}

        bin_items = client.get("/api/v1/me/scenes?status=DELETED", headers=H).json()["items"]
        entry = next(i for i in bin_items if i["id"] == slug)
        assert entry["isDeleted"] is True

        with_deleted = client.get(
            "/api/v1/me/scenes?includeDeleted=true", headers=H
        ).json()["items"]
        entry2 = next(i for i in with_deleted if i["id"] == slug)
        assert entry2["isDeleted"] is True

    def test_deleted_scene_detail_is_404_for_owner(self, public_scene):
        slug = public_scene.slug
        client.delete(f"/api/v1/scenes/{slug}", headers=H)
        assert client.get(f"/api/v1/scenes/{slug}", headers=H).status_code == 404

    def test_deleted_scene_share_link_stops_resolving(self, db, dev_user_id):
        """§五：删除后原有分享链接不得再解析到该场景（资产仍在但不外露）。"""
        from tests.conftest_scenes import create_scene

        # A share link can only be created for a non-public published scene.
        scene = create_scene(
            session=db, owner_id=dev_user_id, visibility="PRIVATE", status="PUBLISHED"
        )
        slug = scene.slug
        created = client.post(f"/api/v1/shares/scenes/{slug}", headers=H)
        assert created.status_code == 200, created.text
        token = created.json()["token"]

        assert client.get(
            f"/api/v1/shares/resolve/{token}", headers=H
        ).status_code == 200

        client.delete(f"/api/v1/scenes/{slug}", headers=H)
        assert client.get(
            f"/api/v1/shares/resolve/{token}", headers=H
        ).status_code == 404

        # Restoring brings the same link back — nothing was destroyed.
        client.post(f"/api/v1/scenes/{slug}/restore", headers=H)
        assert client.get(
            f"/api/v1/shares/resolve/{token}", headers=H
        ).status_code == 200

    def test_archived_scene_share_link_stops_resolving(self, db, dev_user_id):
        """§五：归档同理 —— 归档前可用的分享链接，归档后失效，恢复后再次可用。"""
        from tests.conftest_scenes import create_scene

        scene = create_scene(
            session=db, owner_id=dev_user_id, visibility="PRIVATE", status="PUBLISHED"
        )
        slug = scene.slug
        token = client.post(f"/api/v1/shares/scenes/{slug}", headers=H).json()["token"]
        client.post(f"/api/v1/scenes/{slug}/archive", headers=H)
        # The link row survives but no longer grants access (403, not 200).
        assert client.get(
            f"/api/v1/shares/resolve/{token}", headers=H
        ).status_code == 403
        client.post(f"/api/v1/scenes/{slug}/restore", headers=H)
        assert client.get(
            f"/api/v1/shares/resolve/{token}", headers=H
        ).status_code == 200

    def test_public_scene_leaves_and_returns_to_public_catalogue(self, db, dev_user_id):
        """§五：归档移出公开目录，恢复后按原 visibility/status 回到公开目录。

        The dev-identity bypass authenticates *every* request as the owner, so
        the owner-readable detail endpoint cannot express "public".  Use the
        public list (PUBLIC + PUBLISHED + not deleted) with cursor paging.
        """
        from tests.conftest_scenes import create_scene

        def in_public_catalogue(slug: str) -> bool:
            cursor: str | None = None
            for _ in range(50):  # bounded: ~50 * 100 scenes
                url = "/api/v1/scenes?limit=100"
                if cursor:
                    url += f"&cursor={cursor}"
                page = client.get(url, headers=H).json()
                if any(i["id"] == slug for i in page["items"]):
                    return True
                cursor = page["meta"]["nextCursor"]
                if not cursor:
                    return False
            return False

        scene = create_scene(
            session=db, owner_id=dev_user_id, status="PUBLISHED", visibility="PUBLIC"
        )
        # Public catalogue ordering is by published_at DESC NULLS LAST; a NULL
        # row would sort outside the bounded cursor walk below.
        scene.published_at = datetime.datetime.now(datetime.UTC)
        db.commit()
        slug = scene.slug
        assert in_public_catalogue(slug)

        client.post(f"/api/v1/scenes/{slug}/archive", headers=H)
        assert not in_public_catalogue(slug)

        client.post(f"/api/v1/scenes/{slug}/restore", headers=H)
        assert in_public_catalogue(slug)
        # 状态/可见性按归档前语义恢复，不是被强制改写成别的值。
        detail = client.get(f"/api/v1/scenes/{slug}", headers=H).json()
        assert detail["visibility"] == "PUBLIC"
        assert detail["status"] == "PUBLISHED"

    def test_restore_after_delete_makes_scene_readable_again(self, public_scene):
        slug = public_scene.slug
        client.delete(f"/api/v1/scenes/{slug}", headers=H)
        client.post(f"/api/v1/scenes/{slug}/restore", headers=H)
        resp = client.get(f"/api/v1/scenes/{slug}", headers=H)
        assert resp.status_code == 200
        assert resp.json()["isDeleted"] is False

    def test_other_user_cannot_restore_or_see_deleted(self, db):
        """A soft-deleted scene stays private to its owner."""
        slug = _make_other_owner_scene()
        # The dev user is not the owner → delete must be forbidden, so create the
        # deleted state directly (owner-scoped) and assert the non-owner is shut out.
        from sqlalchemy import text

        s = _fresh_session()
        try:
            s.execute(
                text("UPDATE scenes SET deleted_at = :d WHERE slug = :s"),
                {"d": datetime.datetime.now(datetime.UTC), "s": slug},
            )
            s.commit()
        finally:
            s.close()

        assert client.post(f"/api/v1/scenes/{slug}/restore", headers=H).status_code == 403
        assert client.get(f"/api/v1/scenes/{slug}", headers=H).status_code == 404

    def test_delete_with_active_job_refused(self, db, dev_user_id):
        from app.db.models.job import Job
        from tests.conftest_scenes import create_scene

        scene = create_scene(session=db, owner_id=dev_user_id)
        db.add(
            Job(
                scene_id=scene.id,
                owner_id=dev_user_id,
                kind="BUILD_STREAMED_SOG",
                status="RUNNING",
            )
        )
        db.commit()

        resp = client.delete(f"/api/v1/scenes/{scene.slug}", headers=H)
        assert resp.status_code == 409
        assert _row(scene.slug).deleted_at is None
