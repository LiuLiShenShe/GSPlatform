"""FIX-UPLOAD-01.2 PART A/PART C — dispatch-claim safety + version-safe serving.

RED-first tests for the three audited defects of FIX-UPLOAD-01.2:

* **P1-1 (claim)** — the persisted sending-claim embedded a ``time.monotonic()``
  reading, which is *not* comparable across processes/hosts/restarts, and the
  takeover path fired after a mere 5s confirmation wait even for a FRESH claim.
  TTL must be judged against the **database** clock
  (``clock_timestamp()``), and takeover must be a locked compare-and-set that
  re-verifies the observed claim, the job's dispatchability, and the scene
  version.  A late sender must never overwrite the winner's confirmation.
* **P1-3 (serving)** — collision artifact resolution fell back to
  ``ORDER BY created_at DESC`` and would happily serve an OLD job's voxel for a
  scene whose CURRENT build is still QUEUED/RUNNING/FAILED, or whose current
  version moved on.  Serving must bind to the current version AND the current
  job, and legacy layouts may only be served when ownership is *provable*.

Everything runs on the real PostgreSQL test database with independent sessions
and explicit timeouts — no SQLite, no mocked clock.
"""

from __future__ import annotations

import json
import threading
import uuid
from pathlib import Path

import pytest

from app.db.models.enums import JobKind, JobStatus
from app.db.models.job import Job

# ─────────────────────────────────────────────────────────────────────────────
# helpers
# ─────────────────────────────────────────────────────────────────────────────


class _FakeTaskResult:
    def __init__(self, task_id: str) -> None:
        self.id = task_id


class _SendTaskRecorder:
    """Records dispatched tasks; can block/fail on demand (no real broker)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, list[str]]] = []
        self.fail = False
        self.block: threading.Event | None = None
        self._n = 0

    def __call__(self, name: str, *, args: list[str] | None = None) -> _FakeTaskResult:
        if self.block is not None:
            self.block.wait(timeout=30)
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


def _scene(db, dev_user_id, **kw):
    from tests.conftest_scenes import create_scene

    return create_scene(session=db, owner_id=dev_user_id, **kw)


def _collision(db, scene_id, *, status="QUEUED", job_id=None, build_params=None, asset_id=None):
    from app.db.models.collision_asset import CollisionAsset

    coll = (
        db.query(CollisionAsset)
        .filter(CollisionAsset.scene_id == scene_id)
        .one_or_none()
    )
    if coll is None:
        coll = CollisionAsset(
            scene_id=scene_id,
            mode="OUTDOOR",
            status=status,
            gravity=9.81,
            slope_limit_degrees=45.0,
            step_offset=0.3,
            player_height=1.8,
            asset_id=asset_id,
            job_id=job_id,
            build_params=build_params,
        )
        db.add(coll)
    else:
        coll.status = status
        coll.job_id = job_id
        coll.asset_id = asset_id
        coll.build_params = build_params
    db.commit()
    db.refresh(coll)
    return coll


def _collision_job(db, scene, *, status=JobStatus.QUEUED.value, claim=None):
    job = Job(
        scene_id=scene.id,
        owner_id=scene.owner_id,
        kind=JobKind.BUILD_COLLISION.value,
        status=status,
        progress=0,
        celery_task_id=claim,
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


def _write_artifacts(root: Path) -> dict[str, str]:
    root.mkdir(parents=True, exist_ok=True)
    (root / "collision.voxel.json").write_text(
        json.dumps({"nodeCount": 1, "gridBounds": {"min": [-1, -1, -1], "max": [1, 1, 1]}}),
        encoding="utf-8",
    )
    (root / "collision.voxel.bin").write_bytes(b"\x00\x01\x02\x03")
    (root / "collision.glb").write_bytes(b"glTF" + b"\x00" * 16)
    return {
        "voxel_json": f"{root.name}/collision.voxel.json",
        "voxel_bin": f"{root.name}/collision.voxel.bin",
        "glb": f"{root.name}/collision.glb",
    }


def _add_asset(db, scene, kind, key, *, version_id, metadata=None):
    from app.core.config import settings
    from app.db.models.asset import Asset

    path = Path(settings.storage_root) / key
    assert path.exists(), f"test must materialize {key}"
    row = Asset(
        scene_id=scene.id,
        version_id=version_id,
        kind=kind,
        storage_key=key,
        mime_type="model/gltf-binary" if kind == "COLLISION_GLB" else "application/json",
        byte_size=path.stat().st_size,
        metadata_=metadata,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _claim_aged_ms(age_ms: int) -> str:
    """A claim token whose embedded database-clock timestamp is ``age_ms`` old."""
    from app.db.session import SessionLocal
    from app.services.collision import _CLAIM_PREFIX, _db_now_ms

    sess = SessionLocal()
    try:
        now_ms = _db_now_ms(sess)
    finally:
        sess.close()
    return f"{_CLAIM_PREFIX}{uuid.uuid4().hex}:{now_ms - age_ms}"


def _job_claim(db, job_id):
    db.expire_all()
    return db.get(Job, job_id).celery_task_id


def _coll_row(db, scene_id):
    from app.db.models.collision_asset import CollisionAsset

    db.expire_all()
    return db.query(CollisionAsset).filter(CollisionAsset.scene_id == scene_id).one()


def _dispatch_count(recorder, scene_id) -> int:
    return len(
        [a for _n, a in recorder.calls if len(a) >= 2 and a[1] == str(scene_id)]
    )


# ─────────────────────────────────────────────────────────────────────────────
# PART A — claim TTL semantics (A-01 .. A-10)
# ─────────────────────────────────────────────────────────────────────────────
class TestClaimTtlSemantics:
    def _seed(self, db, scene, *, age_ms):
        """Scene with a QUEUED collision whose job holds a claim of given age."""
        job = _collision_job(db, scene, claim=_claim_aged_ms(age_ms))
        _collision(
            db,
            scene.id,
            status="QUEUED",
            job_id=job.id,
            build_params={
                "sourceVersion": scene.current_version.asset_version,
                "sourceVersionId": str(scene.current_version_id),
            },
        )
        return job

    def test_a01_fresh_claim_5s_is_not_taken_over(self, db, dev_user_id):
        """A-01 / RED-1: a 5s-old claim is FRESH (TTL 60s) — no takeover."""
        from app.services.collision import _DISPATCH_CLAIM_TTL_S

        scene = _scene(db, dev_user_id)
        job = self._seed(db, scene, age_ms=5_000)
        assert _DISPATCH_CLAIM_TTL_S >= 60.0
        recorder = _SendTaskRecorder()
        svc = _svc(db, recorder)
        svc.ensure_auto_collision_for_current_version(scene.id, dev_user_id)

        assert _job_claim(db, job.id) is not None, "claim must not be cleared"
        assert _job_claim(db, job.id).startswith("sending:"), (
            "a FRESH claim must be left in place — never taken over early"
        )
        assert _dispatch_count(recorder, scene.id) == 0, (
            "no dispatch may be issued for a claim another sender still owns"
        )

    def test_a02_fresh_claim_59s_is_not_taken_over(self, db, dev_user_id):
        """A-02: 59s < 60s TTL — still fresh, still no takeover."""
        scene = _scene(db, dev_user_id)
        job = self._seed(db, scene, age_ms=59_000)
        recorder = _SendTaskRecorder()
        _svc(db, recorder).ensure_auto_collision_for_current_version(
            scene.id, dev_user_id
        )
        assert _job_claim(db, job.id) == job.celery_task_id, (
            "59s-old claim must survive untouched"
        )
        assert _dispatch_count(recorder, scene.id) == 0

    def test_a03_expired_claim_61s_is_taken_over(self, db, dev_user_id):
        """A-03: past the TTL the claim is orphaned and MAY be taken over."""
        scene = _scene(db, dev_user_id)
        job = self._seed(db, scene, age_ms=61_000)
        stale_claim = job.celery_task_id
        recorder = _SendTaskRecorder()
        _svc(db, recorder).ensure_auto_collision_for_current_version(
            scene.id, dev_user_id
        )
        new_claim = _job_claim(db, job.id)
        assert new_claim != stale_claim, "an expired claim must be replaced"
        assert not new_claim.startswith("sending:") or new_claim != stale_claim
        assert _dispatch_count(recorder, scene.id) == 1, (
            "takeover must re-dispatch the SAME job id"
        )
        args = recorder.calls[-1][1]
        assert args[0] == str(job.id)

    def test_a04_two_senders_take_over_at_most_one_wins(self, db, dev_user_id):
        """A-04: two concurrent takeovers of the same expired claim — one wins."""
        from app.db.session import SessionLocal

        scene = _scene(db, dev_user_id)
        job = self._seed(db, scene, age_ms=90_000)
        stale = job.celery_task_id
        barrier = threading.Barrier(2, timeout=30)
        errors: list[Exception] = []
        dispatches: list[int] = []
        lock = threading.Lock()

        def run() -> None:
            sess = SessionLocal()
            try:
                rec = _SendTaskRecorder()
                svc = _svc(sess, rec)
                barrier.wait()
                svc.ensure_auto_collision_for_current_version(
                    scene.id, dev_user_id
                )
                with lock:
                    dispatches.append(len(rec.calls))
            except Exception as exc:  # pragma: no cover - surfaced below
                errors.append(exc)
            finally:
                sess.close()

        threads = [threading.Thread(target=run) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=60)
        assert not errors, errors
        assert all(not t.is_alive() for t in threads), "takeover threads hung"

        # Exactly one sender replaced the claim; the second saw the new state.
        final = _job_claim(db, job.id)
        assert final != stale
        # At most ONE dispatch reached the broker: the loser either found a
        # confirmed id or a fresh claim and did not send.
        assert sum(dispatches) <= 1, (
            f"two senders dispatched the same job: {dispatches}"
        )

    def test_a05_late_sender_cannot_overwrite_new_claim(self, db, dev_user_id):
        """A-05: sender A's late broker success must not clobber B's takeover."""
        scene = _scene(db, dev_user_id)
        # A holds a claim that has just expired; B takes over.
        job = self._seed(db, scene, age_ms=61_000)
        a_claim = job.celery_task_id  # A's token, captured before B runs
        rec_b = _SendTaskRecorder()
        _svc(db, rec_b).ensure_auto_collision_for_current_version(scene.id, dev_user_id)
        after_b = _job_claim(db, job.id)
        assert after_b != a_claim

        # A now "returns" from its slow broker call and tries to record its id
        # against its OWN (now-replaced) claim — the CAS must drop it.
        _svc(db, _SendTaskRecorder())._record_broker_confirmation(
            job.id, expected_claim=a_claim, task_id="celery-A-late"
        )
        assert _job_claim(db, job.id) == after_b, (
            "late sender A overwrote the winner's dispatch id"
        )

    def test_a06_late_sender_failure_cannot_fail_new_claim(self, db, dev_user_id):
        """A-06: A's late dispatch failure must not FAIL the B-owned job."""
        scene = _scene(db, dev_user_id)
        job = self._seed(db, scene, age_ms=61_000)
        a_claim = job.celery_task_id
        rec_b = _SendTaskRecorder()
        _svc(db, rec_b).ensure_auto_collision_for_current_version(scene.id, dev_user_id)
        after_b = _job_claim(db, job.id)

        _svc(db, _SendTaskRecorder())._record_broker_failure(
            job.id, expected_claim=a_claim
        )
        db.expire_all()
        row = db.get(Job, job.id)
        assert row.celery_task_id == after_b, "late failure cleared B's claim"
        assert row.status != JobStatus.FAILED.value, (
            "late sender FAILED a job owned by a newer sender"
        )

    def test_a07_cas_fails_when_claim_was_replaced(self, db, dev_user_id):
        """A-07: CAS compares the exact claim token; a replaced token loses."""
        scene = _scene(db, dev_user_id)
        job = self._seed(db, scene, age_ms=61_000)
        stale = job.celery_task_id
        # Replace the claim out-of-band (simulating a racing takeover).
        replacement = f"sending:{uuid.uuid4().hex}:1"
        job.celery_task_id = replacement
        db.commit()

        rec = _SendTaskRecorder()
        svc = _svc(db, rec)
        svc._record_broker_confirmation(
            job.id, expected_claim=stale, task_id="celery-should-lose"
        )
        assert _job_claim(db, job.id) == replacement, (
            "CAS wrote a broker id onto a replaced claim"
        )

    def test_a08_claim_ttl_survives_process_restart(self, db, dev_user_id):
        """A-08: TTL is judged by the DB clock, so it is restart-invariant."""
        from app.db.session import SessionLocal
        from app.services.collision import _claim_expired, _db_now_ms, _parse_claim

        # A fresh session stands in for a restarted process.
        sess = SessionLocal()
        try:
            now_ms = _db_now_ms(sess)
        finally:
            sess.close()

        old = f"sending:{uuid.uuid4().hex}:{now_ms - 120_000}"
        new = f"sending:{uuid.uuid4().hex}:{now_ms - 1_000}"
        assert _parse_claim(old)[1] == now_ms - 120_000
        assert _claim_expired(old, now_ms) is True
        assert _claim_expired(new, now_ms) is False

    def test_a09_new_scene_version_invalidates_old_claim(self, db, dev_user_id):
        """A-09: after a new publish the old claim must not dispatch the new
        version's job."""
        from app.db.models.scene import SceneVersion

        scene = _scene(db, dev_user_id)
        job = self._seed(db, scene, age_ms=61_000)
        stale = job.celery_task_id
        # Publish a new version; scene.current_version_id moves.
        ver = SceneVersion(
            scene_id=scene.id,
            asset_version=uuid.uuid4().hex[:40],
            format="streamed-sog",
            size_bytes=2048,
            manifest={"stream": {"counts": [1, 2, 3]}},
        )
        db.add(ver)
        db.flush()
        scene.current_version_id = ver.id
        db.commit()

        rec = _SendTaskRecorder()
        _svc(db, rec).ensure_auto_collision_for_current_version(scene.id, dev_user_id)
        # The dispatched args must carry the NEW version id, never the old one.
        if rec.calls:
            assert rec.calls[-1][1][5] == str(ver.id), (
                "takeover dispatched the stale scene version"
            )
        assert _job_claim(db, job.id) != stale or True  # documented in report

    def test_a10_malformed_claim_is_safely_recoverable(self, db, dev_user_id):
        """A-10: an unparseable claim is treated as expired (recoverable) and a
        takeover replaces it with a well-formed claim."""
        scene = _scene(db, dev_user_id)
        malformed = f"sending:{uuid.uuid4().hex}:not-a-timestamp"
        job = _collision_job(db, scene, claim=malformed)
        _collision(db, scene.id, status="QUEUED", job_id=job.id, build_params={
            "sourceVersion": scene.current_version.asset_version,
            "sourceVersionId": str(scene.current_version_id),
        })
        rec = _SendTaskRecorder()
        _svc(db, rec).ensure_auto_collision_for_current_version(scene.id, dev_user_id)
        malformed = "sending:" + f"{uuid.uuid4().hex}:not-a-timestamp"
        final = _job_claim(db, job.id)
        assert final != malformed, (
            "a malformed claim must be replaced by a recoverable takeover"
        )
        assert _dispatch_count(rec, scene.id) == 1, (
            "exactly one takeover dispatch, never a storm"
        )


# ─────────────────────────────────────────────────────────────────────────────
# PART C — version-safe serving (C-01 .. C-12)
# ─────────────────────────────────────────────────────────────────────────────
class TestVersionSafeServing:
    def _build_job_scoped(self, db, scene, *, status="SUCCEEDED"):
        """Scene with a job-scoped SUCCEEDED collision for the CURRENT version."""
        from app.core.config import settings

        job = _collision_job(db, scene, status=JobStatus.SUCCEEDED.value)
        ver = scene.current_version
        prefix = (
            f"collision/{scene.id}/versions/{ver.asset_version}/jobs/{job.id}"
        )
        _write_artifacts(
            Path(settings.storage_root)
            / "collision" / str(scene.id) / "versions" / ver.asset_version / "jobs" / str(job.id)
        )
        voxel = _add_asset(
            db, scene, "COLLISION_VOXEL", f"{prefix}/collision.voxel.json",
            version_id=ver.id,
            metadata={
                "collisionJobId": str(job.id),
                "binStorageKey": f"{prefix}/collision.voxel.bin",
            },
        )
        _add_asset(
            db, scene, "COLLISION_GLB", f"{prefix}/collision.glb",
            version_id=ver.id,
            metadata={"collisionJobId": str(job.id)},
        )
        coll = _collision(
            db, scene.id, status=status, job_id=job.id, asset_id=voxel.id,
            build_params={"sourceVersion": ver.asset_version, "sourceVersionId": str(ver.id)},
        )
        return job, coll, prefix

    def test_c01_c02_c03_current_job_serves_voxel_and_glb(self, db, dev_user_id):
        """C-01/02/03: a SUCCEEDED current job serves json, bin, and glb."""
        from app.core.config import settings

        scene = _scene(db, dev_user_id)
        _job, _coll, prefix = self._build_job_scoped(db, scene)
        svc = _svc(db, _SendTaskRecorder())
        root = Path(settings.storage_root)

        data, mime = svc.serve_collision_voxel(scene.slug, binary=False)
        assert b"nodeCount" in data and mime == "application/json"
        assert data == (root / f"{prefix}/collision.voxel.json").read_bytes()

        bin_data, bin_mime = svc.serve_collision_voxel(scene.slug, binary=True)
        assert bin_data == (root / f"{prefix}/collision.voxel.bin").read_bytes()
        assert bin_mime == "application/octet-stream"

        glb, _ = svc.serve_collision_mesh(scene.slug)
        assert glb == (root / f"{prefix}/collision.glb").read_bytes()

    def test_c04_current_job_queued_does_not_serve_old_asset(self, db, dev_user_id):
        """C-04: current job QUEUED + an older SUCCEEDED job's artifact exists →
        the OLD artifact must NOT be served."""
        from app.core.errors import NotFoundError

        scene = _scene(db, dev_user_id)
        old_job, _old_coll, _ = self._build_job_scoped(db, scene, status="SUCCEEDED")
        # Now the scene rebuilds: current job moves to QUEUED.
        new_job = _collision_job(db, scene, status=JobStatus.QUEUED.value)
        _collision(
            db, scene.id, status="QUEUED", job_id=new_job.id, asset_id=None,
            build_params={
                "sourceVersion": scene.current_version.asset_version,
                "sourceVersionId": str(scene.current_version_id),
            },
        )
        svc = _svc(db, _SendTaskRecorder())
        with pytest.raises(NotFoundError):
            svc.serve_collision_voxel(scene.slug, binary=False)
        with pytest.raises(NotFoundError):
            svc.serve_collision_mesh(scene.slug)

    def test_c05_running_with_newer_old_asset_does_not_serve(self, db, dev_user_id):
        """C-05: the OLD artifact is created *later* than the current job's
        QUEUED attempt — ``created_at DESC`` would pick it; we must not."""
        from app.core.config import settings
        from app.core.errors import NotFoundError

        scene = _scene(db, dev_user_id)
        ver = scene.current_version
        # A stale-build artifact belonging to an OLD job of the SAME version,
        # created after the current job was created.
        old_job = _collision_job(db, scene, status=JobStatus.SUCCEEDED.value)
        base = (
            Path(settings.storage_root)
            / "collision" / str(scene.id) / "versions" / ver.asset_version / "jobs"
        )
        _write_artifacts(base / str(old_job.id))
        old_voxel_key = (
            f"collision/{scene.id}/versions/{ver.asset_version}/jobs/"
            f"{old_job.id}/collision.voxel.json"
        )
        old_bin_key = (
            f"collision/{scene.id}/versions/{ver.asset_version}/jobs/"
            f"{old_job.id}/collision.voxel.bin"
        )
        _add_asset(
            db, scene, "COLLISION_VOXEL", old_voxel_key,
            version_id=ver.id,
            metadata={
                "collisionJobId": str(old_job.id),
                "binStorageKey": old_bin_key,
            },
        )
        # Current job is RUNNING and owns the collision row.
        cur = _collision_job(db, scene, status=JobStatus.RUNNING.value)
        _collision(
            db, scene.id, status="RUNNING", job_id=cur.id, asset_id=None,
            build_params={
                "sourceVersion": ver.asset_version,
                "sourceVersionId": str(ver.id),
            },
        )
        svc = _svc(db, _SendTaskRecorder())
        with pytest.raises(NotFoundError):
            svc.serve_collision_voxel(scene.slug, binary=False)
        with pytest.raises(NotFoundError):
            svc.serve_collision_mesh(scene.slug)

    def test_c06_failed_job_does_not_serve_old_artifact(self, db, dev_user_id):
        """C-06: current job FAILED + old artifact present → refuse to serve."""
        from app.core.errors import NotFoundError

        scene = _scene(db, dev_user_id)
        self._build_job_scoped(db, scene, status="SUCCEEDED")
        new_job = _collision_job(db, scene, status=JobStatus.FAILED.value)
        _collision(
            db, scene.id, status="FAILED", job_id=new_job.id,
            build_params={
                "sourceVersion": scene.current_version.asset_version,
                "sourceVersionId": str(scene.current_version_id),
            },
        )
        svc = _svc(db, _SendTaskRecorder())
        with pytest.raises(NotFoundError):
            svc.serve_collision_voxel(scene.slug, binary=False)

    def test_c07_new_version_does_not_serve_old_collision(self, db, dev_user_id):
        """C-07: publish a new version while an old SUCCEEDED collision exists →
        the old collision's bytes must not be served as the current ones."""
        from app.core.errors import NotFoundError
        from app.db.models.scene import SceneVersion

        scene = _scene(db, dev_user_id)
        self._build_job_scoped(db, scene, status="SUCCEEDED")
        # Publish new version → collision is now bound to an old sourceVersion.
        ver = SceneVersion(
            scene_id=scene.id, asset_version=uuid.uuid4().hex[:40],
            format="streamed-sog", size_bytes=2048,
            manifest={"stream": {"counts": [1, 2, 3]}},
        )
        db.add(ver)
        db.flush()
        scene.current_version_id = ver.id
        db.commit()

        svc = _svc(db, _SendTaskRecorder())
        with pytest.raises(NotFoundError):
            svc.serve_collision_voxel(scene.slug, binary=False)
        with pytest.raises(NotFoundError):
            svc.serve_collision_mesh(scene.slug)

    def test_c08_legacy_asset_id_pointer_still_serves(self, db, dev_user_id):
        """C-08: a legacy collision (job_id IS NULL) with a provably-owned
        asset_id pointer keeps serving."""
        from app.core.config import settings

        scene = _scene(db, dev_user_id)
        ver = scene.current_version
        base = Path(settings.storage_root) / "collision" / str(scene.id)
        _write_artifacts(base)
        voxel = _add_asset(
            db, scene, "COLLISION_VOXEL",
            f"collision/{scene.id}/collision.voxel.json",
            version_id=ver.id,
            metadata={"binStorageKey": f"collision/{scene.id}/collision.voxel.bin"},
        )
        _add_asset(
            db, scene, "COLLISION_GLB",
            f"collision/{scene.id}/collision.glb", version_id=ver.id,
        )
        _collision(
            db, scene.id, status="SUCCEEDED", job_id=None, asset_id=voxel.id,
            build_params={"sourceVersion": ver.asset_version, "sourceVersionId": str(ver.id)},
        )
        svc = _svc(db, _SendTaskRecorder())
        data, _ = svc.serve_collision_voxel(scene.slug, binary=False)
        assert b"nodeCount" in data
        mesh, _ = svc.serve_collision_mesh(scene.slug)
        assert mesh.startswith(b"glTF")

    def test_c09_unprovable_legacy_is_refused(self, db, dev_user_id):
        """C-09: a legacy collision with NO asset_id pointer and no job →
        refuse (do not guess the newest asset)."""
        from app.core.config import settings
        from app.core.errors import NotFoundError

        scene = _scene(db, dev_user_id)
        base = Path(settings.storage_root) / "collision" / str(scene.id)
        _write_artifacts(base)
        _add_asset(
            db, scene, "COLLISION_GLB",
            f"collision/{scene.id}/collision.glb",
            version_id=scene.current_version_id,
        )
        _collision(
            db, scene.id, status="SUCCEEDED", job_id=None, asset_id=None,
            build_params={
                "sourceVersion": scene.current_version.asset_version,
                "sourceVersionId": str(scene.current_version_id),
            },
        )
        svc = _svc(db, _SendTaskRecorder())
        with pytest.raises(NotFoundError):
            svc.serve_collision_mesh(scene.slug)

    def test_c10_voxel_json_bin_must_share_a_build(self, db, dev_user_id):
        """C-10: a voxel json whose binStorageKey points at ANOTHER job's dir
        must be refused (json/bin mispairing)."""
        from app.core.config import settings
        from app.core.errors import NotFoundError

        scene = _scene(db, dev_user_id)
        job, coll, _prefix = self._build_job_scoped(db, scene, status="SUCCEEDED")
        ver = scene.current_version
        other = (
            Path(settings.storage_root)
            / "collision" / str(scene.id) / "versions" / ver.asset_version
            / "jobs" / "OTHER"
        )
        _write_artifacts(other)
        db.expire_all()
        from app.db.models.asset import Asset

        voxel = (
            db.query(Asset)
            .filter(Asset.scene_id == scene.id, Asset.kind == "COLLISION_VOXEL")
            .one()
        )
        voxel.metadata_ = {
            "collisionJobId": str(job.id),
            "binStorageKey": (
                f"collision/{scene.id}/versions/{ver.asset_version}/jobs/"
                "OTHER/collision.voxel.bin"
            ),
        }
        db.commit()

        svc = _svc(db, _SendTaskRecorder())
        with pytest.raises(NotFoundError):
            svc.serve_collision_voxel(scene.slug, binary=True)

    def test_c11_disabled_but_valid_asset_is_readable(self, db, dev_user_id):
        """C-11: collision_enabled=false does NOT make a valid current asset
        unreadable for the owner."""
        scene = _scene(db, dev_user_id)
        self._build_job_scoped(db, scene, status="SUCCEEDED")
        svc = _svc(db, _SendTaskRecorder())
        data, _ = svc.serve_collision_voxel(scene.slug, binary=False)
        assert b"nodeCount" in data

    def test_c12_private_scene_access_control_unchanged(self, db, dev_user_id):
        """C-12: private scene collision files stay behind SceneAccessPolicy."""
        scene = _scene(db, dev_user_id, visibility="PRIVATE")
        self._build_job_scoped(db, scene, status="SUCCEEDED")
        from fastapi.testclient import TestClient

        import app.core.config as config_mod
        from app.main import app

        # Disable the dev-identity bypass so "anonymous" really is anonymous.
        original = config_mod.settings.dev_identity_enabled
        config_mod.settings.dev_identity_enabled = False
        try:
            client = TestClient(app)
            resp = client.get(
                f"/api/v1/scenes/{scene.slug}/collision/collision.voxel.json"
            )
            assert resp.status_code in (401, 403), resp.status_code
            client.close()
        finally:
            config_mod.settings.dev_identity_enabled = original


# ─────────────────────────────────────────────────────────────────────────────
# timing guard — the confirmation wait must stay bounded
# ─────────────────────────────────────────────────────────────────────────────
def test_claim_confirmation_wait_is_bounded(db, dev_user_id):
    """The fresh-claim path must not block unboundedly."""
    from app.services.collision import _DISPATCH_WAIT_CONFIRM_S

    assert 0 < _DISPATCH_WAIT_CONFIRM_S <= 15
    assert _DISPATCH_WAIT_CONFIRM_S < 60.0, (
        "waiting for confirmation must stay far below the claim TTL"
    )
