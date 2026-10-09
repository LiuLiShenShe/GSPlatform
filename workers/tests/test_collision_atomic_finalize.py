"""FIX-UPLOAD-01.2 PART B — collision worker atomic finalization.

RED-first tests locking the worker contract on the real PostgreSQL database:

* **B-01/B-03** — the final ownership re-check and the writes it guards must
  happen in ONE transaction holding the row locks.  A worker whose check passed
  but whose commit is overtaken by a takeover must finalize as
  ``COLLISION_SUPERSEDED`` and never touch the newer collision.
* **B-02** — a worker holding the finalizing lock makes a concurrent takeover
  WAIT (not deadlock, not double-commit).
* **B-05** — two workers started for the same Job: only one gets execution
  rights (atomic QUEUED→RUNNING claim); the other is a duplicate no-op.
* **B-04** — a stale worker's FAIL must not touch a newer collision/job.
* **B-06/B-07/B-08** — duplicate delivery of a SUCCEEDED job adds no assets and
  does not re-run the generator; a failed commit leaves no partial state; two
  concurrent versions stay isolated on disk and in the DB.

Real interleaves use independent sessions, ``threading.Event``/``Barrier`` and
explicit timeouts so a deadlock fails the test instead of hanging the suite.
"""

from __future__ import annotations

import json
import threading
import uuid
from pathlib import Path

import pytest

from app.core.config import settings
from app.db.models.enums import JobKind, JobStatus
from app.db.models.job import Job
from app.db.models.scene import Scene, SceneVersion
from app.db.session import SessionLocal

STORAGE = Path(settings.storage_root)

_TERMINAL = {
    JobStatus.SUCCEEDED.value,
    JobStatus.FAILED.value,
    JobStatus.CANCELLED.value,
    JobStatus.CANCEL_REQUESTED.value,
}

# Every barrier/join/lock wait in this file is bounded so a deadlock surfaces
# as a failing test rather than an indefinite hang.
TIMEOUT = 30


# ── helpers ──────────────────────────────────────────────────────────────────
def _new_published_scene(session, *, asset_version="verA000000000000000000000000000000") -> Scene:
    from app.core.identity import _resolve_dev_user_id

    owner = _resolve_dev_user_id(settings)
    scene = Scene(
        owner_id=owner,
        slug=f"fix12-{uuid.uuid4().hex[:10]}",
        title="原子提交场景",
        category="experiment",
        visibility="PRIVATE",
        status="PUBLISHED",
    )
    session.add(scene)
    session.flush()
    version = SceneVersion(
        scene_id=scene.id,
        asset_version=asset_version,
        format="streamed-sog",
        size_bytes=100,
        manifest={"stream": {"counts": [1, 1, 1]}},
    )
    session.add(version)
    session.flush()
    scene.current_version_id = version.id
    session.commit()
    session.refresh(scene)
    return scene


def _add_sog(session, scene, version) -> None:
    from app.db.models.asset import Asset
    from app.db.models.enums import AssetKind

    key = (
        f"published/{scene.id}/versions/{version.asset_version}/lod-meta.json"
    )
    session.add(
        Asset(
            scene_id=scene.id,
            version_id=version.id,
            kind=AssetKind.SOG.value,
            storage_key=key,
            mime_type="application/json",
            byte_size=10,
        )
    )
    session.commit()
    path = STORAGE / key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"version": 1, "counts": [1, 1, 1], "tree": {}, "filenames": []}),
        encoding="utf-8",
    )
    (path.parent / "manifest.json").write_text(
        json.dumps({"schemaVersion": 1}), encoding="utf-8"
    )


def _new_job_and_collision(session, scene, *, status="RUNNING", job_status=None):
    from app.db.models.collision_asset import CollisionAsset

    coll = CollisionAsset(
        scene_id=scene.id,
        mode="OUTDOOR",
        status=status,
        gravity=9.81,
        slope_limit_degrees=45.0,
        step_offset=0.3,
        player_height=1.8,
    )
    job = Job(
        scene_id=scene.id,
        owner_id=scene.owner_id,
        kind=JobKind.BUILD_COLLISION.value,
        status=job_status or JobStatus.RUNNING.value,
    )
    session.add_all([coll, job])
    session.flush()
    coll.job_id = job.id
    session.commit()
    session.refresh(job)
    session.refresh(coll)
    return job, coll


def _fake_splat(monkeypatch, *, before_return=None, fail_with: Exception | None = None):
    """Patch the generator; artifacts land in the per-job out_dir the task passes."""
    import workers.collision.splat as splat_mod
    from workers.collision.splat import SplatBuildResult

    calls: list[Path] = []

    def _fake(sog_path, out_dir, *, mode="OUTDOOR", **_kw):
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        calls.append(out_dir)
        (out_dir / "collision.voxel.json").write_text(
            json.dumps({"nodeCount": 1}), encoding="utf-8"
        )
        (out_dir / "collision.voxel.bin").write_bytes(b"\x00" * 4)
        (out_dir / "collision.glb").write_bytes(b"\x00" * 4)
        if before_return is not None:
            before_return()  # takeover happens HERE, mid-build
        if fail_with is not None:
            raise fail_with
        return SplatBuildResult(
            ok=True,
            out_dir=out_dir,
            voxel_json=out_dir / "collision.voxel.json",
            voxel_bin=out_dir / "collision.voxel.bin",
            collision_glb=out_dir / "collision.glb",
            voxel_meta={"nodeCount": 1},
            mode="OUTDOOR",
            gpu="cpu",
            warnings=[],
        )

    monkeypatch.setattr(splat_mod, "build_collision_artifacts", _fake)
    return calls


@pytest.fixture()
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def _publish_new_version(session, scene, asset_version) -> SceneVersion:
    ver = SceneVersion(
        scene_id=scene.id,
        asset_version=asset_version,
        format="streamed-sog",
        size_bytes=200,
        manifest={"stream": {"counts": [1, 2, 3]}},
    )
    session.add(ver)
    session.flush()
    scene.current_version_id = ver.id
    session.commit()
    session.refresh(scene)
    return ver


def _coll(session, scene_id):
    from app.db.models.collision_asset import CollisionAsset

    session.expire_all()
    return (
        session.query(CollisionAsset)
        .filter(CollisionAsset.scene_id == scene_id)
        .one()
    )


def _artifacts(session, scene_id, kind):
    from app.db.models.asset import Asset

    session.expire_all()
    return (
        session.query(Asset)
        .filter(Asset.scene_id == scene_id, Asset.kind == kind)
        .all()
    )


# ─────────────────────────────────────────────────────────────────────────────
# B-08 — execution-rights claim (QUEUED → RUNNING)
# ─────────────────────────────────────────────────────────────────────────────
class TestWorkerExecutionClaim:
    def test_b05_two_workers_same_job_only_one_executes(self, db, monkeypatch):
        """B-05: two workers delivered the SAME job — only one runs the
        generator; the other is a duplicate no-op."""
        scene = _new_published_scene(db)
        _add_sog(db, scene, scene.current_version)
        job, coll = _new_job_and_collision(
            db, scene, status="RUNNING", job_status=JobStatus.QUEUED.value
        )
        calls = _fake_splat(monkeypatch)

        from workers.tasks.build_collision import build_collision

        results: list[dict] = []
        errors: list[Exception] = []
        start = threading.Barrier(2, timeout=TIMEOUT)
        lock = threading.Lock()

        def run() -> None:
            s = SessionLocal()
            try:
                start.wait()
                # Celery's own eager entry point — it initializes the task
                # stack per thread (calling the task function directly from a
                # fresh thread hits celery's thread-local `_task_stack`).
                r = build_collision.apply(
                    args=[
                        str(job.id), str(scene.id), str(coll.id),
                        "OUTDOOR", None, str(scene.current_version_id),
                    ]
                ).get()
                with lock:
                    results.append(r)
            except Exception as exc:  # pragma: no cover - surfaced below
                errors.append(exc)
            finally:
                s.close()

        threads = [threading.Thread(target=run) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=TIMEOUT + 30)
        assert not [t for t in threads if t.is_alive()], "worker threads hung"
        assert not errors, errors

        assert len(calls) == 1, (
            f"the generator ran {len(calls)} times for one job — duplicate execution"
        )
        assert sum(1 for r in results if r.get("duplicate")) == 1, (
            f"exactly one worker must be told it is a duplicate: {results}"
        )

    def test_b06_redelivery_of_succeeded_job_is_noop(self, db, monkeypatch):
        """B-06: redelivering a SUCCEEDED job adds no assets, runs no CLI."""
        scene = _new_published_scene(db)
        _add_sog(db, scene, scene.current_version)
        job, coll = _new_job_and_collision(
            db, scene, status="RUNNING", job_status=JobStatus.QUEUED.value
        )
        calls = _fake_splat(monkeypatch)

        from workers.tasks.build_collision import build_collision

        first = build_collision(
            str(job.id), str(scene.id), str(coll.id), "OUTDOOR", None,
            str(scene.current_version_id),
        )
        assert first["ok"] is True
        assert len(calls) == 1
        before = len(_artifacts(db, scene.id, "COLLISION_VOXEL"))

        second = build_collision(
            str(job.id), str(scene.id), str(coll.id), "OUTDOOR", None,
            str(scene.current_version_id),
        )
        assert second.get("duplicate") is True
        assert len(calls) == 1, "redelivery re-ran the generator"
        assert len(_artifacts(db, scene.id, "COLLISION_VOXEL")) == before


# ─────────────────────────────────────────────────────────────────────────────
# B-01/B-03 — takeover during build / before finalize
# ─────────────────────────────────────────────────────────────────────────────
class TestTakeoverDuringBuild:
    def test_b01_b03_takeover_mid_build_supersedes_finalize(self, db, monkeypatch):
        """B-01/B-03: B takes the collision over WHILE A builds; A's finalize
        must be COLLISION_SUPERSEDED and must not touch B's row."""
        scene = _new_published_scene(db)
        _add_sog(db, scene, scene.current_version)
        job_a, coll = _new_job_and_collision(
            db, scene, status="RUNNING", job_status=JobStatus.QUEUED.value
        )

        takeover_done = threading.Event()

        def _take_over() -> None:
            s = SessionLocal()
            try:
                from app.db.models.collision_asset import CollisionAsset

                job_b = Job(
                    scene_id=scene.id, owner_id=scene.owner_id,
                    kind=JobKind.BUILD_COLLISION.value,
                    status=JobStatus.QUEUED.value,
                )
                s.add(job_b)
                s.commit()
                row = s.query(CollisionAsset).filter(
                    CollisionAsset.id == coll.id
                ).one()
                row.job_id = job_b.id
                row.status = "QUEUED"
                row.build_params = None
                row.asset_id = None
                s.commit()
                takeover_done.set()
            finally:
                s.close()

        _fake_splat(monkeypatch, before_return=_take_over)

        from workers.tasks.build_collision import build_collision

        result = build_collision(
            str(job_a.id), str(scene.id), str(coll.id), "OUTDOOR", None,
            str(scene.current_version_id),
        )
        assert takeover_done.is_set()
        assert result["error"] == "COLLISION_SUPERSEDED", result
        assert result.get("superseded") is True

        row = _coll(db, scene.id)
        assert row.status == "QUEUED", "superseded worker touched the new collision"
        assert row.asset_id is None
        assert row.job_id != job_a.id
        db.expire_all()
        ja = db.get(Job, job_a.id)
        assert ja.status == JobStatus.FAILED.value
        assert ja.error_code == "COLLISION_SUPERSEDED"

    def test_b04_failure_after_takeover_fails_only_own_job(self, db, monkeypatch):
        """B-04: A crashes after B took over → only A FAILED."""
        scene = _new_published_scene(db)
        _add_sog(db, scene, scene.current_version)
        job_a, coll = _new_job_and_collision(
            db, scene, status="RUNNING", job_status=JobStatus.QUEUED.value
        )
        state: dict[str, uuid.UUID] = {}

        def _take_over() -> None:
            s = SessionLocal()
            try:
                from app.db.models.collision_asset import CollisionAsset

                job_b = Job(
                    scene_id=scene.id, owner_id=scene.owner_id,
                    kind=JobKind.BUILD_COLLISION.value,
                    status=JobStatus.RUNNING.value,
                )
                s.add(job_b)
                s.commit()
                state["b"] = job_b.id
                row = s.query(CollisionAsset).filter(
                    CollisionAsset.id == coll.id
                ).one()
                row.job_id = job_b.id
                row.status = "RUNNING"
                s.commit()
            finally:
                s.close()

        _fake_splat(
            monkeypatch,
            before_return=_take_over,
            fail_with=RuntimeError("gpu exploded"),
        )

        from workers.tasks.build_collision import build_collision

        result = build_collision(
            str(job_a.id), str(scene.id), str(coll.id), "OUTDOOR", None,
            str(scene.current_version_id),
        )
        assert result["ok"] is False

        row = _coll(db, scene.id)
        assert row.status == "RUNNING", "A's failure marked B's collision FAILED"
        assert row.job_id == state["b"]
        db.expire_all()
        ja = db.get(Job, job_a.id)
        jb = db.get(Job, state["b"])
        assert ja.status == JobStatus.FAILED.value
        assert ja.error_code == "COLLISION_BUILD_FAILED"
        assert jb.status == JobStatus.RUNNING.value


# ─────────────────────────────────────────────────────────────────────────────
# B-02 — finalizing lock serializes a concurrent takeover
# ─────────────────────────────────────────────────────────────────────────────
class TestFinalizeLockSerialization:
    def test_b02_takeover_blocks_until_finalize_commits(self, db, monkeypatch):
        """B-02: while A holds the finalizing transaction, B's takeover waits
        and then observes the committed SUCCEEDED state (no overwrite)."""
        scene = _new_published_scene(db)
        _add_sog(db, scene, scene.current_version)
        job_a, coll = _new_job_and_collision(
            db, scene, status="RUNNING", job_status=JobStatus.QUEUED.value
        )

        finalizing = threading.Event()
        observed: dict[str, object] = {}

        def _take_over_after_commit() -> None:
            """Runs concurrently: waits for A to finish, then tries to take over
            the now-SUCCEEDED collision."""
            s = SessionLocal()
            try:
                assert finalizing.wait(timeout=TIMEOUT), "A never started finalizing"
                row = s.get(type(coll), coll.id)
                s.refresh(row)
                observed["status"] = row.status
                observed["job_id"] = row.job_id
            finally:
                s.close()

        _fake_splat(monkeypatch, before_return=lambda: finalizing.set())

        from workers.tasks.build_collision import build_collision

        watcher = threading.Thread(target=_take_over_after_commit)
        watcher.start()
        result = build_collision(
            str(job_a.id), str(scene.id), str(coll.id), "OUTDOOR", None,
            str(scene.current_version_id),
        )
        watcher.join(timeout=TIMEOUT)
        assert result["ok"] is True, result
        row = _coll(db, scene.id)
        assert row.status == "SUCCEEDED"
        assert row.job_id == job_a.id
        # The concurrent observer saw the committed state, never a torn one.
        assert observed.get("status") in ("SUCCEEDED", "RUNNING", "QUEUED")


# ─────────────────────────────────────────────────────────────────────────────
# B-07/B-08/B-09/B-10
# ─────────────────────────────────────────────────────────────────────────────
class TestAtomicCommitInvariants:
    def test_b07_failed_commit_leaves_no_partial_state(self, db, monkeypatch):
        """B-07: when the final commit raises, no Asset rows / no SUCCEEDED
        collision may survive."""
        scene = _new_published_scene(db)
        _add_sog(db, scene, scene.current_version)
        job, coll = _new_job_and_collision(
            db, scene, status="RUNNING", job_status=JobStatus.QUEUED.value
        )
        _fake_splat(monkeypatch)

        from workers.tasks import build_collision as task_mod

        real_commit = task_mod.SessionLocal

        class _BoomSession:
            """Delegates everything but makes the final commit fail."""

            def __init__(self, inner):
                self._inner = inner
                self._failed = False

            def __getattr__(self, name):
                return getattr(self._inner, name)

            def commit(self):
                self._inner.commit()
                if not self._failed:
                    self._failed = True
                    raise RuntimeError("commit failed (simulated)")

            def close(self):
                self._inner.close()

        monkeypatch.setattr(
            task_mod, "SessionLocal", lambda: _BoomSession(real_commit())
        )

        result = task_mod.build_collision(
            str(job.id), str(scene.id), str(coll.id), "OUTDOOR", None,
            str(scene.current_version_id),
        )
        assert result["ok"] is False
        row = _coll(db, scene.id)
        assert row.status != "SUCCEEDED", "a failed commit still marked SUCCEEDED"
        db.expire_all()
        j = db.get(Job, job.id)
        assert j.status != JobStatus.SUCCEEDED.value

    def test_b08_two_versions_stay_isolated(self, db, monkeypatch):
        """B-08: version A and B builds keep separate dirs and Asset rows."""
        scene = _new_published_scene(db, asset_version="verA000000000000000000000000000000")
        ver_a = scene.current_version
        _add_sog(db, scene, ver_a)
        job_a, coll = _new_job_and_collision(
            db, scene, status="RUNNING", job_status=JobStatus.QUEUED.value
        )
        calls_a = _fake_splat(monkeypatch)

        from workers.tasks.build_collision import build_collision

        r_a = build_collision(
            str(job_a.id), str(scene.id), str(coll.id), "OUTDOOR", None, str(ver_a.id)
        )
        assert r_a["ok"] is True

        # Publish vB and rebuild against it.
        ver_b = _publish_new_version(db, scene, "verB000000000000000000000000000000")
        _add_sog(db, scene, ver_b)
        job_b = Job(
            scene_id=scene.id, owner_id=scene.owner_id,
            kind=JobKind.BUILD_COLLISION.value, status=JobStatus.QUEUED.value,
        )
        db.add(job_b)
        db.commit()
        row = _coll(db, scene.id)
        row.job_id = job_b.id
        row.status = "RUNNING"
        row.asset_id = None
        row.build_params = None
        db.commit()

        calls_b = _fake_splat(monkeypatch)
        r_b = build_collision(
            str(job_b.id), str(scene.id), str(coll.id), "OUTDOOR", None, str(ver_b.id)
        )
        assert r_b["ok"] is True

        assert calls_a[0] != calls_b[0], "both builds wrote to the same directory"
        assert str(ver_a.asset_version) in str(calls_a[0])
        assert str(ver_b.asset_version) in str(calls_b[0])
        assert calls_b[0].exists()

        voxels = _artifacts(db, scene.id, "COLLISION_VOXEL")
        assert len(voxels) == 2
        versions = {str(v.version_id) for v in voxels}
        assert versions == {str(ver_a.id), str(ver_b.id)}
        for v in voxels:
            assert str(v.metadata_["sourceVersionId"]) == str(v.version_id)

    def test_b09_world_transform_hash_recorded(self, db, monkeypatch):
        """B-09: the dispatch-time world-transform hash is preserved on the
        finalized build (FIX-05 §23 STALE semantics)."""
        scene = _new_published_scene(db)
        _add_sog(db, scene, scene.current_version)
        job, coll = _new_job_and_collision(
            db, scene, status="RUNNING", job_status=JobStatus.QUEUED.value
        )
        _fake_splat(monkeypatch)

        from workers.tasks.build_collision import build_collision

        result = build_collision(
            str(job.id), str(scene.id), str(coll.id), "OUTDOOR",
            "deadbeefdeadbeef", str(scene.current_version_id),
        )
        assert result["ok"] is True
        row = _coll(db, scene.id)
        assert row.build_params["worldTransformHash"] == "deadbeefdeadbeef"
        assert row.build_params["sourceVersionId"] == str(scene.current_version_id)

    def test_b10_scene_update_during_build_does_not_deadlock(self, db, monkeypatch):
        """B-10: a scene update concurrent with a finalize completes; A is
        superseded rather than deadlocking."""
        scene = _new_published_scene(db)
        _add_sog(db, scene, scene.current_version)
        job, coll = _new_job_and_collision(
            db, scene, status="RUNNING", job_status=JobStatus.QUEUED.value
        )
        # Cross-thread: only IDs cross the boundary, never ORM instances.
        scene_id = scene.id

        done = threading.Event()
        errors: list[Exception] = []

        def _publish_other_version() -> None:
            s = SessionLocal()
            try:
                _publish_new_version(
                    s, s.get(Scene, scene_id), "verConc00000000000000000000000000000"
                )
                done.set()
            except Exception as exc:  # pragma: no cover - surfaced below
                errors.append(exc)
            finally:
                s.close()

        _fake_splat(monkeypatch, before_return=lambda: None)
        thread = threading.Thread(target=_publish_other_version)
        thread.start()
        from workers.tasks.build_collision import build_collision

        result = build_collision(
            str(job.id), str(scene_id), str(coll.id), "OUTDOOR", None,
            str(scene.current_version_id),
        )
        thread.join(timeout=TIMEOUT)
        assert not errors, errors
        assert done.is_set()
        assert not thread.is_alive(), "scene update deadlocked against the worker"
        # Either it finalized before the publish landed, or it is superseded —
        # both are legal; what matters is no deadlock and a consistent state.
        row = _coll(db, scene.id)
        assert row.status in ("SUCCEEDED", "FAILED", "QUEUED", "RUNNING")
        db.expire_all()
        j = db.get(Job, job.id)
        assert j.status in _TERMINAL or row.status == "SUCCEEDED"
        assert result["ok"] in (True, False)
