"""FIX-UPLOAD-01.1 §B/§C — post-publish recovery + collision version isolation.

RED-first tests for the three defects:

* **§B (crash window / P1-B)** — ``publish_scene`` commits the publish SUCCEEDED
  and *then* chains the auto collision.  A crash in between (or before the
  broker send was confirmed) leaves a PUBLISHED scene with **no** collision job
  at all, or a job whose dispatch was never confirmed.  Celery redelivery alone
  does not cover it (the publish task may already be acknowledged).  Recovery
  therefore rides the already-scheduled ``tasks.cleanup_expired_uploads`` timer
  via :meth:`CollisionService.reconcile_auto_collision`.
* **§C (concurrency / P1-C)** — every collision-mutating entry point (auto
  dispatch, manual build, rebuild) must serialize on the scene row lock, pin the
  source version onto the job, and keep per-job output directories so a stale
  worker can neither overwrite a newer build's assets nor fail a newer job.
* **§C (serving)** — the artifact endpoints must resolve *the same build's*
  job-scoped assets, never ``ORDER BY created_at DESC`` guesswork.

Everything runs against the real PostgreSQL test database (no SQLite).
"""

from __future__ import annotations

import threading
from pathlib import Path

from app.db.models.enums import JobKind, JobStatus
from app.db.models.job import Job


# ── shared helpers ───────────────────────────────────────────────────────────
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
        self.calls.append((name, list(args or [])))
        return _FakeTaskResult(f"celery-{self._n}")


def _svc(db, recorder):
    from app.core.config import settings
    from app.services.collision import CollisionService
    from app.storage import LocalDiskStorage

    return CollisionService(db, LocalDiskStorage(settings.storage_root), send_task=recorder)


def _scene(db, dev_user_id):
    from tests.conftest_scenes import create_scene

    return create_scene(session=db, owner_id=dev_user_id)


def _dispatches_for(recorder, scene_id) -> list[list[str]]:
    """Dispatched task args belonging to ``scene_id`` only.

    ``reconcile_auto_collision`` is a global scan (that is the point of the
    scheduled maintenance); the shared dev DB keeps scenes from earlier runs,
    so assertions scope to this test's scene.
    """
    return [args for _name, args in recorder.calls if len(args) >= 2 and args[1] == str(scene_id)]


def _collision_row(db, scene_id):
    from app.db.models.collision_asset import CollisionAsset

    return (
        db.query(CollisionAsset).filter(CollisionAsset.scene_id == scene_id).all()
    )


def _build_jobs(db, scene_id):
    return (
        db.query(Job)
        .filter(Job.scene_id == scene_id, Job.kind == JobKind.BUILD_COLLISION.value)
        .order_by(Job.created_at.asc())
        .all()
    )


def _publish_new_version(db, scene, asset_version: str):
    """Publish a new content-addressed SceneVersion and make it current."""
    from app.db.models.scene import SceneVersion

    ver = SceneVersion(
        scene_id=scene.id,
        asset_version=asset_version,
        format="streamed-sog",
        size_bytes=2048,
        manifest={"stream": {"counts": [1, 2, 3]}},
    )
    db.add(ver)
    db.flush()
    scene.current_version_id = ver.id
    db.commit()
    db.refresh(scene)
    return ver


def _write_collision_files(root: Path) -> dict[str, str]:
    """Write a real voxel json/bin + glb pair under ``root``; return storage keys."""
    import json

    root.mkdir(parents=True, exist_ok=True)
    (root / "collision.voxel.json").write_text(
        json.dumps({"nodeCount": 1, "gridBounds": {"min": [-1, -1, -1], "max": [1, 1, 1]}}),
        encoding="utf-8",
    )
    (root / "collision.voxel.bin").write_bytes(b"\x00\x01\x02\x03")
    (root / "collision.glb").write_bytes(b"glTF" + b"\x00" * 16)
    rel = root.relative_to(Path(_storage_root())).as_posix()
    return {
        "voxel_json": f"{rel}/collision.voxel.json",
        "voxel_bin": f"{rel}/collision.voxel.bin",
        "glb": f"{rel}/collision.glb",
    }


def _storage_root() -> Path:
    from app.core.config import settings

    return Path(settings.storage_root)


# ─────────────────────────────────────────────────────────────────────────────
# §B1 — the publish→collision crash window is recoverable
# ─────────────────────────────────────────────────────────────────────────────
class TestPostPublishRecovery:
    def test_published_scene_without_collision_row_gets_one(self, db, dev_user_id):
        """A PUBLISHED scene with a current version but NO CollisionAsset (the
        publish worker crashed right after committing the publish) is repaired
        by the scheduled reconcile: exactly one collision row, one QUEUED job,
        one dispatch whose source version is pinned."""
        scene = _scene(db, dev_user_id)
        assert _collision_row(db, scene.id) == []

        recorder = _SendTaskRecorder()
        svc = _svc(db, recorder)
        report = svc.reconcile_auto_collision()

        assert report["ok"] is True
        assert report["scenes_checked"] >= 1
        colls = _collision_row(db, scene.id)
        assert len(colls) == 1
        assert colls[0].status == "QUEUED"
        jobs = _build_jobs(db, scene.id)
        assert len(jobs) == 1
        assert jobs[0].status == JobStatus.QUEUED.value
        scene_dispatches = _dispatches_for(recorder, scene.id)
        assert len(scene_dispatches) == 1
        name, args = "tasks.build_collision", scene_dispatches[0]
        assert name == "tasks.build_collision"
        # §D version contract: source version pinned as the 6th task arg.
        assert args[5] == str(scene.current_version_id)

    def test_dispatch_unconfirmed_job_is_resent_not_duplicated(
        self, db, dev_user_id
    ):
        """Crash window: the collision+job rows committed but the broker send
        never got confirmed (``celery_task_id`` NULL).  Recovery re-sends the
        SAME job — never a second job."""
        scene = _scene(db, dev_user_id)
        recorder = _SendTaskRecorder()
        svc = _svc(db, recorder)
        svc.ensure_auto_collision_for_current_version(scene.id, dev_user_id)
        coll = _collision_row(db, scene.id)[0]
        job = db.query(Job).filter(Job.id == coll.job_id).one()
        # Simulate: send_task crashed before celery_task_id was persisted.
        job.celery_task_id = None
        db.commit()
        recorder.calls.clear()

        svc.reconcile_auto_collision()

        jobs = _build_jobs(db, scene.id)
        assert len(jobs) == 1, "no duplicate collision job"
        assert jobs[0].id == job.id, "the same job is re-sent"
        assert jobs[0].celery_task_id is not None, "dispatch is now confirmed"
        assert len(_dispatches_for(recorder, scene.id)) == 1

    def test_collision_row_with_missing_job_gets_job(self, db, dev_user_id):
        """Dispatch row exists but its Job row is gone (partial crash): the
        reconcile creates the missing job and dispatches it."""
        from app.db.models.collision_asset import CollisionAsset

        scene = _scene(db, dev_user_id)
        coll = CollisionAsset(
            scene_id=scene.id, mode="OUTDOOR", status="QUEUED", gravity=9.81,
            slope_limit_degrees=45.0, step_offset=0.3, player_height=1.8,
            attempt=1,
        )
        db.add(coll)
        db.commit()

        recorder = _SendTaskRecorder()
        svc = _svc(db, recorder)
        svc.reconcile_auto_collision()

        assert len(_build_jobs(db, scene.id)) == 1
        assert len(_dispatches_for(recorder, scene.id)) == 1
        assert coll.job_id is not None

    def test_broker_failure_marks_dispatch_incomplete_then_recovers(
        self, db, dev_user_id
    ):
        """Dispatch raised → job FAILED with COLLISION_DISPATCH_FAILED and no
        celery_task_id.  That is a *dispatch-incomplete* state, so the
        scheduled reconcile retries it; the scene is never un-published."""
        scene = _scene(db, dev_user_id)
        recorder = _SendTaskRecorder()
        recorder.fail = True
        svc = _svc(db, recorder)
        resp = svc.ensure_auto_collision_for_current_version(scene.id, dev_user_id)
        assert resp is not None and resp.status == "FAILED"
        db.refresh(scene)
        assert scene.status == "PUBLISHED"
        # Broker healthy on the retry pass.
        recorder.fail = False
        recorder.calls.clear()
        svc.reconcile_auto_collision()
        assert len(_dispatches_for(recorder, scene.id)) == 1
        # The SAME job row is re-sent (dispatch was never confirmed) — no dupe.
        assert len(_build_jobs(db, scene.id)) == 1
        assert _build_jobs(db, scene.id)[0].celery_task_id is not None

    def test_dispatched_failure_is_left_for_manual_retry(self, db, dev_user_id):
        """A FAILED collision whose job WAS confirmed delivered is a genuine
        build failure — the reconcile must not resurrect it (automatic retry of
        dispatched work needs its own cap/backoff).  Manual rebuild stays."""
        scene = _scene(db, dev_user_id)
        recorder = _SendTaskRecorder()
        svc = _svc(db, recorder)
        svc.ensure_auto_collision_for_current_version(scene.id, dev_user_id)
        coll = _collision_row(db, scene.id)[0]
        job = db.query(Job).filter(Job.id == coll.job_id).one()
        coll.status = "FAILED"
        coll.error_message = "boom"
        job.status = JobStatus.FAILED.value
        job.error_code = "COLLISION_BUILD_FAILED"
        db.commit()
        recorder.calls.clear()

        svc.reconcile_auto_collision()

        assert (
            _dispatches_for(recorder, scene.id) == []
        ), "no automatic retry of a delivered failure"
        assert len(_build_jobs(db, scene.id)) == 1
        coll = _collision_row(db, scene.id)[0]
        assert coll.status == "FAILED"

    def test_stale_succeeded_collision_is_rebuilt_for_current_version(
        self, db, dev_user_id
    ):
        """A SUCCEEDED collision bound to an OLD version is never served as the
        current one; the reconcile rebuilds it for the scene's current version."""
        scene = _scene(db, dev_user_id)
        recorder = _SendTaskRecorder()
        svc = _svc(db, recorder)
        svc.ensure_auto_collision_for_current_version(scene.id, dev_user_id)
        coll = _collision_row(db, scene.id)[0]
        coll.status = "SUCCEEDED"
        coll.build_params = dict(coll.build_params or {})
        coll.build_params["sourceVersion"] = scene.current_version.asset_version
        db.commit()
        # New publish → new current version.
        new_ver = _publish_new_version(db, scene, "rebuilt-version-key")
        recorder.calls.clear()

        svc.reconcile_auto_collision()

        coll = _collision_row(db, scene.id)[0]
        assert coll.status == "QUEUED"
        assert coll.build_params["sourceVersion"] == new_ver.asset_version
        scene_dispatches = _dispatches_for(recorder, scene.id)
        assert len(scene_dispatches) == 1
        assert scene_dispatches[0][5] == str(new_ver.id)

    def test_healthy_scene_is_left_untouched(self, db, dev_user_id):
        """A SUCCEEDED collision for the current version with a SUCCEEDED job
        is the healthy steady state: no dispatch, no mutation."""
        scene = _scene(db, dev_user_id)
        recorder = _SendTaskRecorder()
        svc = _svc(db, recorder)
        svc.ensure_auto_collision_for_current_version(scene.id, dev_user_id)
        coll = _collision_row(db, scene.id)[0]
        coll.status = "SUCCEEDED"
        coll.build_params = dict(coll.build_params or {})
        coll.build_params["sourceVersion"] = scene.current_version.asset_version
        job = db.query(Job).filter(Job.id == coll.job_id).one()
        job.status = JobStatus.SUCCEEDED.value
        db.commit()
        recorder.calls.clear()

        svc.reconcile_auto_collision()

        assert _dispatches_for(recorder, scene.id) == []
        coll = _collision_row(db, scene.id)[0]
        assert coll.status == "SUCCEEDED"

    def test_unpublished_scene_is_ignored(self, db, dev_user_id):
        from tests.conftest_scenes import create_scene

        scene = create_scene(
            session=db, owner_id=dev_user_id, status="PROCESSING", with_version=False
        )
        recorder = _SendTaskRecorder()
        svc = _svc(db, recorder)
        svc.reconcile_auto_collision()
        assert _dispatches_for(recorder, scene.id) == []
        assert _collision_row(db, scene.id) == []


# ─────────────────────────────────────────────────────────────────────────────
# §B — crash-point database assertions (nothing is duplicated or rolled back)
# ─────────────────────────────────────────────────────────────────────────────
class TestCrashPointInvariants:
    def test_recovery_does_not_duplicate_versions_or_publish_jobs(
        self, db, dev_user_id
    ):
        """After a publish→collision crash and a full reconcile the database has
        exactly one SceneVersion, one PUBLISH job, one valid collision job and
        the scene is still PUBLISHED."""
        from app.db.models.scene import SceneVersion

        scene = _scene(db, dev_user_id)
        # A real PUBLISH job (the crashed publish).
        pub_job = Job(
            scene_id=scene.id, owner_id=dev_user_id, kind=JobKind.PUBLISH.value,
            status=JobStatus.SUCCEEDED.value, progress=100,
        )
        db.add(pub_job)
        db.commit()

        recorder = _SendTaskRecorder()
        svc = _svc(db, recorder)
        svc.reconcile_auto_collision()
        svc.reconcile_auto_collision()  # idempotent even when run twice

        assert db.query(SceneVersion).filter(SceneVersion.scene_id == scene.id).count() == 1
        assert db.query(Job).filter(
            Job.scene_id == scene.id, Job.kind == JobKind.PUBLISH.value
        ).count() == 1
        assert len(_build_jobs(db, scene.id)) == 1
        db.refresh(scene)
        assert scene.status == "PUBLISHED"
        # Ran twice → only the first pass dispatched.
        assert len(_dispatches_for(recorder, scene.id)) == 1


# ─────────────────────────────────────────────────────────────────────────────
# §C — serving resolves the same build's job-scoped assets
# ─────────────────────────────────────────────────────────────────────────────
class TestJobScopedServing:
    def _build_two_builds(self, db, scene):
        """Give the scene a current collision bound to job B, whose artifacts
        exist under job B's directory; job A's (older) artifacts were created
        LATER so ``created_at DESC`` would pick the wrong build."""
        from app.db.models.asset import Asset
        from app.db.models.collision_asset import CollisionAsset

        job_a = Job(
            scene_id=scene.id, owner_id=scene.owner_id,
            kind=JobKind.BUILD_COLLISION.value, status=JobStatus.SUCCEEDED.value,
        )
        job_b = Job(
            scene_id=scene.id, owner_id=scene.owner_id,
            kind=JobKind.BUILD_COLLISION.value, status=JobStatus.SUCCEEDED.value,
        )
        db.add_all([job_a, job_b])
        db.flush()

        ver = scene.current_version_id
        base = _storage_root() / "collision" / str(scene.id) / "versions"
        keys_a = _write_collision_files(
            base / "old" / "jobs" / str(job_a.id)
        )
        keys_b = _write_collision_files(
            base / "new" / "jobs" / str(job_b.id)
        )

        def _asset(kind, key, meta, version_id):
            return Asset(
                scene_id=scene.id, version_id=version_id, kind=kind,
                storage_key=key, mime_type="application/json",
                byte_size=_storage_root().joinpath(key).stat().st_size,
                metadata_=meta,
            )

        # Job A rows are created AFTER job B rows → created_at DESC picks A.
        voxel_b = _asset(
            "COLLISION_VOXEL", keys_b["voxel_json"],
            {"collisionJobId": str(job_b.id), "binStorageKey": keys_b["voxel_bin"]}, ver,
        )
        glb_b = _asset("COLLISION_GLB", keys_b["glb"], {"collisionJobId": str(job_b.id)}, ver)
        db.add_all([voxel_b, glb_b])
        db.flush()
        voxel_a = _asset(
            "COLLISION_VOXEL", keys_a["voxel_json"],
            {"collisionJobId": str(job_a.id), "binStorageKey": keys_a["voxel_bin"]}, ver,
        )
        glb_a = _asset("COLLISION_GLB", keys_a["glb"], {"collisionJobId": str(job_a.id)}, ver)
        db.add_all([voxel_a, glb_a])
        db.flush()

        coll = CollisionAsset(
            scene_id=scene.id, mode="OUTDOOR", status="SUCCEEDED", gravity=9.81,
            slope_limit_degrees=45.0, step_offset=0.3, player_height=1.8,
            asset_id=voxel_b.id, job_id=job_b.id,
            build_params={"sourceVersion": scene.current_version.asset_version},
        )
        db.add(coll)
        db.commit()
        return job_a, job_b, coll, keys_a, keys_b

    def test_voxel_pair_served_from_the_collisions_own_build(self, db, dev_user_id):
        """The voxel json and its bin must come from the SAME build the collision
        row points at — never an older job's artifacts."""
        scene = _scene(db, dev_user_id)
        job_a, job_b, coll, keys_a, keys_b = self._build_two_builds(db, scene)
        svc = _svc(db, _SendTaskRecorder())

        data, mime = svc.serve_collision_voxel(scene.slug, binary=False)
        assert b"nodeCount" in data
        assert mime == "application/json"

        data_bin, _ = svc.serve_collision_voxel(scene.slug, binary=True)
        assert data_bin == (Path(_storage_root()) / keys_b["voxel_bin"]).read_bytes()

        glb, _ = svc.serve_collision_mesh(scene.slug)
        assert glb == (Path(_storage_root()) / keys_b["glb"]).read_bytes()

    def test_legacy_single_build_layout_still_serves(self, db, dev_user_id):
        """A pre-§C collision (no job_id, assets without collisionJobId) keeps
        serving through the legacy fallback chain."""
        from app.db.models.asset import Asset
        from app.db.models.collision_asset import CollisionAsset

        scene = _scene(db, dev_user_id)
        keys = _write_collision_files(_storage_root() / "collision" / str(scene.id))
        voxel = Asset(
            scene_id=scene.id, version_id=scene.current_version_id,
            kind="COLLISION_VOXEL", storage_key=keys["voxel_json"],
            mime_type="application/json",
            byte_size=(Path(_storage_root()) / keys["voxel_json"]).stat().st_size,
            metadata_={"binStorageKey": keys["voxel_bin"]},
        )
        glb = Asset(
            scene_id=scene.id, version_id=scene.current_version_id,
            kind="COLLISION_GLB", storage_key=keys["glb"],
            mime_type="model/gltf-binary",
            byte_size=(Path(_storage_root()) / keys["glb"]).stat().st_size,
        )
        db.add_all([voxel, glb])
        db.flush()
        db.add(
            CollisionAsset(
                scene_id=scene.id, mode="OUTDOOR", status="SUCCEEDED",
                gravity=9.81, slope_limit_degrees=45.0, step_offset=0.3,
                player_height=1.8, asset_id=voxel.id,
                build_params={"sourceVersion": scene.current_version.asset_version},
            )
        )
        db.commit()

        svc = _svc(db, _SendTaskRecorder())
        data, _ = svc.serve_collision_voxel(scene.slug, binary=False)
        assert b"nodeCount" in data
        mesh, _ = svc.serve_collision_mesh(scene.slug)
        assert mesh.startswith(b"glTF")


# ─────────────────────────────────────────────────────────────────────────────
# §C — concurrent mutating entry points serialize on the scene row lock
# ─────────────────────────────────────────────────────────────────────────────
class TestConcurrentDispatchSerialization:
    def test_two_concurrent_auto_dispatches_create_one_job(self, db, dev_user_id):
        """Two workers crash-recovering the SAME scene concurrently must produce
        exactly one collision job and one dispatch (scene row FOR UPDATE)."""
        from app.db.session import SessionLocal

        scene = _scene(db, dev_user_id)
        barrier = threading.Barrier(2)
        errors: list[Exception] = []
        results: list[object] = []

        def run() -> None:
            s = SessionLocal()
            try:
                svc = _svc(s, recorder)
                barrier.wait(timeout=30)
                results.append(svc.ensure_auto_collision_for_current_version(scene.id, dev_user_id))
            except Exception as exc:  # pragma: no cover - surfaced below
                errors.append(exc)
            finally:
                s.close()

        recorder = _SendTaskRecorder()
        dispatch_lock = threading.Lock()
        real_call = recorder.__call__

        def guarded(name: str, *, args=None):  # noqa: ANN001
            with dispatch_lock:
                return real_call(name, args=args)

        recorder.__call__ = guarded  # type: ignore[method-assign]

        threads = [threading.Thread(target=run) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=60)
        assert not any(t.is_alive() for t in threads), "dispatch threads hung"
        assert errors == [], errors
        assert len(_dispatches_for(recorder, scene.id)) == 1
        assert len(_build_jobs(db, scene.id)) == 1
        assert len(_collision_row(db, scene.id)) == 1

    def test_concurrent_auto_and_manual_build_share_one_job(self, db, dev_user_id):
        """An auto reconcile and a user-triggered manual build racing on the same
        scene serialize into a single collision job; the loser observes the
        in-flight state."""
        from app.db.session import SessionLocal
        from app.schemas.collision import CollisionAssetCreateRequest

        scene = _scene(db, dev_user_id)
        recorder = _SendTaskRecorder()
        barrier = threading.Barrier(2)
        outcomes: list[str] = []

        def run_auto() -> None:
            s = SessionLocal()
            try:
                svc = _svc(s, recorder)
                barrier.wait(timeout=30)
                svc.ensure_auto_collision_for_current_version(scene.id, dev_user_id)
                outcomes.append("auto")
            finally:
                s.close()

        def run_manual() -> None:
            s = SessionLocal()
            try:
                svc = _svc(s, recorder)
                req = CollisionAssetCreateRequest(mode="OUTDOOR")
                barrier.wait(timeout=30)
                try:
                    svc.create_and_build(scene.slug, req, dev_user_id)
                    outcomes.append("manual")
                except Exception as exc:
                    outcomes.append(type(exc).__name__)
            finally:
                s.close()

        threads = [threading.Thread(target=run_auto), threading.Thread(target=run_manual)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=60)
        assert len(_build_jobs(db, scene.id)) == 1
        assert len(_collision_row(db, scene.id)) == 1


# ─────────────────────────────────────────────────────────────────────────────
# §D — the version contract survives duplicate delivery of a completed publish
# ─────────────────────────────────────────────────────────────────────────────
class TestDuplicatePublishDeliveryRecovers:
    def test_duplicate_publish_delivery_re_asserts_collision(self, db, dev_user_id):
        """A completed publish task redelivered after a crash (the SUCCEEDED
        guard) must still ensure the collision chain for the current version."""
        scene = _scene(db, dev_user_id)
        recorder = _SendTaskRecorder()
        svc = _svc(db, recorder)
        # The crash: publish SUCCEEDED but collision never dispatched.
        resp = svc.ensure_auto_collision_for_current_version(scene.id, dev_user_id)
        assert resp is not None
        coll = _collision_row(db, scene.id)[0]
        job = db.query(Job).filter(Job.id == coll.job_id).one()
        job.celery_task_id = None  # send never confirmed
        db.commit()
        recorder.calls.clear()

        # Simulate the duplicate-delivery branch of publish_scene.
        svc.ensure_auto_collision_for_current_version(scene.id, dev_user_id)

        assert len(_dispatches_for(recorder, scene.id)) == 1
        assert len(_build_jobs(db, scene.id)) == 1
        db.refresh(scene)
        assert scene.status == "PUBLISHED"


def test_reconcile_is_idempotent_under_repeat(db, dev_user_id):
    scene = _scene(db, dev_user_id)
    recorder = _SendTaskRecorder()
    svc = _svc(db, recorder)
    svc.reconcile_auto_collision()
    svc.reconcile_auto_collision()
    svc.reconcile_auto_collision()
    assert len(_dispatches_for(recorder, scene.id)) == 1
    assert len(_build_jobs(db, scene.id)) == 1
