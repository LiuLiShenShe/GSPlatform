"""Celery task — collision mesh build (Phase 12).

Dispatched by the API producer (``tasks.build_collision``). Executes:

1. Loads the scene's SOG asset from storage.
2. Runs the mode-specific builder (outdoor: Gaussian means → terrain;
   indoor: camera+depth fusion or upload-required fallback).
3. Writes the resulting GLB to storage.
4. Updates the CollisionAsset row (status, asset ref, error) + Job status.

Failure is journaled into the DB so the API can expose it and the user can
rebuild (``build failure 可恢复`` / ``collision 可重建``).
"""

from __future__ import annotations

import logging
import uuid
from pathlib import Path

from workers.celery_app import celery_app

from app.core.config import settings
from app.db.models.asset import Asset
from app.db.models.enums import AssetKind
from app.db.models.job import Job
from app.db.session import SessionLocal
from app.storage.local_disk import LocalDiskStorage

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

    def mark_status(status: str, progress: int, error: str | None = None, stage: str | None = None) -> None:
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

        # Output path under storage: collision/{scene_id}/collision.glb
        rel_out = f"collision/{sid}/collision.glb"
        out_path = storage._path(rel_out)
        out_path.parent.mkdir(parents=True, exist_ok=True)

        # Run builder
        if mode == "OUTDOOR":
            from workers.collision.outdoor import build_outdoor_collision

            job.stage = "BUILDING"
            session.flush()
            result = build_outdoor_collision(sog_path, out_path)
        elif mode == "INDOOR":
            from workers.collision.indoor import build_indoor_collision

            job.stage = "BUILDING"
            session.flush()
            # camera/depth paths are best-effort; the indoor builder handles None
            result = build_indoor_collision(
                sog_path,
                out_path,
                camera_json=None,
                depth_dir=None,
            )
        else:
            raise ValueError(f"未知碰撞模式: {mode}")

        # Persist asset row
        data = out_path.read_bytes()
        sha = storage.sha256(rel_out)

        existing_asset = (
            session.query(Asset)
            .filter(Asset.scene_id == sid, Asset.kind == AssetKind.COLLISION_GLB.value)
            .first()
        )
        if existing_asset is not None:
            existing_asset.byte_size = len(data)
            existing_asset.sha256 = sha
            existing_asset.storage_key = rel_out
            existing_asset.mime_type = "model/gltf-binary"
            asset = existing_asset
        else:
            asset = Asset(
                scene_id=sid,
                version_id=None,
                kind=AssetKind.COLLISION_GLB.value,
                storage_key=rel_out,
                mime_type="model/gltf-binary",
                byte_size=len(data),
                sha256=sha,
                metadata_={"mode": mode, "build": result},
            )
            session.add(asset)
        session.flush()

        collision.asset_id = asset.id
        collision.job_id = uuid.UUID(job_id)
        collision.build_params = result
        mark_status("SUCCEEDED", 100)

        session.commit()
        logger.info("Collision build SUCCEEDED for scene %s (%s)", scene_id, mode)
        return {"ok": True, "mode": mode, "asset_id": str(asset.id), **result}

    except Exception as exc:  # noqa: BLE001
        session.rollback()
        logger.exception("Collision build FAILED for scene %s", scene_id)
        mark_status("FAILED", job.progress if job.progress else 0, error=str(exc))
        session.commit()
        return {"ok": False, "error": str(exc)}

    finally:
        session.close()