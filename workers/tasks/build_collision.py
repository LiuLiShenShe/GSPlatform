"""Celery task — collision build (Phase 12; SSV-07 real generator).

Dispatched by the API producer (``tasks.build_collision``). Executes:

1. Loads the scene's SOG / streamed-SOG source from storage — pinned to the
   ``source_version`` (SceneVersion UUID) the API recorded at dispatch.
2. Runs the official ``splat-transform`` generator, which voxelizes the scene
   and writes BOTH formats the official SuperSplat viewer consumes:
   ``collision.voxel.json`` + ``collision.voxel.bin`` (native ``VoxelCollision``)
   and ``collision.glb`` (``MeshCollision`` fallback). INDOOR / OUTDOOR is the
   voxel **generation policy** (carve vs floor-fill), never a runtime mode.
3. Persists per-job Asset rows pinned to the source version + CollisionAsset
   status.

FIX-UPLOAD-01.1 §C/§D concurrency contract:

- every build carries a pinned ``source_version`` (6th task arg); tasks queued
  before that arg shipped fall back to the scene's CURRENT version;
- output is isolated per build: ``collision/<sid>/versions/<asset>/jobs/<jobId>/``
  so a stale worker can never overwrite a newer build's files;
- before finalizing, the worker re-checks ownership: the scene must still point
  at the pinned version, the collision row must still point at THIS job, and the
  job must not have been terminalized.  A stale worker FAILs its own job with
  the stable code ``COLLISION_SUPERSEDED`` and leaves the newer collision alone;
- duplicate delivery of a terminal job is a no-op (no regeneration).

FIX-UPLOAD-01.2 PART B — atomic finalization contract:

- **execution-rights claim**: a worker that finds the job QUEUED atomically
  claims it (QUEUED → RUNNING) under a FOR UPDATE lock, stamping
  ``started_at`` with the DATABASE clock.  Two workers delivered the same job
  → exactly one wins; the loser is a duplicate no-op.
- **finalization is a single locked transaction**: Scene → CollisionAsset →
  Job are locked FOR UPDATE in that order, re-read fresh, and ownership +
  version alignment are validated BEFORE any write; Asset rows, the collision
  row and the Job row are then written in ONE COMMIT.  A stale worker is
  superseded and never touches a newer collision/job; a failed commit rolls
  back everything (no half-commits).

FIX-UPLOAD-01.3 — execution fencing, lease heartbeat, per-attempt dirs:

- **execution generation**: ``Job.execution_generation`` is a monotonic ordinal
  advanced ONLY inside the FOR UPDATE claim transaction.  Every execution
  attempt owns exactly one generation; only that generation may commit the
  build (finalize), FAIL it, or supersede it.  A redelivered/restarted worker
  for the *same* job that finds the lease expired mints generation+1.
- **lease heartbeat**: a live worker runs a background heartbeat that renews
  ``Job.lease_expires_at`` (DB clock) every ``_HEARTBEAT_INTERVAL_S`` in short
  sessions, guarded by ``execution_generation`` and ``status='RUNNING'``.  A
  build longer than the old fixed TTL can therefore never be stolen while its
  heartbeat runs; when the heartbeat stops (crash), the lease expires and
  recovery may reclaim.  ``started_at`` keeps its "task began" meaning and is
  never renewed.
- **per-attempt output isolation**: artifacts land in
  ``.../jobs/<jobId>/attempts/<generation>/`` so two executions of the same job
  never share files; the committed Asset rows pin the generation that built
  them (``metadata_["executionGeneration"]``).
- **fenced failure/supersede**: an old generation can never FAIL the job that a
  newer generation owns, never touch its CollisionAsset, and never delete its
  files (``OLD_EXECUTION_SUPERSEDED``).

Failure is journaled into the DB so the API can expose it and the user can
rebuild (``build failure 可恢复`` / ``collision 可重建``).
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from app.core.config import settings
from app.db.models.asset import Asset
from app.db.models.enums import AssetKind, JobStatus
from app.db.models.job import Job
from app.db.session import SessionLocal
from app.storage.local_disk import LocalDiskStorage
from sqlalchemy import or_, update

from workers.celery_app import celery_app

logger = logging.getLogger("gsplatform.workers.build_collision")

_STORAGE_ROOT = Path(settings.storage_root)

_TERMINAL = {
    JobStatus.SUCCEEDED.value,
    JobStatus.FAILED.value,
    JobStatus.CANCELLED.value,
    JobStatus.CANCEL_REQUESTED.value,
}

# FIX-UPLOAD-01.3: an execution lease older than this many seconds (DB clock)
# means the claiming worker died — a recovery reclaim mints a new generation.
# The heartbeat renews the lease every ``_HEARTBEAT_INTERVAL_S``, so a live
# build of ANY duration stays untouchable; the TTL only bounds crash recovery.
_EXECUTION_LEASE_TTL_S = 300.0
_HEARTBEAT_INTERVAL_S = 30.0
_HEARTBEAT_MAX_RETRIES = 3


def _db_now(session) -> float:
    """Database clock epoch seconds — the authoritative lease clock."""
    from sqlalchemy import text

    row = session.execute(text("SELECT EXTRACT(EPOCH FROM clock_timestamp())")).first()
    return float(row[0])


def _dt_from_epoch(epoch: float):
    from datetime import UTC, datetime

    return datetime.fromtimestamp(epoch, tz=UTC)


@dataclass(frozen=True)
class ExecutionClaim:
    """Result of an atomic execution-rights claim (FIX-UPLOAD-01.3).

    ``decision``:
      ``EXECUTE``  — this worker owns execution generation ``generation`` and
                     may run the generator;
      ``BUSY``     — another (live) worker owns the job; we are a duplicate;
      ``TERMINAL`` — the job already reached ``status``; no-op;
      ``MISSING``  — the job row is gone; no-op.
    """

    decision: str
    generation: int = 0
    status: str = ""


def _load_job(session, job_id: str) -> Job | None:
    return session.query(Job).filter(Job.id == uuid.UUID(job_id)).first()


def _load_collision(session, collision_id: str):
    from app.db.models.collision_asset import CollisionAsset

    return (
        session.query(CollisionAsset)
        .filter(CollisionAsset.id == uuid.UUID(collision_id))
        .first()
    )


def _load_scene(session, scene_id: uuid.UUID):
    from app.db.models.scene import Scene

    return session.query(Scene).filter(Scene.id == scene_id).first()


def _find_sog_asset(
    session,
    scene_id: uuid.UUID,
    expected_version_id: uuid.UUID | None = None,
) -> Asset | None:
    """Find the SOG asset for the collision's *pinned* version (§C/§D).

    ``expected_version_id`` is the SceneVersion UUID recorded on the job at
    dispatch; when a pre-§D task (no 6th arg) runs, it falls back to the
    scene's CURRENT version.  Selecting by ``created_at DESC`` could pick an
    OLD version's SOG — we select by ``Asset.version_id`` instead, the same
    persistent association publishing records.
    """
    from app.db.models.scene import Scene

    if not isinstance(scene_id, uuid.UUID):
        return None
    scene = session.query(Scene).filter(Scene.id == scene_id).first()
    if scene is None or scene.current_version_id is None:
        return None
    target_version_id = expected_version_id or scene.current_version_id
    kinds = (AssetKind.SOG.value, AssetKind.STREAM_INDEX.value)
    asset = (
        session.query(Asset)
        .filter(
            Asset.scene_id == scene_id,
            Asset.version_id == target_version_id,
            or_(*[Asset.kind == k for k in kinds]),
        )
        .order_by(Asset.created_at.asc())
        .first()
    )
    return asset


def _claim_execution_rights(session, job_id: str) -> ExecutionClaim:
    """Atomic execution-rights claim (FIX-UPLOAD-01.3 A3).

    Under a FOR UPDATE lock (``populate_existing`` defeats the ORM identity
    map so a concurrent winner's committed RUNNING row is seen fresh):

    * job missing → ``MISSING``;
    * terminal job → ``TERMINAL(status)`` (B-06 / §D no-op guard);
    * QUEUED → mint generation+1, RUNNING, ``started_at`` + a fresh
      ``lease_expires_at`` from the DATABASE clock → ``EXECUTE(generation)``;
    * RUNNING + live lease → another worker holds it → ``BUSY`` — never taken
      over while the heartbeat renews (a build of any length is safe);
    * RUNNING + no lease + no ``started_at`` → legacy directly-invoked build
      (pre-01.3); adopt a fresh lease and execute;
    * RUNNING + no lease but ``started_at`` set → a pre-migration row whose
      lease is unknown → ``BUSY`` (never double-run without proof of expiry);
    * RUNNING + expired lease → the claiming worker died; reclaim (mint
      generation+1, fresh lease) and execute.

    Only one concurrent worker wins a reclaim: the row is locked, so a
    second claimant observes the fresh lease and returns ``BUSY``.
    """
    from sqlalchemy import select

    job = session.scalars(
        select(Job)
        .where(Job.id == uuid.UUID(job_id))
        .with_for_update()
        .execution_options(populate_existing=True)
    ).first()
    if job is None:
        session.rollback()
        return ExecutionClaim(decision="MISSING")
    if job.status in _TERMINAL:
        session.rollback()
        return ExecutionClaim(decision="TERMINAL", status=job.status)

    now = _db_now(session)
    if job.status == JobStatus.QUEUED.value:
        generation = job.execution_generation + 1
        job.execution_generation = generation
        job.status = JobStatus.RUNNING.value
        job.started_at = _dt_from_epoch(now)
        job.lease_expires_at = _dt_from_epoch(now + _EXECUTION_LEASE_TTL_S)
        session.commit()
        return ExecutionClaim(decision="EXECUTE", generation=generation)

    # status == RUNNING
    lease = job.lease_expires_at
    if lease is not None and lease.timestamp() > now:
        # A live worker (heartbeat renews this) owns the job.
        session.rollback()
        return ExecutionClaim(
            decision="BUSY", generation=job.execution_generation, status=job.status
        )
    if lease is None and job.started_at is None:
        # Legacy directly-invoked RUNNING build (pre-01.3 dispatch): adopt.
        generation = job.execution_generation + 1
        job.execution_generation = generation
        job.started_at = _dt_from_epoch(now)
        job.lease_expires_at = _dt_from_epoch(now + _EXECUTION_LEASE_TTL_S)
        session.commit()
        return ExecutionClaim(decision="EXECUTE", generation=generation)
    if lease is None:
        # RUNNING with an unknown lease (pre-migration row): without proof of
        # expiry we must never double-run.  The scheduled recovery or a manual
        # rebuild decides what to do.
        session.rollback()
        return ExecutionClaim(
            decision="BUSY", generation=job.execution_generation, status=job.status
        )
    # lease is set and expired → the claiming worker crashed.  Reclaim.
    generation = job.execution_generation + 1
    job.execution_generation = generation
    job.started_at = _dt_from_epoch(now)
    job.lease_expires_at = _dt_from_epoch(now + _EXECUTION_LEASE_TTL_S)
    session.commit()
    return ExecutionClaim(decision="EXECUTE", generation=generation)


class LeaseHeartbeat:
    """FIX-UPLOAD-01.3 A4 — renew the execution lease while the build runs.

    A daemon thread renews ``Job.lease_expires_at`` (DB clock) every
    ``interval_s`` through a fresh, short-lived session.  The UPDATE is fenced
    on ``execution_generation`` + ``status='RUNNING'``: once the job leaves
    this generation (reclaimed) or reaches a terminal state, the heartbeat
    stops and marks ``lost`` — the worker then has NO lease guarantee left and
    the finalize's own lease check refuses it.

    Bounded retries (no silent infinite failures); the thread is always joined
    in ``stop()`` and never outlives the task.
    """

    def __init__(
        self,
        *,
        job_id,
        generation: int,
        session_factory=None,
        interval_s: float | None = None,
        lease_ttl_s: float | None = None,
    ) -> None:
        self._job_id = uuid.UUID(str(job_id))
        self._generation = generation
        self._session_factory = session_factory
        # Resolved at construction time (module globals, not def-time defaults)
        # so tests and config changes to the cadence take effect.
        self._interval_s = _HEARTBEAT_INTERVAL_S if interval_s is None else interval_s
        self._lease_ttl_s = (
            _EXECUTION_LEASE_TTL_S if lease_ttl_s is None else lease_ttl_s
        )
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lost = False

    @property
    def lost(self) -> bool:
        return self._lost

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def is_alive(self) -> bool:
        """Alias used by tests: the heartbeat thread must not outlive the task."""
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._lost = False
        self._thread = threading.Thread(
            target=self._run,
            name=f"collision-lease-{self._job_id}",
            daemon=True,
        )
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)
            self._thread = None

    # -- internals ------------------------------------------------------------
    def _run(self) -> None:
        retries = 0
        while not self._stop.is_set():
            try:
                ok = self._renew_once()
            except Exception:  # pragma: no cover - surfaced via lost flag
                retries += 1
                if retries > _HEARTBEAT_MAX_RETRIES:
                    self._lost = True
                    logger.error(
                        "lease heartbeat gave up for job %s after %d failures",
                        self._job_id, retries,
                    )
                    return
                time.sleep(min(2.0 ** retries, 8.0))
                continue
            retries = 0
            if not ok:
                # The row no longer belongs to our generation / is terminal.
                self._lost = True
                logger.warning(
                    "lease heartbeat lost ownership of job %s generation %d",
                    self._job_id, self._generation,
                )
                return
            self._stop.wait(self._interval_s)

    def _renew_once(self) -> bool:
        """Advance the lease only for OUR generation while RUNNING."""
        factory = self._session_factory or SessionLocal
        sess = factory()
        try:
            now = _db_now(sess)
            result = sess.execute(
                update(Job)
                .where(
                    Job.id == self._job_id,
                    Job.execution_generation == self._generation,
                    Job.status == JobStatus.RUNNING.value,
                )
                .values(lease_expires_at=_dt_from_epoch(now + self._lease_ttl_s))
            )
            sess.commit()
            return result.rowcount == 1
        finally:
            sess.close()


@celery_app.task(name="tasks.build_collision", bind=True)
def build_collision(
    self,
    job_id: str,
    scene_id: str,
    collision_id: str,
    mode: str,
    world_transform_hash: str | None = None,
    source_version: str | None = None,
) -> dict:
    """Build collision mesh for a scene.

    ``world_transform_hash`` (FIX-05 §23) is the world transform the API
    recorded at dispatch; it is stored on the SUCCEEDED build so the runtime
    descriptor can flag the collision STALE when the transform later changes.

    ``source_version`` (FIX-UPLOAD-01.1 §D) is the pinned SceneVersion UUID the
    SOG must be loaded from.  ``None`` → tasks queued before this arg shipped
    fall back to the scene's current version (backward compatible).
    """
    session = SessionLocal()
    storage = LocalDiskStorage(_STORAGE_ROOT)
    sid = uuid.UUID(scene_id)
    claimed_generation: int | None = None
    heartbeat: LeaseHeartbeat | None = None

    try:
        job = _load_job(session, job_id)
        collision = _load_collision(session, collision_id)
        if job is None or collision is None:
            logger.error(
                "build_collision: job=%s collision=%s missing in DB", job_id, collision_id
            )
            session.close()
            return {"ok": False, "error": "DB_ROW_MISSING"}

        # §D duplicate-delivery guard: a terminal job must never be mutated
        # again (no regeneration, no status flip) — redelivery after
        # acks_late/crash is absorbed here.
        if job.status in _TERMINAL:
            logger.info(
                "build_collision: job %s already %s; duplicate delivery", job_id, job.status
            )
            session.close()
            return {"ok": True, "duplicate": True, "job_status": job.status}

        # ── FIX-UPLOAD-01.3: atomic execution-rights claim ───────────────────
        claim = _claim_execution_rights(session, job_id)
        if claim.decision != "EXECUTE":
            # Another worker owns execution rights (or the job became terminal
            # between our read and our lock).  Duplicate no-op.
            logger.info(
                "build_collision: job %s claim=%s; duplicate delivery",
                job_id, claim.decision,
            )
            session.close()
            return {"ok": True, "duplicate": True, "job_status": claim.decision}
        claimed_generation = claim.generation
        # Job is RUNNING (committed claim).  Reload fresh — the identity map
        # was expired by the claim commit.
        session.expire_all()
        job = _load_job(session, job_id)
        collision = _load_collision(session, collision_id)

        # ── Pin the source SceneVersion (§D) ────────────────────────────────
        from app.db.models.scene import SceneVersion

        pinned: SceneVersion | None = None
        if source_version is not None:
            pinned = session.get(SceneVersion, uuid.UUID(source_version))
        if pinned is None:
            # Backward-compatible fallback: the scene's CURRENT version.
            scene = _load_scene(session, sid)
            if scene is not None and scene.current_version_id is not None:
                pinned = session.get(SceneVersion, scene.current_version_id)
        if pinned is None:
            raise FileNotFoundError("没有可构建的发布版本（SceneVersion 缺失）")
        src_version_id = pinned.id
        asset_version = pinned.asset_version

        # Locate source SOG — pinned to the build's version (§C).
        sog = _find_sog_asset(session, sid, expected_version_id=src_version_id)
        if sog is None:
            raise FileNotFoundError("找不到钉扎版本的 SOG 源文件；请先发布场景资产")

        sog_path = storage._path(sog.storage_key)
        if not sog_path.exists():
            raise FileNotFoundError(f"SOG 文件不存在: {sog.storage_key}")
        # §C: the SOG entry is lod-meta.json (the streamed index).  Anything
        # else is not the publish-service SOG we must build collision from.
        if sog_path.name != "lod-meta.json":
            raise FileNotFoundError(
                f"SOG 资产不是流式索引 (lod-meta.json): {sog.storage_key}"
            )
        if not (sog_path.parent / "manifest.json").exists():
            raise FileNotFoundError(f"SOG 版本目录不完整: {sog_path.parent}")

        # Release the read transaction — the generator below runs multi-minute
        # and must hold NO transaction/locks (PART B).
        session.rollback()

        # ── Cheap pre-build ownership gate (§C / FIX-UPLOAD-01.3) ────────────
        # Fast-fail before burning GPU/CPU; the AUTHORITATIVE check happens
        # inside the locked finalization transaction.
        if not _still_owned(
            session, sid, uuid.UUID(job_id), src_version_id, claimed_generation
        ):
            return _mark_superseded(
                session, uuid.UUID(job_id), collision_id, sid, claimed_generation
            )
        session.rollback()  # release the gate's read transaction

        # ── Per-attempt output isolation (FIX-UPLOAD-01.3 A5) ─────────────────
        # collision/{sceneId}/versions/<assetVersion>/jobs/<collisionJobId>/
        #     attempts/<executionGeneration>/
        rel_dir = (
            f"collision/{sid}/versions/{asset_version}/jobs/{job_id}"
            f"/attempts/{claimed_generation}"
        )
        out_dir = storage._path(rel_dir)
        out_dir.mkdir(parents=True, exist_ok=True)

        # ── Start the lease heartbeat (A4) ──────────────────────────────────
        heartbeat = LeaseHeartbeat(job_id=job_id, generation=claimed_generation)
        heartbeat.start()

        # ── Run the official generator (SSV-07) ──────────────────────────────
        # splat-transform produces BOTH official collision formats:
        #   collision.voxel.json + .voxel.bin  (VoxelCollision, preferred)
        #   collision.glb                      (MeshCollision, fallback)
        # INDOOR / OUTDOOR stays a *generation policy* (voxel flood fill), never
        # a viewer runtime mode.
        from workers.collision.splat import (
            SplatCollisionError,
            build_collision_artifacts,
        )

        result = build_collision_artifacts(sog_path, out_dir, mode=mode)

        if not result.ok:
            raise SplatCollisionError(
                "碰撞构建未产出任何可用工件: "
                + ("; ".join(result.warnings) or "未知原因")
            )

        # Stop the heartbeat BEFORE finalize so the lease state is stable while
        # the final (locked, fast) transaction runs; the lease was renewed at
        # most ``_HEARTBEAT_INTERVAL_S`` ago, so ≥ TTL − interval of margin
        # remains for the finalize's own lease check.
        heartbeat.stop()

        # ── FIX-UPLOAD-01.3: locked finalization (single transaction) ────────
        return _finalize_build(
            session,
            job_id=uuid.UUID(job_id),
            collision_id=uuid.UUID(collision_id),
            scene_id=sid,
            mode=mode,
            world_transform_hash=world_transform_hash,
            src_version_id=src_version_id,
            asset_version=asset_version,
            rel_dir=rel_dir,
            result=result,
            storage=storage,
            generation=claimed_generation,
        )

    except Exception as exc:
        session.rollback()
        logger.exception("Collision build FAILED for scene %s", scene_id)
        # FIX-UPLOAD-01.3: the failure path re-locks fresh state in the unified
        # lock order and only FAILs the collision the job's CURRENT generation
        # still owns — a stale generation never fails a newer one.
        return _fail_build(
            session,
            uuid.UUID(job_id),
            uuid.UUID(collision_id),
            sid,
            exc,
            generation=claimed_generation,
        )

    finally:
        if heartbeat is not None:
            heartbeat.stop()  # idempotent; no lingering thread (A4.9/A4.10)
        session.close()


def _finalize_build(
    session,
    *,
    job_id: uuid.UUID,
    collision_id: uuid.UUID,
    scene_id: uuid.UUID,
    mode: str,
    world_transform_hash: str | None,
    src_version_id: uuid.UUID,
    asset_version: str,
    rel_dir: str,
    result,
    storage,
    generation: int,
) -> dict:
    """FIX-UPLOAD-01.3 — finalize in ONE locked transaction with fencing.

    Lock order **Scene → CollisionAsset → Job** (matching the API takeover),
    fresh reads only (``populate_existing`` defeats the ORM identity map).
    Validation before any write (A6):

    * the scene still points at the pinned SceneVersion;
    * the collision row still points at THIS job;
    * the collision's recorded ``build_params.sourceVersionId`` (if any)
      still matches the pinned version;
    * the job belongs to this scene and is RUNNING;
    * ``job.execution_generation == generation`` — THIS worker's execution is
      still the current one (a reclaim minted a newer generation → refuse);
    * the execution lease is still valid (heartbeat renewed it; a worker that
      lost its lease has no commit rights).

    Any failure ⇒ ``COLLISION_SUPERSEDED`` (the OLD job is FAILed, the newer
    collision/job are never touched) or ``OLD_EXECUTION_SUPERSEDED`` (a newer
    execution of the SAME job owns it — nothing is written).  On success the
    Asset rows + collision row + job row are committed TOGETHER.
    """
    from app.db.models.collision_asset import CollisionAsset
    from app.db.models.scene import Scene
    from sqlalchemy import select

    session.rollback()  # clean boundary: new transaction below
    # Lock order Scene → CollisionAsset → Job, fresh reads.
    scene = session.scalars(
        select(Scene)
        .where(Scene.id == scene_id)
        .with_for_update(of=Scene)
        .execution_options(populate_existing=True)
    ).first()
    if scene is None:
        raise FileNotFoundError(f"场景不存在: {scene_id}")
    coll = session.scalars(
        select(CollisionAsset)
        .where(CollisionAsset.id == collision_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).first()
    if coll is None:
        raise FileNotFoundError(f"碰撞行不存在: {collision_id}")
    job = session.scalars(
        select(Job)
        .where(Job.id == job_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).first()
    if job is None:
        raise FileNotFoundError(f"任务不存在: {job_id}")

    # ── Final ownership + version + FENCING validation (fresh, under locks) ──
    bp_source = (coll.build_params or {}).get("sourceVersionId")
    lease_valid = (
        job.lease_expires_at is not None
        and job.lease_expires_at.timestamp() > _db_now(session)
    )
    if (
        scene.current_version_id != src_version_id
        or coll.job_id is None
        or coll.job_id != job_id
        or job.scene_id != scene_id
        or job.status != JobStatus.RUNNING.value
        or job.execution_generation != generation
        or not lease_valid
        or (bp_source is not None and str(bp_source) != str(src_version_id))
    ):
        return _mark_superseded(session, job_id, collision_id, scene_id, generation)

    # ── Persist per-attempt asset rows (pinned to the source version) ─────────
    def _make_collision_asset(kind: str, rel_key: str, mime: str, meta: dict) -> Asset:
        size = storage._path(rel_key).stat().st_size
        sha = storage.sha256(rel_key)
        row = Asset(
            scene_id=scene_id,
            version_id=src_version_id,
            kind=kind,
            storage_key=rel_key,
            mime_type=mime,
            byte_size=size,
            sha256=sha,
            metadata_=meta,
        )
        session.add(row)
        return row

    preferred_asset: Asset | None = None

    # 1) voxel pair (native official format) — preferred.
    if result.voxel_json is not None and result.voxel_bin is not None:
        rel_json = f"{rel_dir}/{result.voxel_json.name}"
        rel_bin = f"{rel_dir}/{result.voxel_bin.name}"
        voxel_asset = _make_collision_asset(
            AssetKind.COLLISION_VOXEL.value,
            rel_json,
            "application/json",
            {
                # The official viewer derives the binary url by replacing
                # '.voxel.json' with '.voxel.bin' on the served json url,
                # so the pair must be served from the same directory.
                "binStorageKey": rel_bin,
                "mode": mode,
                "build": result.to_params(),
                "collisionJobId": str(job_id),
                "executionGeneration": generation,
                "sourceVersion": asset_version,
                "sourceVersionId": str(src_version_id),
            },
        )
        session.flush()
        preferred_asset = voxel_asset

    # 2) collision mesh GLB (fallback) — produced whenever available.
    if result.collision_glb is not None:
        glb_asset = _make_collision_asset(
            AssetKind.COLLISION_GLB.value,
            f"{rel_dir}/{result.collision_glb.name}",
            "model/gltf-binary",
            {
                "mode": mode,
                "build": result.to_params(),
                "collisionJobId": str(job_id),
                "executionGeneration": generation,
                "sourceVersion": asset_version,
                "sourceVersionId": str(src_version_id),
            },
        )
        session.flush()
        if preferred_asset is None:
            preferred_asset = glb_asset

    if preferred_asset is None:  # pragma: no cover - guarded by result.ok
        raise RuntimeError("碰撞构建未产出可用资产")

    collision_asset_id = preferred_asset.id
    build_params = result.to_params()
    # FIX-05 §23：保留 API 在派发时记录的世界变换哈希（STALE 判定基准）。
    build_params["worldTransformHash"] = world_transform_hash
    # FIX-UPLOAD-01.1 §D：持久化版本关联 —— 本碰撞由哪个发布版本构建而来。
    build_params["sourceVersion"] = asset_version
    build_params["sourceVersionId"] = str(src_version_id)
    # FIX-UPLOAD-01.3：记录提交的执行代次（可审计）。
    build_params["executionGeneration"] = generation

    # ── Write collision + job in the SAME transaction as the assets ─────────
    coll.asset_id = collision_asset_id
    coll.job_id = job_id
    coll.build_params = build_params
    coll.status = "SUCCEEDED"
    coll.error_message = None
    job.status = "SUCCEEDED"
    job.stage = "SUCCEEDED"
    job.progress = 100
    session.commit()
    logger.info(
        "Collision build SUCCEEDED for scene %s (%s) generation=%d format=%s",
        scene_id, mode, generation, preferred_asset.kind,
    )
    return {
        "ok": True,
        "mode": mode,
        "asset_id": str(collision_asset_id),
        "format": preferred_asset.kind,
        **result.to_params(),
    }


def _mark_superseded(
    session, job_id: uuid.UUID, collision_id: uuid.UUID, scene_id: uuid.UUID,
    generation: int,
) -> dict:
    """FIX-UPLOAD-01.3 — terminalize an obsolete execution safely.

    Runs in its own transaction under the unified lock order
    (Scene → CollisionAsset → Job) with fresh reads.  Three cases:

    * the SAME job is now owned by a NEWER execution generation
      (``coll.job_id == job_id`` and ``job.execution_generation != generation``
      while RUNNING) → ``OLD_EXECUTION_SUPERSEDED``; NOTHING is written — the
      old generation may never fail the new generation's job (A4/A5/A7);
    * the job is already terminal (the newer execution committed/failed it) →
      ``OLD_EXECUTION_SUPERSEDED``; nothing is written;
    * otherwise (the scene version moved, or a DIFFERENT job took over the
      collision) → this job is genuinely obsolete: FAIL it with the stable
      ``COLLISION_SUPERSEDED`` code; the collision is FAILed (rebuildable)
      ONLY while it still belongs to this job — a newer collision is untouched.
    """
    from app.db.models.collision_asset import CollisionAsset
    from app.db.models.scene import Scene
    from sqlalchemy import select

    session.rollback()  # clean boundary
    scene = session.scalars(
        select(Scene)
        .where(Scene.id == scene_id)
        .with_for_update(of=Scene)
        .execution_options(populate_existing=True)
    ).first()
    if scene is None:  # pragma: no cover - scene vanished
        session.rollback()
        return {"ok": False, "error": "OLD_EXECUTION_SUPERSEDED", "superseded": True}
    coll = session.scalars(
        select(CollisionAsset)
        .where(CollisionAsset.id == collision_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).first()
    job = session.scalars(
        select(Job)
        .where(Job.id == job_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).first()

    same_job_owned = (
        coll is not None
        and job is not None
        and coll.job_id is not None
        and str(coll.job_id) == str(job_id)
    )
    newer_generation_owns_job = (
        same_job_owned
        and job.status not in _TERMINAL
        and job.execution_generation != generation
    )
    if newer_generation_owns_job or (job is not None and job.status in _TERMINAL):
        # A newer execution (or the winner's terminal state) owns the job —
        # the old generation must not FAIL it, touch its CollisionAsset, or
        # delete its files.
        session.rollback()
        return {"ok": False, "error": "OLD_EXECUTION_SUPERSEDED", "superseded": True}

    # Genuinely obsolete job: version moved / another job took over.
    if job is not None and job.status not in _TERMINAL:
        job.status = "FAILED"
        job.error_code = "COLLISION_SUPERSEDED"
        job.error_message_safe = "被更新的碰撞构建任务取代"
    # Only fail the collision if it STILL belongs to this (superseded) job.
    if same_job_owned:
        coll.status = "FAILED"
        coll.error_message = "碰撞构建被更新的版本取代"
    session.commit()
    return {"ok": False, "error": "COLLISION_SUPERSEDED", "superseded": True}


def _fail_build(
    session,
    job_id: uuid.UUID,
    collision_id: uuid.UUID,
    scene_id: uuid.UUID,
    exc: Exception,
    *,
    generation: int | None,
) -> dict:
    """FIX-UPLOAD-01.3 — failure journaling in a fresh LOCKED transaction.

    Re-locks Scene → CollisionAsset → Job, re-reads fresh, and FAILs the
    collision ONLY while the job's CURRENT generation still owns it:

    * ``generation`` is None (we never won the claim) → nothing is written;
    * the job moved to a NEWER generation → nothing is written
      (``OLD_EXECUTION_SUPERSEDED`` semantics — a stale generation can never
      FAIL the live one, A5/B-05);
    * the job is already terminal → nothing is written;
    * otherwise (this generation still owns a RUNNING job) → FAIL the job with
      ``COLLISION_BUILD_FAILED`` and, if the collision row still points at this
      job, FAIL it (rebuildable) — a collision taken over by a newer job is
      never touched (B-04).
    """
    from app.db.models.collision_asset import CollisionAsset
    from app.db.models.scene import Scene
    from sqlalchemy import select

    session.rollback()  # clean boundary: new transaction below
    try:
        scene = session.scalars(
            select(Scene)
            .where(Scene.id == scene_id)
            .with_for_update(of=Scene)
            .execution_options(populate_existing=True)
        ).first()
        if scene is None:  # pragma: no cover - scene vanished
            session.rollback()
            return {"ok": False, "error": str(exc)}
        coll = session.scalars(
            select(CollisionAsset)
            .where(CollisionAsset.id == collision_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        ).first()
        job = session.scalars(
            select(Job)
            .where(Job.id == job_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        ).first()

        owns_generation = (
            generation is not None
            and job is not None
            and job.status not in _TERMINAL
            and job.execution_generation == generation
        )
        if not owns_generation:
            # We never held execution rights, or a newer generation reclaimed
            # the job, or the job is terminal — do not write anything.
            session.rollback()
            return {"ok": False, "error": str(exc)}

        job.status = "FAILED"
        job.error_code = "COLLISION_BUILD_FAILED"
        job.error_message_safe = str(exc)[:1000]
        owns_row = (
            coll is not None
            and coll.job_id is not None
            and str(coll.job_id) == str(job_id)
        )
        if owns_row:
            coll.status = "FAILED"
            coll.error_message = str(exc)[:1000]
        session.commit()
    except Exception:  # pragma: no cover - best-effort bookkeeping
        session.rollback()
    return {"ok": False, "error": str(exc)}


def _still_owned(
    session,
    scene_id: uuid.UUID,
    job_id,
    src_version_id: uuid.UUID,
    generation: int | None,
) -> bool:
    """Ownership re-check before a worker finalizes (§C / FIX-UPLOAD-01.3).

    - the scene still points at the pinned SceneVersion (version did not move);
    - the collision row still points at THIS job (a newer build did not take over);
    - this job is not terminalized by anyone else;
    - (FIX-UPLOAD-01.3) this execution is still the job's current generation and
      its lease is still live (the heartbeat is running).
    """
    from app.db.models.collision_asset import CollisionAsset
    from app.db.models.scene import Scene

    if not isinstance(job_id, uuid.UUID):
        job_id = uuid.UUID(str(job_id))
    scene = session.query(Scene).filter(Scene.id == scene_id).first()
    if scene is None or scene.current_version_id != src_version_id:
        return False
    collision = (
        session.query(CollisionAsset)
        .filter(CollisionAsset.scene_id == scene_id)
        .first()
    )
    if collision is None or collision.job_id is None or collision.job_id != job_id:
        return False
    fresh_job = session.query(Job).filter(Job.id == job_id).first()
    if fresh_job is None or fresh_job.status in _TERMINAL:
        return False
    if fresh_job.status != JobStatus.RUNNING.value:
        return False
    if generation is not None and fresh_job.execution_generation != generation:
        return False
    lease = fresh_job.lease_expires_at
    return not (lease is None or lease.timestamp() <= _db_now(session))
