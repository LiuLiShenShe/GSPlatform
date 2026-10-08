"""FIX-UPLOAD-01 §7-§11 — auto-collision after publish + current-version binding.

Problem B (§7-§9): a publish that reaches SUCCEEDED must chain an automatic
collision build (create/reuse CollisionAsset+Job → DB commit → send_task).  The
scene stays PUBLISHED even when collision dispatch fails (publish success is
never coupled to collision success).

Problem C (§C / §11): the collision must be generated from the scene's CURRENT
version (``Scene.current_version_id``'s SOG asset), never an old version's asset
picked by ``created_at DESC``; the persistent ``sourceVersion`` binding is
recorded on the build so an old-version collision can never masquerade as the
current one.
"""

from __future__ import annotations

import uuid

from app.db.models.enums import JobKind, JobStatus
from app.db.models.job import Job


# ── shared helper: fake send_task recorder ──────────────────────────────────
class _FakeTaskResult:
    def __init__(self, task_id: str) -> None:
        self.id = task_id


class _SendTaskRecorder:
    """Records every dispatched task (name + args), no real broker."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, list[str]]] = []
        self.fail = False
        self._n = 0

    def __call__(self, name: str, *, args: list[str] | None = None) -> _FakeTaskResult:
        if self.fail:
            raise RuntimeError("broker unavailable (simulated)")
        self._n += 1
        self.calls.append((name, args or []))
        return _FakeTaskResult(f"celery-{self._n}")


def _make_collision_service(db, recorder):
    from app.core.config import settings
    from app.services.collision import CollisionService
    from app.storage import LocalDiskStorage

    # Test storage root: the real configured root (never a temp path).
    return CollisionService(
        db, LocalDiskStorage(settings.storage_root), send_task=recorder
    )


def _published_scene(db, dev_user_id):
    """A PUBLISHED scene with a current version, owned by the dev user."""
    from tests.conftest_scenes import create_scene

    return create_scene(session=db, owner_id=dev_user_id)


# ─────────────────────────────────────────────────────────────────────────────
# Problem B — auto-collision dispatch after publish
# ─────────────────────────────────────────────────────────────────────────────
class TestAutoCollisionDispatch:
    def test_dispatch_creates_collision_job_and_sends_task(self, db, dev_user_id):
        scene = _published_scene(db, dev_user_id)
        recorder = _SendTaskRecorder()
        svc = _make_collision_service(db, recorder)

        response = svc.dispatch_auto_collision(scene.id, dev_user_id)

        assert response is not None
        assert response.status == "QUEUED"
        # A BUILD_COLLISION job row must exist for the scene.
        job = (
            db.query(Job)
            .filter(Job.scene_id == scene.id, Job.kind == JobKind.BUILD_COLLISION.value)
            .one_or_none()
        )
        assert job is not None
        assert response.job_id == str(job.id)
        # Exactly one task dispatch, with the full arg contract.
        assert len(recorder.calls) == 1
        name, args = recorder.calls[0]
        assert name == "tasks.build_collision"
        assert args[0] == response.job_id
        assert args[1] == str(scene.id)
        assert args[4] is None or len(args[4]) == 16  # world hash (or None)
        # Collision row exists and is bound to the current version.
        from app.db.models.collision_asset import CollisionAsset

        coll = db.query(CollisionAsset).filter(CollisionAsset.scene_id == scene.id).one()
        assert coll.status == "QUEUED"
        assert coll.job_id == job.id
        assert coll.build_params["sourceVersion"] == scene.current_version.asset_version

    def test_dispatch_idempotent_same_version_succeeded(self, db, dev_user_id):
        """SUCCEEDED + same sourceVersion → reuse, no new job dispatched."""
        scene = _published_scene(db, dev_user_id)
        recorder = _SendTaskRecorder()
        svc = _make_collision_service(db, recorder)
        first = svc.dispatch_auto_collision(scene.id, dev_user_id)
        assert first is not None

        # Simulate the worker completing the build (bind to current version).
        from app.db.models.collision_asset import CollisionAsset

        coll = db.query(CollisionAsset).filter(CollisionAsset.scene_id == scene.id).one()
        coll.status = "SUCCEEDED"
        db.commit()

        second = svc.dispatch_auto_collision(scene.id, dev_user_id)
        assert second is not None
        assert second.status == "SUCCEEDED"  # reused
        # No second job / task.
        jobs = (
            db.query(Job)
            .filter(Job.scene_id == scene.id, Job.kind == JobKind.BUILD_COLLISION.value)
            .all()
        )
        assert len(jobs) == 1
        assert len(recorder.calls) == 1

    def test_dispatch_no_duplicate_while_running(self, db, dev_user_id):
        scene = _published_scene(db, dev_user_id)
        recorder = _SendTaskRecorder()
        svc = _make_collision_service(db, recorder)
        first = svc.dispatch_auto_collision(scene.id, dev_user_id)
        assert first is not None and first.status == "QUEUED"

        second = svc.dispatch_auto_collision(scene.id, dev_user_id)
        assert second is not None and second.status == "QUEUED"
        assert len(recorder.calls) == 1  # no stacked job
        jobs = (
            db.query(Job)
            .filter(Job.scene_id == scene.id, Job.kind == JobKind.BUILD_COLLISION.value)
            .all()
        )
        assert len(jobs) == 1

    def test_failed_collision_is_retried(self, db, dev_user_id):
        scene = _published_scene(db, dev_user_id)
        recorder = _SendTaskRecorder()
        svc = _make_collision_service(db, recorder)
        first = svc.dispatch_auto_collision(scene.id, dev_user_id)
        assert first is not None

        from app.db.models.collision_asset import CollisionAsset

        coll = db.query(CollisionAsset).filter(CollisionAsset.scene_id == scene.id).one()
        coll.status = "FAILED"
        db.commit()

        second = svc.dispatch_auto_collision(scene.id, dev_user_id)
        assert second is not None and second.status == "QUEUED"
        assert len(recorder.calls) == 2  # retry dispatches a new task
        jobs = (
            db.query(Job)
            .filter(Job.scene_id == scene.id, Job.kind == JobKind.BUILD_COLLISION.value)
            .all()
        )
        assert len(jobs) == 2
        assert all(j.status == JobStatus.QUEUED.value for j in jobs) or any(
            j.status == JobStatus.QUEUED.value for j in jobs
        )

    def test_new_version_invalidates_old_collision(self, db, dev_user_id):
        """A SUCCEEDED collision bound to an OLD version must be reported STALE
        (never masquerade as the current collision) and rebuilt for the new
        current version on the next auto-dispatch."""
        scene = _published_scene(db, dev_user_id)
        recorder = _SendTaskRecorder()
        svc = _make_collision_service(db, recorder)
        svc.dispatch_auto_collision(scene.id, dev_user_id)

        from app.db.models.collision_asset import CollisionAsset
        from app.db.models.scene import SceneVersion

        coll = db.query(CollisionAsset).filter(CollisionAsset.scene_id == scene.id).one()
        coll.status = "SUCCEEDED"
        # New publish → new current version (different asset_version).
        new_version = SceneVersion(
            scene_id=scene.id,
            asset_version="new-version-content-key",
            format="streamed-sog",
            size_bytes=123,
            manifest={"stream": {"counts": [1, 1, 1]}},
        )
        db.add(new_version)
        db.flush()
        scene.current_version_id = new_version.id
        db.commit()

        # The SUCCEEDED collision is now bound to the OLD version → STALE.
        payload = svc.get_collision(scene.slug, dev_user_id)
        assert payload.status == "SUCCEEDED"
        assert payload.stale is True

        # Auto-dispatch rebuilds for the new version.
        response = svc.dispatch_auto_collision(scene.id, dev_user_id)
        assert response is not None and response.status == "QUEUED"
        coll = db.query(CollisionAsset).filter(CollisionAsset.scene_id == scene.id).one()
        assert coll.status == "QUEUED"  # being rebuilt for the new version

    def test_dispatch_failure_fails_only_collision(self, db, dev_user_id):
        """Broker dispatch failure → collision FAILED + stable code; the scene
        must stay PUBLISHED and no broker detail leaks."""
        scene = _published_scene(db, dev_user_id)
        recorder = _SendTaskRecorder()
        recorder.fail = True
        svc = _make_collision_service(db, recorder)

        response = svc.dispatch_auto_collision(scene.id, dev_user_id)
        assert response is not None and response.status == "FAILED"

        from app.db.models.collision_asset import CollisionAsset

        coll = db.query(CollisionAsset).filter(CollisionAsset.scene_id == scene.id).one()
        assert coll.status == "FAILED"
        job = (
            db.query(Job)
            .filter(Job.id == coll.job_id)
            .one()
        )
        assert job.status == JobStatus.FAILED.value
        assert job.error_code == "COLLISION_DISPATCH_FAILED"
        # Scene untouched.
        assert scene.status == "PUBLISHED"
        assert "broker" not in (job.error_message_safe or "").lower()
        assert "RuntimeError" not in (job.error_message_safe or "")

    def test_unpublished_scene_returns_none(self, db, dev_user_id):
        from tests.conftest_scenes import create_scene

        scene = create_scene(
            session=db, owner_id=dev_user_id, status="PROCESSING", with_version=False
        )
        recorder = _SendTaskRecorder()
        svc = _make_collision_service(db, recorder)
        assert svc.dispatch_auto_collision(scene.id, dev_user_id) is None
        assert len(recorder.calls) == 0


# ─────────────────────────────────────────────────────────────────────────────
# §12/§13 — publish chain → auto-collision; publish success ≠ collision success
# ─────────────────────────────────────────────────────────────────────────────
class TestPublishChainsCollision:
    """The publish flow that dispatches the chain is exercised end-to-end in the
    §21 real E2E (real worker + real artifacts).  Here we lock the contract of
    the chaining API: once a scene reaches PUBLISHED with a current version, the
    auto-dispatch creates a collision for that version; publish state stays
    PUBLISHED even when collision dispatch fails."""

    def test_auto_dispatch_after_publish_leaves_scene_published(self, db, dev_user_id):
        scene = _published_scene(db, dev_user_id)
        recorder = _SendTaskRecorder()
        svc = _make_collision_service(db, recorder)
        response = svc.dispatch_auto_collision(scene.id, dev_user_id)
        assert response is not None and response.status == "QUEUED"
        assert scene.status == "PUBLISHED"
        from app.db.models.collision_asset import CollisionAsset

        coll = db.query(CollisionAsset).filter(CollisionAsset.scene_id == scene.id).one()
        assert coll.build_params["sourceVersion"] == scene.current_version.asset_version

    def test_publish_success_survives_collision_dispatch_failure(self, db, dev_user_id):
        scene = _published_scene(db, dev_user_id)
        recorder = _SendTaskRecorder()
        recorder.fail = True
        svc = _make_collision_service(db, recorder)
        response = svc.dispatch_auto_collision(scene.id, dev_user_id)
        assert response is not None and response.status == "FAILED"
        assert scene.status == "PUBLISHED"
        from app.db.models.collision_asset import CollisionAsset

        coll = db.query(CollisionAsset).filter(CollisionAsset.scene_id == scene.id).one()
        assert coll.status == "FAILED"


# ─────────────────────────────────────────────────────────────────────────────
# §14 — collision artifact serving: 200 for real artifacts, 404 for absent
# ─────────────────────────────────────────────────────────────────────────────
class TestArtifactServe:
    def test_serve_missing_collisions_404(self, public_scene):
        client = _test_client()
        slug = public_scene.slug
        for path in (
            f"/api/v1/scenes/{slug}/collision/collision.voxel.json",
            f"/api/v1/scenes/{slug}/collision/collision.voxel.bin",
            f"/api/v1/scenes/{slug}/collision/collision.glb",
            f"/api/v1/scenes/{slug}/collision",
        ):
            resp = client.get(
                path,
                headers={"X-Test-Identity-User": str(public_scene.owner_id)},
            )
            assert resp.status_code == 404, f"{path} should be 404 without assets"
        client.close()

    def test_serve_real_voxel_artifacts_200(self, db, public_scene):
        """Real voxel.json/.bin + glb in the collision dir are served 200."""
        from pathlib import Path

        from app.core.config import settings

        out_root = Path(settings.storage_root) / "collision" / str(public_scene.id)
        out_root.mkdir(parents=True, exist_ok=True)
        (out_root / "collision.voxel.json").write_text(
            '{"nodeCount":1,"gridBounds":{"min":[-1,-1,-1],"max":[1,1,1]}}',
            encoding="utf-8",
        )
        (out_root / "collision.voxel.bin").write_bytes(b"\x00\x01\x02\x03")
        (out_root / "collision.glb").write_bytes(b"glTF" + b"\x00" * 16)

        # The serve path derives the key from the collision asset row; create
        # the rows the service reads.
        from app.db.models.asset import Asset
        from app.db.models.collision_asset import CollisionAsset

        voxel_asset = Asset(
            scene_id=public_scene.id,
            kind="COLLISION_VOXEL",
            storage_key=f"collision/{public_scene.id}/collision.voxel.json",
            mime_type="application/json",
            byte_size=(out_root / "collision.voxel.json").stat().st_size,
            metadata_={"binStorageKey": f"collision/{public_scene.id}/collision.voxel.bin"},
        )
        glb_asset = Asset(
            scene_id=public_scene.id,
            kind="COLLISION_GLB",
            storage_key=f"collision/{public_scene.id}/collision.glb",
            mime_type="model/gltf-binary",
            byte_size=(out_root / "collision.glb").stat().st_size,
        )
        db.add_all([voxel_asset, glb_asset])
        db.flush()
        db.add(
            CollisionAsset(
                scene_id=public_scene.id,
                mode="OUTDOOR",
                asset_id=voxel_asset.id,
                status="SUCCEEDED",
                gravity=9.81,
                slope_limit_degrees=45.0,
                step_offset=0.3,
                player_height=1.8,
                build_params={"sourceVersion": public_scene.current_version.asset_version},
            )
        )
        db.commit()

        client = _test_client()
        slug = public_scene.slug
        for path in (
            f"/api/v1/scenes/{slug}/collision/collision.voxel.json",
            f"/api/v1/scenes/{slug}/collision/collision.voxel.bin",
            f"/api/v1/scenes/{slug}/collision/collision.glb",
        ):
            resp = client.get(path, headers={"X-Test-Identity-User": str(public_scene.owner_id)})
            assert resp.status_code == 200, f"{path} should serve 200"
            assert resp.headers["Cache-Control"]
        client.close()


# ─────────────────────────────────────────────────────────────────────────────
# §15/§16 — read-only status surface (scene identity + segregated job states)
# ─────────────────────────────────────────────────────────────────────────────
class TestUploadStatusSurface:
    def test_status_reports_scene_and_both_jobs(self, db, dev_user_id):
        """GET /uploads/{id}/status exposes sceneId/slug + publish + collision
        job states, owner-authenticated, no storage keys."""
        from app.db.models.enums import UploadSessionStatus
        from app.db.models.upload_session import UploadSession

        scene = _published_scene(db, dev_user_id)
        pub_job = (
            db.query(Job)
            .filter(Job.scene_id == scene.id, Job.kind == JobKind.PUBLISH.value)
            .first()
        )
        # An upload session linked to the scene.
        from datetime import UTC, datetime, timedelta

        us = UploadSession(
            id=uuid.uuid4(),
            owner_id=dev_user_id,
            scene_id=scene.id,
            status=UploadSessionStatus.SUCCEEDED.value,
            storage_key=f"staging/{uuid.uuid4()}/upload.bin",
            mime_type="application/json",
            upload_format="sog",
            offset=0,
            total_size=10,
            expires_at=datetime.now(UTC) + timedelta(hours=24),
            title="t",
            description=None,
            visibility="PRIVATE",
            category="experiment",
            purpose="PUBLISH",
        )
        db.add(us)
        db.commit()

        # The real flow creates the PUBLISH job at complete; reproduce it here
        # so the status surface has a publish state to report.
        if pub_job is None:
            from app.db.models.enums import JobKind as _JK
            from app.db.models.enums import JobStatus as _JS
            from app.db.models.job import Job as _Job

            pub_job = _Job(
                scene_id=scene.id,
                owner_id=dev_user_id,
                kind=_JK.PUBLISH.value,
                status=_JS.SUCCEEDED.value,
                progress=100,
            )
            db.add(pub_job)
            db.commit()

        # Build a collision job too (simulate auto-dispatch ran).
        recorder = _SendTaskRecorder()
        svc = _make_collision_service(db, recorder)
        svc.dispatch_auto_collision(scene.id, dev_user_id)

        from fastapi.testclient import TestClient

        from app.main import app

        client = TestClient(app)
        resp = client.get(f"/api/v1/uploads/{us.id}/status")
        assert resp.status_code == 200
        data = resp.json()
        assert data["sceneId"] == str(scene.id)
        assert data["sceneSlug"] == scene.slug
        assert data["publishJobId"] == str(pub_job.id if pub_job else "")
        assert data["publishStatus"] in (None, "QUEUED", "RUNNING", "SUCCEEDED")
        assert data["collisionJobId"]
        assert data["collisionStatus"] == "QUEUED"
        payload = resp.text
        assert "storage_key" not in payload
        assert "_path" not in payload
        client.close()

    def test_status_404_for_other_user(self, db, dev_user_id):
        """Owner-auth: an upload not owned by the caller is 404 (not data leak)."""
        from datetime import UTC, datetime, timedelta

        from app.db.models.enums import UploadSessionStatus as USS
        from app.db.models.upload_session import UploadSession
        from app.db.models.user import User

        other = User(
            email=f"other-{uuid.uuid4().hex[:8]}@example.test",
            password_hash="x",
            display_name="other",
            is_active=True,
        )
        db.add(other)
        db.flush()

        us = UploadSession(
            id=uuid.uuid4(),
            owner_id=other.id,
            status=USS.CREATED.value,
            storage_key=f"staging/{uuid.uuid4()}/upload.bin",
            mime_type="application/json",
            upload_format="sog",
            offset=0,
            total_size=10,
            expires_at=datetime.now(UTC) + timedelta(hours=24),
            title="t",
            description=None,
            visibility="PRIVATE",
            category="experiment",
            purpose="PUBLISH",
        )
        db.add(us)
        db.commit()
        # The dev-identity bypass always acts as the dev user, who does not own
        # this session → 404.
        from fastapi.testclient import TestClient

        from app.main import app

        client = TestClient(app)
        resp = client.get(f"/api/v1/uploads/{us.id}/status")
        assert resp.status_code == 404
        client.close()


def _test_client():
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app)


# Problem C tests (worker ``_find_sog_asset`` selection + worker SUCCEEDED
# version binding) live in ``workers/tests/test_build_collision_version.py`` —
# the ``workers`` package is only importable from the workers test path.
