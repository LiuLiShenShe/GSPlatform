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
  → exactly one wins; the loser is a duplicate no-op.  A job already RUNNING
  *without* a lease (``started_at IS NULL``) is a legacy directly-invoked
  build and proceeds; RUNNING *with* a fresh lease belongs to a live worker
  (duplicate); a lease older than ``_EXECUTION_LEASE_TTL_S`` is a crashed
  worker's — recovery re-claims it (bounded; no uncontrolled retry loop).
- **finalization is a single locked transaction**: Scene → CollisionAsset →
  Job are locked FOR UPDATE in that order, re-read fresh, and ownership +
  version alignment are validated BEFORE any write; Asset rows, the collision
  row and the Job row are then written in ONE COMMIT.  A stale worker is
  superseded and never touches a newer collision/job; a failed commit rolls
  back everything (no half-commits).

Failure is journaled into the DB so the API can expose it and the user can
rebuild (``build failure 可恢复`` / ``collision 可重建``).
"""

from __future__ import annotations

import logging
import uuid
from pathlib import Path

from sqlalchemy import or_

from app.core.config import settings
from app.db.models.asset import Asset
from app.db.models.enums import AssetKind, JobStatus
from app.db.models.job import Job
from app.db.session import SessionLocal
from app.storage.local_disk import LocalDiskStorage
from workers.celery_app import celery_app

logger = logging.getLogger("gsplatform.workers.build_collision")

_STORAGE_ROOT = Path(settings.storage_root)

_TERMINAL = {
    JobStatus.SUCCEEDED.value,
    JobStatus.FAILED.value,
    JobStatus.CANCELLED.value,
    JobStatus.CANCEL_REQUESTED.value,
}

# FIX-UPLOAD-01.2 PART B: a claimed (RUNNING) build whose ``started_at`` lease
# is older than this many seconds is considered orphaned (the claiming worker
# crashed) — a redelivered worker re-claims it.  Fresh leases are never taken
# over, so a live slow build is never double-run.
_EXECUTION_LEASE_TTL_S = 300.0


def _db_now(session) -> float:
    """Database clock epoch seconds — the authoritative lease clock."""
    from sqlalchemy import text

    row = session.execute(text("SELECT EXTRACT(EPOCH FROM clock_timestamp())")).first()
    return float(row[0])


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


def _claim_execution_rights(session, job_id: str) -> str:
    """Atomic execution-rights claim (PART B / B-05/B-06/B-08).

    Returns ``"EXECUTE"`` when THIS worker may run the generator, otherwise a
    stable non-``EXECUTE`` marker (the observed job status) meaning the worker
    is a duplicate and must not run.

    * job missing → treated as duplicate (caller logs/aborts);
    * terminal job → duplicate (B-06 / §D no-op guard);
    * QUEUED → FOR UPDATE claim to RUNNING, ``started_at`` = DB clock; only
      one concurrent worker wins;
    * RUNNING + no lease (legacy directly-invoked build, or a pre-01.2
      dispatch) → adopt the lease and execute;
    * RUNNING + fresh lease → a live worker owns it → duplicate;
    * RUNNING + stale lease → crashed worker; recover (re-claim) and execute.
    """
    from sqlalchemy import select

    # FOR UPDATE + populate_existing: the row is re-read fresh under the lock
    # (the ORM identity map would otherwise return a stale QUEUED copy after
    # a concurrent winner committed RUNNING, letting two workers both claim).
    job = session.scalars(
        select(Job)
        .where(Job.id == uuid.UUID(job_id))
        .with_for_update()
        .execution_options(populate_existing=True)
    ).first()
    if job is None:
        session.rollback()
        return "MISSING"
    if job.status in _TERMINAL:
        session.rollback()
        return job.status
    now = _db_now(session)
    if job.status == JobStatus.QUEUED.value:
        job.status = JobStatus.RUNNING.value
        job.started_at = _dt_from_epoch(now)
        session.commit()
        return "EXECUTE"
    # status == RUNNING
    if job.started_at is None:
        # Legacy directly-invoked RUNNING build (pre-01.2 dispatch): adopt.
        job.started_at = _dt_from_epoch(now)
        session.commit()
        return "EXECUTE"
    if (now - job.started_at.timestamp()) > _EXECUTION_LEASE_TTL_S:
        # The claiming worker crashed; recovery re-claims (bounded).
        job.started_at = _dt_from_epoch(now)
        session.commit()
        return "EXECUTE"
    session.rollback()
    return job.status


def _dt_from_epoch(epoch: float):
    from datetime import UTC, datetime

    return datetime.fromtimestamp(epoch, tz=UTC)


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

    try:
        job = _load_job(session, job_id)
        collision = _load_collision(session, collision_id)
        if job is None or collision is None:
            logger.error("build_collision: job=%s collision=%s missing in DB", job_id, collision_id)
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

        # ── PART B: atomic execution-rights claim (short, locked) ──────────
        claim = _claim_execution_rights(session, job_id)
        if claim != "EXECUTE":
            # Another worker owns execution rights (or the job became terminal
            # between our read and our lock).  Duplicate no-op.
            logger.info("build_collision: job %s claim=%s; duplicate delivery", job_id, claim)
            session.close()
            return {"ok": True, "duplicate": True, "job_status": claim}
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

        # ── Cheap pre-build ownership gate (§C) ─────────────────────────────
        # Fast-fail before burning GPU/CPU; the AUTHORITATIVE check happens
        # inside the locked finalization transaction.
        if not _still_owned(session, sid, uuid.UUID(job_id), src_version_id):
            return _mark_superseded(session, uuid.UUID(job_id), collision_id, sid)
        session.rollback()  # release the gate's read transaction

        # ── Per-job output isolation (§C) ────────────────────────────────────
        # collision/{sceneId}/versions/<assetVersion>/jobs/<collisionJobId>/
        rel_dir = f"collision/{sid}/versions/{asset_version}/jobs/{job_id}"
        out_dir = storage._path(rel_dir)
        out_dir.mkdir(parents=True, exist_ok=True)

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

        # ── PART B: locked finalization (single transaction) ────────────────
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
        )

    except Exception as exc:
        session.rollback()
        logger.exception("Collision build FAILED for scene %s", scene_id)
        # PART B: the failure path re-locks fresh state in the unified lock
        # order and only FAILs the collision the job still owns — never a
        # newer job's collision.
        return _fail_build(session, uuid.UUID(job_id), uuid.UUID(collision_id), sid, exc)

    finally:
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
) -> dict:
    """PART B — finalize in ONE locked transaction.

    Lock order **Scene → CollisionAsset → Job** (matching the API takeover),
    fresh reads only (``populate_existing`` defeats the ORM identity map).
    Validation before any write:

    * the scene still points at the pinned SceneVersion;
    * the collision row still points at THIS job;
    * the collision's recorded ``build_params.sourceVersionId`` (if any)
      still matches the pinned version;
    * the job is not terminal and belongs to this scene.

    Any failure ⇒ ``COLLISION_SUPERSEDED`` — the OLD job is FAILed, the newer
    collision/job are never touched, and nothing else is written.  On success
    the Asset rows + collision row + job row are committed TOGETHER.
    """
    from sqlalchemy import select

    from app.db.models.collision_asset import CollisionAsset
    from app.db.models.scene import Scene

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
    if job is None or job.status in _TERMINAL:
        raise FileNotFoundError(f"任务不存在或已终态: {job_id}")

    # ── Final ownership + version validation (fresh, under locks) ───────────
    bp_source = (coll.build_params or {}).get("sourceVersionId")
    if (
        scene.current_version_id != src_version_id
        or coll.job_id is None
        or coll.job_id != job_id
        or job.scene_id != scene_id
        or (bp_source is not None and str(bp_source) != str(src_version_id))
    ):
        return _mark_superseded(session, job_id, collision_id, scene_id)

    # ── Persist per-job asset rows (pinned to the source version) ───────────
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
        "Collision build SUCCEEDED for scene %s (%s) format=%s",
        scene_id, mode, preferred_asset.kind,
    )
    return {
        "ok": True,
        "mode": mode,
        "asset_id": str(collision_asset_id),
        "format": preferred_asset.kind,
        **result.to_params(),
    }


def _mark_superseded(
    session, job_id: uuid.UUID, collision_id: uuid.UUID, scene_id: uuid.UUID
) -> dict:
    """Terminalize THIS job as superseded — a legal state with the stable
    ``COLLISION_SUPERSEDED`` code — and never touch a newer collision.

    Runs in its own transaction under the unified lock order
    (Scene → CollisionAsset → Job) with fresh reads: whatever the lock sees is
    what is written.  If the collision row still belongs to THIS job it is
    marked FAILED too (rebuildable); otherwise only the job is failed.
    """
    from sqlalchemy import select

    from app.db.models.collision_asset import CollisionAsset
    from app.db.models.scene import Scene

    session.rollback()  # clean boundary
    scene = session.scalars(
        select(Scene)
        .where(Scene.id == scene_id)
        .with_for_update(of=Scene)
        .execution_options(populate_existing=True)
    ).first()
    if scene is None:  # pragma: no cover - scene vanished; still fail the job
        session.rollback()
        return {"ok": False, "error": "COLLISION_SUPERSEDED", "superseded": True}
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
    if job is not None and job.status not in _TERMINAL:
        job.status = "FAILED"
        job.error_code = "COLLISION_SUPERSEDED"
        job.error_message_safe = "被更新的碰撞构建任务取代"
    # Only fail the collision if it STILL belongs to this (superseded) job.
    if (
        coll is not None
        and coll.job_id is not None
        and str(coll.job_id) == str(job_id)
    ):
        coll.status = "FAILED"
        coll.error_message = "碰撞构建被更新的版本取代"
    session.commit()
    return {"ok": False, "error": "COLLISION_SUPERSEDED", "superseded": True}


def _fail_build(
    session, job_id: uuid.UUID, collision_id: uuid.UUID, scene_id: uuid.UUID, exc: Exception
) -> dict:
    """PART B — failure journaling in a fresh LOCKED transaction.

    Re-locks Scene → CollisionAsset → Job, re-reads fresh, and FAILs the
    collision ONLY while the job still owns it — a stale worker whose row was
    taken over must never mark the newer collision FAILED (B-04).
    """
    from sqlalchemy import select

    from app.db.models.collision_asset import CollisionAsset
    from app.db.models.scene import Scene

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
        if job is not None and job.status not in _TERMINAL:
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
    session, scene_id: uuid.UUID, job_id, src_version_id: uuid.UUID
) -> bool:
    """Ownership re-check before a worker finalizes (§C).

    - the scene still points at the pinned SceneVersion (version did not move);
    - the collision row still points at THIS job (a newer build did not take over);
    - this job is not terminalized by anyone else.
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
    return True
