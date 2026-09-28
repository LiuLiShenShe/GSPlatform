"""Celery task — collision build (Phase 12; SSV-07 real generator).

Dispatched by the API producer (``tasks.build_collision``). Executes:

1. Loads the scene's SOG / streamed-SOG source from storage.
2. Runs the official ``splat-transform`` generator, which voxelizes the scene
   and writes BOTH formats the official SuperSplat viewer consumes:
   ``collision.voxel.json`` + ``collision.voxel.bin`` (native ``VoxelCollision``)
   and ``collision.glb`` (``MeshCollision`` fallback). INDOOR / OUTDOOR is the
   voxel **generation policy** (carve vs floor-fill), never a runtime mode.
3. Persists the artifact Asset rows (voxel preferred) + CollisionAsset status.

Failure is journaled into the DB so the API can expose it and the user can
rebuild (``build failure 可恢复`` / ``collision 可重建``).
"""

from __future__ import annotations

import logging
import uuid
from pathlib import Path

from app.core.config import settings
from app.db.models.asset import Asset
from app.db.models.enums import AssetKind
from app.db.models.job import Job
from app.db.session import SessionLocal
from app.storage.local_disk import LocalDiskStorage

from workers.celery_app import celery_app

logger = logging.getLogger("gsplatform.workers.build_collision")

_STORAGE_ROOT = Path(settings.storage_root)


def _load_job(session, job_id: str) -> Job | None:
    return session.query(Job).filter(Job.id == uuid.UUID(job_id)).first()


def _load_collision(session, collision_id: str):
    from app.db.models.collision_asset import CollisionAsset

    return (
        session.query(CollisionAsset)
        .filter(CollisionAsset.id == uuid.UUID(collision_id))
        .first()
    )


def _find_sog_asset(session, scene_id: uuid.UUID) -> Asset | None:
    """Find the primary SOG asset for a scene (highest priority kind)."""
    from sqlalchemy import or_

    kinds = (AssetKind.SOG.value, AssetKind.STREAM_INDEX.value)
    asset = (
        session.query(Asset)
        .filter(Asset.scene_id == scene_id, or_(*[Asset.kind == k for k in kinds]))
        .order_by(Asset.created_at.desc())
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
) -> dict:
    """Build collision mesh for a scene."""
    session = SessionLocal()

    job = _load_job(session, job_id)
    collision = _load_collision(session, collision_id)
    if job is None or collision is None:
        logger.error("build_collision: job=%s collision=%s missing in DB", job_id, collision_id)
        session.close()
        return {"ok": False, "error": "DB_ROW_MISSING"}

    storage = LocalDiskStorage(_STORAGE_ROOT)
    sid = uuid.UUID(scene_id)

    def mark_status(
        status: str, progress: int, error: str | None = None, stage: str | None = None
    ) -> None:
        job.status = status
        job.progress = progress
        if stage is not None:
            job.stage = stage
        if error is not None:
            job.error_code = "COLLISION_BUILD_FAILED"
            job.error_message_safe = error[:1000]
            collision.status = "FAILED"
            collision.error_message = error[:1000]
        else:
            collision.status = "SUCCEEDED"
            collision.error_message = None
        session.flush()

    try:
        # Locate source SOG
        sog = _find_sog_asset(session, sid)
        if sog is None:
            raise FileNotFoundError("找不到场景的 SOG 源文件；请先发布场景资产")

        sog_path = storage._path(sog.storage_key)
        if not sog_path.exists():
            raise FileNotFoundError(f"SOG 文件不存在: {sog.storage_key}")

        job.status = "RUNNING"
        job.stage = "LOADING"
        session.flush()

        # Output dir under storage: collision/{scene_id}/
        rel_dir = f"collision/{sid}"
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

        # ── Persist asset rows ───────────────────────────────────────────────
        def _upsert_collision_asset(kind: str, rel_key: str, mime: str, meta: dict) -> Asset:
            existing = (
                session.query(Asset)
                .filter(Asset.scene_id == sid, Asset.kind == kind)
                .first()
            )
            size = storage._path(rel_key).stat().st_size
            sha = storage.sha256(rel_key)
            if existing is not None:
                existing.storage_key = rel_key
                existing.mime_type = mime
                existing.byte_size = size
                existing.sha256 = sha
                existing.metadata_ = meta
                return existing
            row = Asset(
                scene_id=sid,
                version_id=None,
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
            voxel_asset = _upsert_collision_asset(
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
                },
            )
            session.flush()
            preferred_asset = voxel_asset

        # 2) collision mesh GLB (fallback) — produced whenever available.
        if result.collision_glb is not None:
            glb_asset = _upsert_collision_asset(
                AssetKind.COLLISION_GLB.value,
                f"{rel_dir}/{result.collision_glb.name}",
                "model/gltf-binary",
                {"mode": mode, "build": result.to_params()},
            )
            session.flush()
            if preferred_asset is None:
                preferred_asset = glb_asset

        if preferred_asset is None:  # pragma: no cover - guarded by result.ok
            raise SplatCollisionError("碰撞构建未产出可用资产")

        collision.asset_id = preferred_asset.id
        collision.job_id = uuid.UUID(job_id)
        collision.build_params = result.to_params()
        mark_status("SUCCEEDED", 100)

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
        mark_status("FAILED", job.progress if job.progress else 0, error=str(exc))
        session.commit()
        return {"ok": False, "error": str(exc)}

    finally:
        session.close()
