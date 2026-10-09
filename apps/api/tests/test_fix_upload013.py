"""FIX-UPLOAD-01.3 PART B — broker callback safety + scheduled orphan recovery.

RED-first tests for the two remaining runtime defects:

* **late broker failure overwrites live state** — ``_record_broker_failure``
  compare-and-swapped on the dispatch *claim* but never checked the job's
  status.  A send that the broker actually accepted but whose confirmation
  timed out ("network error ≠ the broker did not get it") let the late
  callback flip a RUNNING (worker mid-build) or SUCCEEDED (worker finished)
  job back to FAILED, discarding a real build.  A late callback may now only
  ever move a still-QUEUED job back to a *recoverable* dispatch-incomplete
  state.
* **no orphan recovery without Celery redelivery** — a worker that dies
  leaves a RUNNING job; the scheduled reconcile had no way to notice the dead
  execution lease.  The same recovery entrypoint that already re-asserts the
  collision chain must reclaim an expired execution lease and re-dispatch,
  producing a NEW execution generation, with a cap so a permanently failing
  job cannot loop forever.

Everything runs on the real PostgreSQL database: state transitions are real
row writes under real locks, not mocked ``send_task`` return values.
"""

from __future__ import annotations

import uuid

from app.db.models.enums import JobKind, JobStatus
from app.db.models.job import Job

# ─────────────────────────────────────────────────────────────────────────────
# helpers
# ─────────────────────────────────────────────────────────────────────────────


class _FakeTaskResult:
    def __init__(self, task_id: str) -> None:
        self.id = task_id


class _SendTaskRecorder:
    """Records dispatched tasks; can accept-then-raise on demand."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, list[str]]] = []
        self.raise_after_accept = False
        self.fail = False
        self._n = 0

    def __call__(self, name: str, *, args: list[str] | None = None) -> _FakeTaskResult:
        if self.fail:
            raise RuntimeError("broker unavailable (simulated)")
        self._n += 1
        self.calls.append((name, list(args or [])))
        if self.raise_after_accept:
            # The broker took the message, then the sender lost the reply.
            raise TimeoutError("send timed out AFTER the broker accepted")
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
            scene_id=scene_id, mode="OUTDOOR", status=status, gravity=9.81,
            slope_limit_degrees=45.0, step_offset=0.3, player_height=1.8,
            asset_id=asset_id, job_id=job_id, build_params=build_params,
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


def _job(db, scene, *, status=JobStatus.QUEUED.value, claim=None):
    job = Job(
        scene_id=scene.id, owner_id=scene.owner_id,
        kind=JobKind.BUILD_COLLISION.value, status=status, progress=0,
        celery_task_id=claim,
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


def _claim_aged_ms(age_ms: int) -> str:
    from app.db.session import SessionLocal
    from app.services.collision import _CLAIM_PREFIX, _db_now_ms

    sess = SessionLocal()
    try:
        now_ms = _db_now_ms(sess)
    finally:
        sess.close()
    return f"{_CLAIM_PREFIX}{uuid.uuid4().hex}:{now_ms - age_ms}"


def _fresh_claim() -> str:
    return _claim_aged_ms(0)


def _job_row(db, job_id) -> Job:
    db.expire_all()
    return db.get(Job, job_id)


def _coll_row(db, scene_id):
    from app.db.models.collision_asset import CollisionAsset

    db.expire_all()
    return db.query(CollisionAsset).filter(CollisionAsset.scene_id == scene_id).one()


def _worker_claimed(db, job, *, generation=1, lease_s=300.0):
    """Persist the state a worker's execution claim writes: RUNNING at
    ``generation`` with a live lease.  (The worker's own tests drive the real
    claim; here we only need the persisted truth a late callback observes.)"""
    from sqlalchemy import text

    from app.db.models.job import Job as _Job
    from app.db.session import SessionLocal

    sess = SessionLocal()
    try:
        epoch = float(
            sess.execute(
                text("SELECT EXTRACT(EPOCH FROM clock_timestamp())")
            ).first()[0]
        )
        from datetime import UTC, datetime

        row = sess.get(_Job, job.id)
        row.status = JobStatus.RUNNING.value
        row.execution_generation = generation
        row.started_at = datetime.fromtimestamp(epoch, tz=UTC)
        row.lease_expires_at = datetime.fromtimestamp(epoch + lease_s, tz=UTC)
        sess.commit()
    finally:
        sess.close()
    db.expire_all()


def _expire_lease(db, job_id) -> None:
    from sqlalchemy import text

    from app.db.models.job import Job as _Job
    from app.db.session import SessionLocal

    sess = SessionLocal()
    try:
        epoch = float(
            sess.execute(
                text("SELECT EXTRACT(EPOCH FROM clock_timestamp())")
            ).first()[0]
        )
        from datetime import UTC, datetime

        row = sess.get(_Job, job_id)
        row.lease_expires_at = datetime.fromtimestamp(epoch - 1.0, tz=UTC)
        sess.commit()
    finally:
        sess.close()
    db.expire_all()


def _build_jobs(db, scene_id):
    return (
        db.query(Job)
        .filter(Job.scene_id == scene_id, Job.kind == JobKind.BUILD_COLLISION.value)
        .order_by(Job.created_at.asc())
        .all()
    )


def _dispatches_for(recorder, scene_id):
    return [a for _n, a in recorder.calls if len(a) >= 2 and a[1] == str(scene_id)]


# ─────────────────────────────────────────────────────────────────────────────
# PART B — broker callback state machine (B-01 .. B-10)
# ─────────────────────────────────────────────────────────────────────────────
class TestBrokerCallbackSafety:
    def test_b01_late_broker_failure_cannot_fail_a_running_job(self, db, dev_user_id):
        """B-01 / RED-3: broker accepted, worker is RUNNING, sender reports a
        late failure → the job must stay RUNNING (the worker owns it)."""
        scene = _scene(db, dev_user_id)
        claim = _fresh_claim()
        job = _job(db, scene, status=JobStatus.QUEUED.value, claim=claim)
        _collision(db, scene.id, status="RUNNING", job_id=job.id)
        _worker_claimed(db, job)

        svc = _svc(db, _SendTaskRecorder())
        assert svc._record_broker_failure(job.id, expected_claim=claim) is False
        row = _job_row(db, job.id)
        assert row.status == JobStatus.RUNNING.value, (
            f"a late broker failure FAILED a running build: {row.status}"
        )
        assert row.celery_task_id == claim
        assert _coll_row(db, scene.id).status == "RUNNING"

    def test_b02_late_broker_failure_cannot_fail_a_succeeded_job(self, db, dev_user_id):
        """B-02: worker already SUCCEEDED → a late failure changes nothing."""
        scene = _scene(db, dev_user_id)
        claim = _fresh_claim()
        job = _job(db, scene, status=JobStatus.QUEUED.value, claim=claim)
        _collision(db, scene.id, status="SUCCEEDED", job_id=job.id)
        row = _job_row(db, job.id)
        row.status = JobStatus.SUCCEEDED.value
        db.commit()

        svc = _svc(db, _SendTaskRecorder())
        assert svc._record_broker_failure(job.id, expected_claim=claim) is False
        row = _job_row(db, job.id)
        assert row.status == JobStatus.SUCCEEDED.value
        assert row.celery_task_id == claim
        assert _coll_row(db, scene.id).status == "SUCCEEDED"

    def test_b03_late_failure_after_claim_replaced_is_dropped(self, db, dev_user_id):
        """B-03: A's claim was replaced by B's → A's late failure must not
        touch B's job."""
        scene = _scene(db, dev_user_id)
        claim_a = _fresh_claim()
        job = _job(db, scene, status=JobStatus.QUEUED.value, claim=claim_a)
        _collision(db, scene.id, status="QUEUED", job_id=job.id)
        claim_b = _fresh_claim()
        row = _job_row(db, job.id)
        row.celery_task_id = claim_b
        db.commit()

        svc = _svc(db, _SendTaskRecorder())
        assert svc._record_broker_failure(job.id, expected_claim=claim_a) is False
        row = _job_row(db, job.id)
        assert row.celery_task_id == claim_b
        assert row.status == JobStatus.QUEUED.value

    def test_b04_late_success_after_claim_replaced_is_dropped(self, db, dev_user_id):
        """B-04: A's late *confirmation* must not overwrite B's claim/task id."""
        scene = _scene(db, dev_user_id)
        claim_a = _fresh_claim()
        job = _job(db, scene, status=JobStatus.QUEUED.value, claim=claim_a)
        _collision(db, scene.id, status="QUEUED", job_id=job.id)
        claim_b = _fresh_claim()
        row = _job_row(db, job.id)
        row.celery_task_id = claim_b
        db.commit()

        svc = _svc(db, _SendTaskRecorder())
        assert svc._record_broker_confirmation(
            job.id, expected_claim=claim_a, task_id="celery-late"
        ) is False
        assert _job_row(db, job.id).celery_task_id == claim_b

    def test_b05_uncertain_dispatch_failure_stays_recoverable(self, db, dev_user_id):
        """B-05: the send raised while the job is still QUEUED → the outcome is
        UNCERTAIN, so the job must stay QUEUED and recoverable (claim cleared
        for the reconcile), never permanently FAILED."""
        scene = _scene(db, dev_user_id)
        recorder = _SendTaskRecorder()
        recorder.raise_after_accept = True
        svc = _svc(db, recorder)

        resp = svc.ensure_auto_collision_for_current_version(scene.id, dev_user_id)
        assert resp is not None
        assert resp.status == "QUEUED", resp.status
        jobs = _build_jobs(db, scene.id)
        assert len(jobs) == 1
        row = _job_row(db, jobs[0].id)
        assert row.status == JobStatus.QUEUED.value, (
            f"an uncertain dispatch permanently FAILED the job: {row.status}"
        )
        assert row.error_code != "COLLISION_DISPATCH_FAILED"
        assert row.celery_task_id is None, "claim must be cleared for recovery"
        assert _coll_row(db, scene.id).status != "FAILED"

    def test_b06_recoverable_dispatch_is_retried_on_the_same_job(self, db, dev_user_id):
        """B-06: after the recoverable state the scheduled reconcile re-sends
        the SAME job (never a second job, never a storm)."""
        scene = _scene(db, dev_user_id)
        recorder = _SendTaskRecorder()
        recorder.raise_after_accept = True
        svc = _svc(db, recorder)
        svc.ensure_auto_collision_for_current_version(scene.id, dev_user_id)
        recorder.raise_after_accept = False
        recorder.calls.clear()

        svc.reconcile_auto_collision()

        jobs = _build_jobs(db, scene.id)
        assert len(jobs) == 1, "recovery created a second job"
        assert _job_row(db, jobs[0].id).celery_task_id is not None
        assert len(_dispatches_for(recorder, scene.id)) == 1

    def test_b07_old_callback_after_new_version_is_ignored(self, db, dev_user_id):
        """B-07: an old sender's callback after a new publish must not touch
        the new version's job or collision."""
        from app.db.models.scene import SceneVersion

        scene = _scene(db, dev_user_id)
        recorder = _SendTaskRecorder()
        svc = _svc(db, recorder)
        svc.ensure_auto_collision_for_current_version(scene.id, dev_user_id)
        old_job = _build_jobs(db, scene.id)[0]
        old_claim = _job_row(db, old_job.id).celery_task_id

        # The OLD worker finishes the OLD version's build (SUCCEEDED) — the
        # collision's build_params are still bound to the OLD asset_version.
        old_row = _job_row(db, old_job.id)
        old_row.status = JobStatus.SUCCEEDED.value
        db.commit()
        old_coll = _coll_row(db, scene.id)
        old_coll.status = "SUCCEEDED"
        # build_params already carry the old version (set by ensure).

        # New publish → new version → the SUCCEEDED-but-old-version collision
        # is rebuilt: ensure creates a NEW job for the new version.
        ver = SceneVersion(
            scene_id=scene.id, asset_version=uuid.uuid4().hex[:40],
            format="streamed-sog", size_bytes=2048,
            manifest={"stream": {"counts": [1, 2, 3]}},
        )
        db.add(ver)
        db.flush()
        scene.current_version_id = ver.id
        db.commit()
        recorder.calls.clear()
        svc.ensure_auto_collision_for_current_version(scene.id, dev_user_id)
        new_job = _build_jobs(db, scene.id)[-1]
        assert new_job.id != old_job.id
        new_claim = _job_row(db, new_job.id).celery_task_id

        # The OLD sender reports a late failure against the OLD job.
        svc._record_broker_failure(old_job.id, expected_claim=old_claim)

        assert _job_row(db, old_job.id).status == JobStatus.SUCCEEDED.value, (
            "the late failure flipped the OLD finished job"
        )
        assert _job_row(db, new_job.id).celery_task_id == new_claim
        assert _job_row(db, new_job.id).status == JobStatus.QUEUED.value
        assert _coll_row(db, scene.id).job_id == new_job.id
        assert _coll_row(db, scene.id).status == "QUEUED"

    def test_b08_manual_build_late_failure_is_safe(self, db, dev_user_id):
        """B-08: manual create_and_build whose send timed out after the broker
        accepted must not FAILED anything, and a later worker success stands."""
        from app.schemas.collision import CollisionAssetCreateRequest

        scene = _scene(db, dev_user_id)
        recorder = _SendTaskRecorder()
        recorder.raise_after_accept = True
        svc = _svc(db, recorder)
        resp = svc.create_and_build(
            scene.slug, CollisionAssetCreateRequest(mode="OUTDOOR"), dev_user_id
        )
        jobs = _build_jobs(db, scene.id)
        assert len(jobs) == 1
        row = _job_row(db, jobs[0].id)
        assert row.status == JobStatus.QUEUED.value, (
            f"manual build: uncertain send permanently FAILED the job: {row.status}"
        )
        assert row.celery_task_id is None
        assert _coll_row(db, scene.id).status == "QUEUED"
        assert resp is not None

        # The broker did get it: the worker completes the build.
        row.status = JobStatus.SUCCEEDED.value
        db.commit()
        coll = _coll_row(db, scene.id)
        coll.status = "SUCCEEDED"
        db.commit()
        svc._record_broker_failure(jobs[0].id, expected_claim=_fresh_claim())
        assert _job_row(db, jobs[0].id).status == JobStatus.SUCCEEDED.value
        assert _coll_row(db, scene.id).status == "SUCCEEDED"

    def test_b09_manual_rebuild_late_failure_is_safe(self, db, dev_user_id):
        """B-09: manual rebuild shares the same safe dispatch contract."""
        scene = _scene(db, dev_user_id)
        recorder = _SendTaskRecorder()
        svc = _svc(db, recorder)
        svc.create_and_build(
            scene.slug,
            __import__(
                "app.schemas.collision", fromlist=["CollisionAssetCreateRequest"]
            ).CollisionAssetCreateRequest(mode="OUTDOOR"),
            dev_user_id,
        )
        # The first build ran and finished (the collision is no longer QUEUED),
        # then the send to rebuild timed out after the broker accepted.
        coll = _coll_row(db, scene.id)
        coll.status = "FAILED"
        db.commit()
        recorder.raise_after_accept = True
        resp = svc.rebuild(scene.slug, dev_user_id)
        assert resp is not None
        jobs = _build_jobs(db, scene.id)
        assert len(jobs) == 2, "rebuild must create a fresh job"
        row = _job_row(db, jobs[-1].id)
        assert row.status == JobStatus.QUEUED.value, (
            f"manual rebuild: uncertain send permanently FAILED the job: {row.status}"
        )
        assert row.celery_task_id is None
        assert _coll_row(db, scene.id).status == "QUEUED"

    def test_b10_repeated_recovery_creates_no_duplicate_or_storm(self, db, dev_user_id):
        """B-10: repeated recovery passes never stack jobs or storms."""
        scene = _scene(db, dev_user_id)
        recorder = _SendTaskRecorder()
        svc = _svc(db, recorder)
        svc.ensure_auto_collision_for_current_version(scene.id, dev_user_id)
        recorder.calls.clear()
        for _ in range(4):
            svc.reconcile_auto_collision()
        assert len(_build_jobs(db, scene.id)) == 1
        assert len(_dispatches_for(recorder, scene.id)) == 0, (
            "a healthy confirmed dispatch was re-sent by the reconcile"
        )


# ─────────────────────────────────────────────────────────────────────────────
# PART A — scheduled orphan recovery (A-10 / A-11)
# ─────────────────────────────────────────────────────────────────────────────
class TestScheduledOrphanRecovery:
    def test_a10_expired_execution_lease_is_recovered(self, db, dev_user_id):
        """A-10: the worker died (RUNNING, lease expired) and Celery never
        redelivers — the scheduled reconcile must re-claim the SAME job with a
        fresh dispatch and a cleared lease."""
        scene = _scene(db, dev_user_id)
        recorder = _SendTaskRecorder()
        svc = _svc(db, recorder)
        svc.ensure_auto_collision_for_current_version(scene.id, dev_user_id)
        job = _build_jobs(db, scene.id)[0]

        # The worker claimed and then died: RUNNING with an expired lease.
        _worker_claimed(db, job, generation=1)
        _expire_lease(db, job.id)
        recorder.calls.clear()

        svc.reconcile_auto_collision()

        row = _job_row(db, job.id)
        assert row.status == JobStatus.QUEUED.value, (
            f"the orphan RUNNING job was not re-queued: {row.status}"
        )
        assert row.lease_expires_at is None, "the dead lease was not cleared"
        assert len(_dispatches_for(recorder, scene.id)) == 1, (
            "the orphan was not re-dispatched"
        )
        assert len(_build_jobs(db, scene.id)) == 1, "recovery stacked a second job"

    def test_a11_live_lease_is_not_recovered(self, db, dev_user_id):
        """A-11: a RUNNING job whose lease is still live is never touched by
        the reconcile (no duplicate builds while a worker is alive)."""
        scene = _scene(db, dev_user_id)
        recorder = _SendTaskRecorder()
        svc = _svc(db, recorder)
        svc.ensure_auto_collision_for_current_version(scene.id, dev_user_id)
        job = _build_jobs(db, scene.id)[0]
        _worker_claimed(db, job, generation=1, lease_s=300.0)
        recorder.calls.clear()

        svc.reconcile_auto_collision()

        row = _job_row(db, job.id)
        assert row.status == JobStatus.RUNNING.value
        assert _dispatches_for(recorder, scene.id) == [], (
            "the reconcile re-dispatched a live build"
        )

    def test_a12_persistently_failing_job_is_capped(self, db, dev_user_id):
        """A-12: an orphan job that has already been reclaimed too many times
        is NOT auto-recovered again — no infinite retry storm; the manual
        rebuild entry remains."""
        from app.services.collision import _MAX_AUTO_RECOVERY_ATTEMPTS

        scene = _scene(db, dev_user_id)
        recorder = _SendTaskRecorder()
        svc = _svc(db, recorder)
        svc.ensure_auto_collision_for_current_version(scene.id, dev_user_id)
        job = _build_jobs(db, scene.id)[0]

        _worker_claimed(db, job, generation=_MAX_AUTO_RECOVERY_ATTEMPTS)
        _expire_lease(db, job.id)
        recorder.calls.clear()

        svc.reconcile_auto_collision()

        row = _job_row(db, job.id)
        assert row.status == JobStatus.RUNNING.value, (
            "a job past the recovery cap was resurrected anyway"
        )
        assert _dispatches_for(recorder, scene.id) == [], (
            "recovery cap ignored — infinite retry storm"
        )
        # Manual rebuild is still available for the owner.
        resp = svc.rebuild(scene.slug, dev_user_id)
        assert resp is not None and resp.status == "QUEUED"
        assert _job_row(db, _build_jobs(db, scene.id)[-1].id).execution_generation == 0
