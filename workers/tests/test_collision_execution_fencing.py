"""FIX-UPLOAD-01.3 PART A — execution fencing, lease heartbeat, per-attempt dirs.

RED-first tests for the two runtime defects FIX-UPLOAD-01.3 targets in the
collision worker:

* **long-build takeover** — the worker stamped ``started_at`` once and judged
  "is another worker allowed in?" with a fixed 300s TTL *and never renewed
  anything*.  Any real build longer than 300s could therefore be executed a
  second time by a redelivery or the scheduled recovery.  A live worker must
  hold its lease forward with a heartbeat, so a slow build is never stolen.
* **no execution fencing** — only ``Job.id`` identified "who am I".  After a
  crash-recovery re-claim of the *same* Job, the old worker (which wakes up
  late) could still FAIL the new generation's job or race its SUCCEEDED
  commit.  Every claim must mint a monotonic ``execution_generation``; only
  the current generation may finalize, fail, or own the output directory.

All tests run on the real PostgreSQL database with independent sessions,
threading Events/Barriers and explicit timeouts — no SQLite, no fake clock in
the production path (time is advanced by editing the persisted lease the way
an elapsed clock would, never by sleeping for 300s).
"""

from __future__ import annotations

import json
import threading
import time
import traceback
import uuid
from pathlib import Path

import pytest
from app.core.config import settings
from app.db.models.enums import JobKind, JobStatus
from app.db.models.job import Job
from app.db.session import SessionLocal

STORAGE = Path(settings.storage_root)

_TERMINAL = {
    JobStatus.SUCCEEDED.value,
    JobStatus.FAILED.value,
    JobStatus.CANCELLED.value,
    JobStatus.CANCEL_REQUESTED.value,
}

TIMEOUT = 30


# ── helpers ──────────────────────────────────────────────────────────────────
def _new_published_scene(session, *, asset_version="verA000000000000000000000000000000"):
    from app.core.identity import _resolve_dev_user_id
    from app.db.models.scene import Scene, SceneVersion

    owner = _resolve_dev_user_id(settings)
    scene = Scene(
        owner_id=owner,
        slug=f"fix013-{uuid.uuid4().hex[:10]}",
        title="执行代次场景",
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

    key = f"published/{scene.id}/versions/{version.asset_version}/lod-meta.json"
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


def _new_job_and_collision(session, scene, *, coll_status="RUNNING", job_status=None):
    from app.db.models.collision_asset import CollisionAsset

    coll = CollisionAsset(
        scene_id=scene.id,
        mode="OUTDOOR",
        status=coll_status,
        gravity=9.81,
        slope_limit_degrees=45.0,
        step_offset=0.3,
        player_height=1.8,
    )
    job = Job(
        scene_id=scene.id,
        owner_id=scene.owner_id,
        kind=JobKind.BUILD_COLLISION.value,
        status=job_status or JobStatus.QUEUED.value,
    )
    session.add_all([coll, job])
    session.flush()
    coll.job_id = job.id
    session.commit()
    session.refresh(job)
    session.refresh(coll)
    return job, coll


def _fake_splat(monkeypatch, *, block=None, fail_with: Exception | None = None):
    """Patch the generator; artifacts land in the per-attempt dir the task passes.

    ``block`` — when given, the fake blocks until that Event is set (a "long
    build" we can inspect mid-flight) and then returns normally.
    """
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
        if block is not None:
            assert block.wait(timeout=TIMEOUT), "long-build block was never released"
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


def _job_row(session, job_id) -> Job:
    session.expire_all()
    return session.get(Job, job_id)


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


def _expire_lease(session, job_id) -> None:
    """Age the persisted execution lease into the past — the state a crashed
    worker leaves behind (heartbeat stopped ⇒ no renewal ⇒ TTL elapsed)."""
    from workers.tasks.build_collision import _db_now, _dt_from_epoch

    row = session.get(Job, job_id)
    now = _db_now(session)
    row.lease_expires_at = _dt_from_epoch(now - 1.0)
    session.commit()


def _age_started_at(session, job_id, seconds: float) -> None:
    """Age ``started_at`` — the wall-clock age of a long-running build."""
    from workers.tasks.build_collision import _db_now, _dt_from_epoch

    row = session.get(Job, job_id)
    now = _db_now(session)
    row.started_at = _dt_from_epoch(now - seconds)
    session.commit()


# ─────────────────────────────────────────────────────────────────────────────
# PART A — heartbeat / lease / fencing
# ─────────────────────────────────────────────────────────────────────────────
class TestExecutionFencing:
    def test_a01_live_heartbeat_keeps_a_long_build_untouchable(
        self, db, monkeypatch
    ):
        """A-01 / RED-1: worker A is 301s into a live build whose heartbeat
        keeps renewing the lease — a redelivered worker B must NOT take over.

        On the pre-fix code the only timestamp was ``started_at``, never
        renewed, so B re-claimed the job and ran the generator a second time.
        """
        from workers.tasks import build_collision as task_mod

        # Real heartbeat cadence (seconds) so the test observes actual renewals.
        monkeypatch.setattr(task_mod, "_HEARTBEAT_INTERVAL_S", 0.15)
        monkeypatch.setattr(task_mod, "_EXECUTION_LEASE_TTL_S", 300.0)

        scene = _new_published_scene(db)
        _add_sog(db, scene, scene.current_version)
        job, coll = _new_job_and_collision(db, scene, job_status=JobStatus.QUEUED.value)

        release = threading.Event()
        calls = _fake_splat(monkeypatch, block=release)

        results: list[dict] = []
        errors: list[Exception] = []

        def run_a() -> None:
            try:
                from workers.tasks.build_collision import build_collision

                results.append(
                    build_collision(
                        str(job.id), str(scene.id), str(coll.id), "OUTDOOR",
                        None, str(scene.current_version_id),
                    )
                )
            except Exception as exc:  # pragma: no cover - surfaced below
                errors.append(exc)

        thread_a = threading.Thread(target=run_a)
        thread_a.start()
        assert _wait_for_call(calls), "worker A never entered the generator"

        # A is mid-build. Let its heartbeat renew the lease a couple of times.
        first_lease = _job_row(db, job.id).lease_expires_at
        deadline = time.monotonic() + TIMEOUT
        while time.monotonic() < deadline:
            row = _job_row(db, job.id)
            if row.lease_expires_at is not None and first_lease is not None:
                if row.lease_expires_at > first_lease:
                    break
            time.sleep(0.05)
        assert _job_row(db, job.id).lease_expires_at > first_lease, (
            "the heartbeat never renewed the execution lease"
        )

        # A is 301s into the build — far past the old fixed TTL.
        _age_started_at(db, job.id, 301.0)

        # Redelivery: B is delivered the SAME job while A is alive.
        from workers.tasks.build_collision import build_collision

        res_b = build_collision(
            str(job.id), str(scene.id), str(coll.id), "OUTDOOR", None,
            str(scene.current_version_id),
        )
        assert res_b.get("duplicate") is True, (
            f"a live, heartbeating build was taken over: {res_b}"
        )
        assert len(calls) == 1, (
            f"the generator ran {len(calls)} times — a live build was double-executed"
        )

        release.set()
        thread_a.join(timeout=TIMEOUT)
        assert not thread_a.is_alive(), "worker A never finished"
        assert not errors, errors
        assert results[0]["ok"] is True, results[0]
        row = _job_row(db, job.id)
        assert row.status == JobStatus.SUCCEEDED.value
        assert row.execution_generation == 1

    def test_a02_expired_lease_lets_recovery_take_over(self, db, monkeypatch):
        """A-02: heartbeat stopped ⇒ lease genuinely expired ⇒ a redelivered
        worker re-claims with a NEW execution generation."""
        scene = _new_published_scene(db)
        _add_sog(db, scene, scene.current_version)
        job, coll = _new_job_and_collision(db, scene, job_status=JobStatus.QUEUED.value)

        from workers.tasks.build_collision import build_collision

        calls = _fake_splat(monkeypatch)
        first = build_collision(
            str(job.id), str(scene.id), str(coll.id), "OUTDOOR", None,
            str(scene.current_version_id),
        )
        assert first["ok"] is True
        # A crashed after claiming: the job is back to the RUNNING/generation-1
        # state with an aged lease (what a dead worker leaves behind).
        row = _job_row(db, job.id)
        row.status = JobStatus.RUNNING.value
        _expire_lease(db, job.id)

        second = build_collision(
            str(job.id), str(scene.id), str(coll.id), "OUTDOOR", None,
            str(scene.current_version_id),
        )
        assert second["ok"] is True, second
        row = _job_row(db, job.id)
        assert row.execution_generation == 2, (
            "recovery must mint a NEW execution generation"
        )
        assert len(calls) == 2, "recovery did not re-run the generator"
        # Two attempts, two isolated directories.
        assert calls[0] != calls[1], "both attempts wrote to the same directory"

    def test_a03_only_one_worker_wins_a_stale_reclaim(self, db, monkeypatch):
        """A-03: two workers race to reclaim an expired lease — exactly one
        gets the new generation; the other is a duplicate."""
        scene = _new_published_scene(db)
        _add_sog(db, scene, scene.current_version)
        job, coll = _new_job_and_collision(db, scene, job_status=JobStatus.QUEUED.value)

        from workers.tasks.build_collision import build_collision

        # Crash-state: RUNNING at generation 1 with an expired lease.
        row = _job_row(db, job.id)
        row.status = JobStatus.RUNNING.value
        row.execution_generation = 1
        from workers.tasks.build_collision import _db_now, _dt_from_epoch

        row.lease_expires_at = _dt_from_epoch(_db_now(db) - 1.0)
        db.commit()

        release = threading.Event()
        calls = _fake_splat(monkeypatch, block=release)

        results: list[dict] = []
        errors: list[Exception] = []
        # Resolve every id up front: the two worker threads must never touch the
        # test's own Session (lazy attribute loading is not thread-safe).
        job_s, scene_s, coll_s = str(job.id), str(scene.id), str(coll.id)
        ver_s = str(scene.current_version_id)

        def run() -> None:
            try:
                r = build_collision.apply(
                    args=[job_s, scene_s, coll_s, "OUTDOOR", None, ver_s],
                ).get()
                results.append(r)
            except Exception as exc:  # pragma: no cover - surfaced below
                errors.append(f"{exc!r}\n{traceback.format_exc()}")

        threads = [threading.Thread(target=run) for _ in range(2)]
        for t in threads:
            t.start()
        time.sleep(0.6)  # let exactly one win the claim and start building
        release.set()
        for t in threads:
            t.join(timeout=TIMEOUT + 30)
        assert not [t for t in threads if t.is_alive()], "worker threads hung"
        assert not errors, errors
        assert len(calls) == 1, (
            f"the generator ran {len(calls)} times for one reclaim — both workers won"
        )
        row = _job_row(db, job.id)
        assert row.execution_generation == 2, (
            f"exactly one reclaim must mint generation 2, got {row.execution_generation}"
        )
        assert sum(1 for r in results if r.get("duplicate")) == 1

    def test_a04_old_generation_late_success_cannot_commit(self, db, monkeypatch):
        """A-04: A(gen1) wakes up late after B took over (gen2, RUNNING) — A's
        finalize must be refused and change nothing."""
        scene = _new_published_scene(db)
        _add_sog(db, scene, scene.current_version)
        job, coll = _new_job_and_collision(db, scene, job_status=JobStatus.QUEUED.value)

        # Crash-state A: RUNNING generation 1, lease aged out.
        row = _job_row(db, job.id)
        row.status = JobStatus.RUNNING.value
        row.execution_generation = 1
        from workers.tasks.build_collision import _db_now, _dt_from_epoch

        row.lease_expires_at = _dt_from_epoch(_db_now(db) - 1.0)
        db.commit()

        # B reclaims (generation 2) and is RUNNING — but mid-build.
        release = threading.Event()
        calls = _fake_splat(monkeypatch, block=release)

        from workers.tasks.build_collision import build_collision

        result_b: list[dict] = []

        def run_b() -> None:
            result_b.append(
                build_collision(
                    str(job.id), str(scene.id), str(coll.id), "OUTDOOR", None,
                    str(scene.current_version_id),
                )
            )

        thread_b = threading.Thread(target=run_b)
        thread_b.start()
        assert _wait_for_call(calls), "B never entered the generator"
        assert _job_row(db, job.id).execution_generation == 2

        # Now the OLD generation (A) returns late and tries to finalize.
        from workers.collision.splat import SplatBuildResult
        from workers.tasks.build_collision import _finalize_build


        def _fake_result(out_dir: Path):
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

        verdict = _finalize_build(
            db,
            job_id=job.id,
            collision_id=coll.id,
            scene_id=scene.id,
            mode="OUTDOOR",
            world_transform_hash=None,
            src_version_id=scene.current_version_id,
            asset_version=scene.current_version.asset_version,
            rel_dir=str(calls[0]),
            result=_fake_result(calls[0]),
            storage=__import__(
                "app.storage.local_disk", fromlist=["LocalDiskStorage"]
            ).LocalDiskStorage(STORAGE),
            generation=1,
        )
        assert verdict.get("error") == "OLD_EXECUTION_SUPERSEDED", verdict
        assert not verdict.get("ok"), verdict

        row = _job_row(db, job.id)
        assert row.status == JobStatus.RUNNING.value, (
            "the old generation killed the new generation's RUNNING job"
        )
        assert row.execution_generation == 2
        coll_row = _coll(db, scene.id)
        assert coll_row.asset_id is None, "old generation overwrote the asset pointer"
        assert not _artifacts(db, scene.id, "COLLISION_VOXEL"), (
            "old generation committed assets"
        )

        release.set()
        thread_b.join(timeout=TIMEOUT)
        assert not thread_b.is_alive()
        assert result_b[0]["ok"] is True, result_b[0]

    def test_a05_old_generation_late_failure_cannot_fail_new_generation(
        self, db, monkeypatch
    ):
        """A-05: A(gen1) raises after B(gen2) took over — A's failure must not
        FAILED the shared job; B keeps RUNNING."""
        scene = _new_published_scene(db)
        _add_sog(db, scene, scene.current_version)
        job, coll = _new_job_and_collision(db, scene, job_status=JobStatus.QUEUED.value)

        # B is RUNNING at generation 2.
        row = _job_row(db, job.id)
        row.status = JobStatus.RUNNING.value
        row.execution_generation = 2
        from workers.tasks.build_collision import _db_now, _dt_from_epoch

        row.lease_expires_at = _dt_from_epoch(_db_now(db) + 300.0)
        db.commit()

        from workers.tasks.build_collision import _fail_build

        verdict = _fail_build(
            db, job.id, coll.id, scene.id, RuntimeError("gpu exploded"),
            generation=1,
        )
        assert verdict.get("ok") is False

        row = _job_row(db, job.id)
        assert row.status == JobStatus.RUNNING.value, (
            "the OLD generation FAILED the job now owned by generation 2"
        )
        assert row.execution_generation == 2
        coll_row = _coll(db, scene.id)
        assert coll_row.status == "RUNNING", (
            "the old generation FAILED the live collision"
        )

    def test_a06_attempt_directories_are_isolated(self, db, monkeypatch):
        """A-06: two attempts of the SAME job write to different, per-attempt
        directories; neither may touch the other's output."""
        scene = _new_published_scene(db)
        _add_sog(db, scene, scene.current_version)
        job, coll = _new_job_and_collision(db, scene, job_status=JobStatus.QUEUED.value)

        # A crashed mid-build at generation 1 (expired lease).
        row = _job_row(db, job.id)
        row.status = JobStatus.RUNNING.value
        row.execution_generation = 1
        from workers.tasks.build_collision import _db_now, _dt_from_epoch

        row.lease_expires_at = _dt_from_epoch(_db_now(db) - 1.0)
        db.commit()
        stale_dir = STORAGE / (
            f"collision/{scene.id}/versions/{scene.current_version.asset_version}"
            f"/jobs/{job.id}/attempts/1"
        )
        stale_dir.mkdir(parents=True, exist_ok=True)
        (stale_dir / "collision.voxel.json").write_text(
            json.dumps({"nodeCount": 999}), encoding="utf-8"
        )

        calls = _fake_splat(monkeypatch)
        from workers.tasks.build_collision import build_collision

        result = build_collision(
            str(job.id), str(scene.id), str(coll.id), "OUTDOOR", None,
            str(scene.current_version_id),
        )
        assert result["ok"] is True, result
        assert len(calls) == 1
        new_dir = calls[0]
        assert new_dir != stale_dir, "generation 2 reused generation 1's directory"
        assert new_dir.name == "2", f"expected attempts/2, got {new_dir}"
        assert new_dir.parent.name == "attempts"
        # Generation 1's files are untouched.
        assert json.loads(
            (stale_dir / "collision.voxel.json").read_text(encoding="utf-8")
        )["nodeCount"] == 999
        # The committed Asset points at generation 2's file.
        voxel = _artifacts(db, scene.id, "COLLISION_VOXEL")[0]
        assert str(voxel.storage_key).startswith(str(new_dir).replace(str(STORAGE) + "/", "")), voxel.storage_key
        assert voxel.metadata_["executionGeneration"] == 2

    def test_a07_committed_build_is_not_polluted_by_older_generations(
        self, db, monkeypatch
    ):
        """A-07: B(gen2) already SUCCEEDED — A(gen1) finishing afterwards
        (success OR failure path) leaves B's assets and collision untouched."""
        scene = _new_published_scene(db)
        _add_sog(db, scene, scene.current_version)
        job, coll = _new_job_and_collision(db, scene, job_status=JobStatus.QUEUED.value)

        _fake_splat(monkeypatch)
        from workers.tasks.build_collision import _fail_build, build_collision

        result = build_collision(
            str(job.id), str(scene.id), str(coll.id), "OUTDOOR", None,
            str(scene.current_version_id),
        )
        assert result["ok"] is True
        committed = _artifacts(db, scene.id, "COLLISION_VOXEL")
        assert len(committed) == 1
        coll_row = _coll(db, scene.id)
        assert coll_row.status == "SUCCEEDED"
        asset_id = coll_row.asset_id

        # Generation 1 wakes up late and fails.
        _fail_build(
            db, job.id, coll.id, scene.id, RuntimeError("late boom"), generation=1,
        )
        row = _job_row(db, job.id)
        assert row.status == JobStatus.SUCCEEDED.value, (
            "a late failure from an older generation flipped SUCCEEDED → FAILED"
        )
        coll_row = _coll(db, scene.id)
        assert coll_row.status == "SUCCEEDED"
        assert coll_row.asset_id == asset_id
        assert len(_artifacts(db, scene.id, "COLLISION_VOXEL")) == 1

    def test_a08_heartbeat_losing_the_database_loses_the_lease(
        self, db, monkeypatch
    ):
        """A-08: if the heartbeat cannot reach the database it must give up
        (bounded retries, no silent infinite renewals) and the worker must
        then be refused at finalize."""
        from workers.tasks import build_collision as task_mod
        from workers.tasks.build_collision import LeaseHeartbeat

        class _DeadSession:
            def execute(self, *_a, **_kw):
                raise RuntimeError("database is gone")

            def commit(self):
                raise RuntimeError("database is gone")

            def rollback(self):
                pass

            def close(self):
                pass

        monkeypatch.setattr(task_mod, "_HEARTBEAT_INTERVAL_S", 0.05)
        hb = LeaseHeartbeat(
            job_id=uuid.uuid4(),
            generation=1,
            session_factory=lambda: _DeadSession(),
            interval_s=0.05,
        )
        hb.start()
        deadline = time.monotonic() + TIMEOUT
        while not hb.lost and time.monotonic() < deadline:
            time.sleep(0.05)
        hb.stop()
        assert hb.lost is True, "heartbeat kept renewing after the DB died"
        assert not hb.is_alive(), "heartbeat thread leaked"

    def test_a09_normal_end_stops_the_heartbeat_without_leaks(
        self, db, monkeypatch
    ):
        """A-09: a normal build starts and stops its heartbeat — no background
        thread survives the task."""
        from workers.tasks import build_collision as task_mod

        monkeypatch.setattr(task_mod, "_HEARTBEAT_INTERVAL_S", 0.05)
        scene = _new_published_scene(db)
        _add_sog(db, scene, scene.current_version)
        job, coll = _new_job_and_collision(db, scene, job_status=JobStatus.QUEUED.value)
        _fake_splat(monkeypatch)

        from workers.tasks.build_collision import build_collision

        result = build_collision(
            str(job.id), str(scene.id), str(coll.id), "OUTDOOR", None,
            str(scene.current_version_id),
        )
        assert result["ok"] is True, result
        time.sleep(0.3)
        leaked = [
            t for t in threading.enumerate()
            if t.is_alive() and t.name.startswith("collision-lease-")
        ]
        assert leaked == [], f"heartbeat threads leaked: {leaked}"

    def test_a12_legacy_task_args_still_build_from_current_version(
        self, db, monkeypatch
    ):
        """A-12: a task delivered without the 6th ``source_version`` arg
        (pre-01.1 message) still builds from the scene's current version."""
        scene = _new_published_scene(db)
        _add_sog(db, scene, scene.current_version)
        job, coll = _new_job_and_collision(db, scene, job_status=JobStatus.QUEUED.value)
        _fake_splat(monkeypatch)

        from workers.tasks.build_collision import build_collision

        result = build_collision(
            str(job.id), str(scene.id), str(coll.id), "OUTDOOR", None, None,
        )
        assert result["ok"] is True, result
        row = _job_row(db, job.id)
        assert row.status == JobStatus.SUCCEEDED.value
        assert row.execution_generation == 1
        voxel = _artifacts(db, scene.id, "COLLISION_VOXEL")[0]
        assert str(voxel.version_id) == str(scene.current_version_id)


def _wait_for_call(calls: list) -> bool:
    """Wait until the generator fake has been entered (the worker is mid-build)."""
    deadline = time.monotonic() + TIMEOUT
    while time.monotonic() < deadline:
        if calls:
            return True
        time.sleep(0.02)
    return bool(calls)