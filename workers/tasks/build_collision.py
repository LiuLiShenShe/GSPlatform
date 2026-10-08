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

    job = _load_job(session, job_id)
    collision = _load_collision(session, collision_id)
    if job is None or collision is None:
        logger.error("build_collision: job=%s collision=%s missing in DB", job_id, collision_id)
        session.close()
        return {"ok": False, "error": "DB_ROW_MISSING"}

    # §D duplicate-delivery guard: a terminal job must never be mutated again
    # (no regeneration, no status flip) — redelivery after acks_late/crash is
    # absorbed here.
    if job.status in _TERMINAL:
        logger.info("build_collision: job %s already %s; duplicate delivery", job_id, job.status)
        session.close()
        return {"ok": True, "duplicate": True, "job_status": job.status}

    storage = LocalDiskStorage(_STORAGE_ROOT)
    sid = uuid.UUID(scene_id)

    try:
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

        # ── First ownership gate (§C) ────────────────────────────────────────
        # Cheap pre-build check: the scene still points at our pinned version
        # and the collision row is still ours.  Catches the common stale-worker
        # case before burning GPU/CPU time.
        if not _still_owned(session, sid, job.id, src_version_id):
            _mark_superseded(session, job, collision)
            return {"ok": False, "error": "COLLISION_SUPERSEDED", "superseded": True}

        job.status = "RUNNING"
        job.stage = "LOADING"
        session.flush()

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
        job.stage = "BUILDING"
        session.flush()
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

        # ── Persist per-job asset rows (pinned to the source version) ───────
        def _make_collision_asset(kind: str, rel_key: str, mime: str, meta: dict) -> Asset:
            size = storage._path(rel_key).stat().st_size
            sha = storage.sha256(rel_key)
            row = Asset(
                scene_id=sid,
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
                    "collisionJobId": job_id,
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
                    "collisionJobId": job_id,
                    "sourceVersion": asset_version,
                    "sourceVersionId": str(src_version_id),
                },
            )
            session.flush()
            if preferred_asset is None:
                preferred_asset = glb_asset

        if preferred_asset is None:  # pragma: no cover - guarded by result.ok
            raise SplatCollisionError("碰撞构建未产出可用资产")

        # ── Pre-finalize ownership re-check (§C) ─────────────────────────────
        # A stale worker (version moved on, or the collision row taken over by
        # a newer job) must NOT bind this build to the collision: mark the job
        # FAILED with the stable code COLLISION_SUPERSEDED and leave the newer
        # collision row untouched.
        if not _still_owned(session, sid, job.id, src_version_id):
            _mark_superseded(session, job, collision)
            return {"ok": False, "error": "COLLISION_SUPERSEDED", "superseded": True}

        collision.asset_id = preferred_asset.id
        collision.job_id = uuid.UUID(job_id)
        build_params = result.to_params()
        # FIX-05 §23：保留 API 在派发时记录的世界变换哈希（STALE 判定基准）。
        build_params["worldTransformHash"] = world_transform_hash
        # FIX-UPLOAD-01.1 §D：持久化版本关联 —— 本碰撞由哪个发布版本构建而来。
        build_params["sourceVersion"] = asset_version
        build_params["sourceVersionId"] = str(src_version_id)
        collision.build_params = build_params
        collision.status = "SUCCEEDED"
        collision.error_message = None
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
            "asset_id": str(preferred_asset.id),
            "format": preferred_asset.kind,
            **result.to_params(),
        }

    except Exception as exc:
        session.rollback()
        logger.exception("Collision build FAILED for scene %s", scene_id)
        # §C stale-worker protection on the failure path too: only the job that
        # still OWNS the collision row may FAIL the collision; a superseded
        # worker fails only itself.  Re-read the row fresh — the object loaded
        # before the build is stale after rollback/takeover.
        from app.db.models.collision_asset import CollisionAsset as _CA

        fresh_coll = session.get(_CA, collision.id)
        owns_row = (
            fresh_coll is not None
            and fresh_coll.job_id is not None
            and str(fresh_coll.job_id) == job_id
        )
        job.status = "FAILED"
        job.error_code = "COLLISION_BUILD_FAILED"
        job.error_message_safe = str(exc)[:1000]
        if owns_row:
            fresh_coll.status = "FAILED"
            fresh_coll.error_message = str(exc)[:1000]
        session.commit()
        return {"ok": False, "error": str(exc)}

    finally:
        session.close()


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


def _mark_superseded(session, job: Job, collision) -> None:
    """Terminalize THIS job as superseded — a legal state with the stable
    ``COLLISION_SUPERSEDED`` code — and never touch a newer collision.

    If the collision row is still owned by this job (nobody took over yet), it
    is marked FAILED too so the scheduled reconcile rebuilds it for the current
    version; otherwise only the job is failed.  The row is re-read fresh — the
    object handed in was loaded before the build and is stale.
    """
    from app.db.models.collision_asset import CollisionAsset

    fresh = session.get(CollisionAsset, collision.id)
    job.status = "FAILED"
    job.error_code = "COLLISION_SUPERSEDED"
    job.error_message_safe = "被更新的碰撞构建任务取代"
    if fresh is not None and fresh.job_id is not None and str(fresh.job_id) == str(job.id):
        fresh.status = "FAILED"
        fresh.error_message = "碰撞构建被更新的版本取代"
    session.commit()