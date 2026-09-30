"""Collision service — collision asset management (Phase 12).

Provides use-cases for building, reading, updating, and rebuilding collision
meshes. The actual Celery build is dispatched through the shared producer.

FIX-05 §22-§25: the official viewer cannot reliably re-transform a built
collision mesh, so each build records the world transform it was performed
under (``build_params.worldTransformHash``). The runtime descriptor compares
that hash with the scene's current transform and reports ``stale`` when the
transform changed after the build — the walk entry must then be disabled.
"""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from typing import Any

from sqlalchemy.orm import Session

from app.core.errors import ConflictError, ForbiddenError, NotFoundError
from app.db.models.asset import Asset
from app.db.models.enums import JobKind, JobStatus
from app.db.models.job import Job
from app.db.models.scene import Scene
from app.db.models.scene_presentation import ScenePresentation
from app.repositories.collision import CollisionAssetRepository
from app.schemas.collision import (
    CollisionAssetCreateRequest,
    CollisionAssetOut,
    CollisionAssetUpdateRequest,
    CollisionBuildResponse,
)
from app.storage import LocalDiskStorage

logger = logging.getLogger("gsplatform.collision")


def _validate_owner(scene: Scene, owner_id: uuid.UUID) -> None:
    if scene.owner_id != owner_id:
        raise ForbiddenError("只有场景所有者可以编辑")


def world_transform_hash(
    position: dict[str, float] | None,
    rotation: dict[str, float] | None,
    scale: dict[str, float] | None,
) -> str | None:
    """Content hash of a scene world transform (FIX-05 §23).

    ``None`` when no transform component is set — the identity/absent case,
    which always aligns with a locally-built collision.  Any non-empty
    component produces a stable short hash used to detect a *change* of the
    transform after the collision was built (mismatch → STALE).
    """
    if not position and not rotation and not scale:
        return None
    payload = json.dumps(
        {"position": position, "rotation": rotation, "scale": scale},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


class CollisionService:
    """Collision asset use cases."""

    def __init__(
        self,
        session: Session,
        storage: LocalDiskStorage,
        send_task: Any | None = None,
    ) -> None:
        self._session = session
        self._storage = storage
        self._send_task = send_task
        self._repo = CollisionAssetRepository(session)

    def _get_scene(self, slug: str) -> Scene:
        scene = (
            self._session.query(Scene)
            .filter(Scene.slug == slug, Scene.deleted_at.is_(None))
            .first()
        )
        if scene is None:
            raise NotFoundError(f"场景不存在: {slug}")
        return scene

    def _get_presentation(self, scene_id: uuid.UUID) -> ScenePresentation | None:
        return (
            self._session.query(ScenePresentation)
            .filter(ScenePresentation.scene_id == scene_id)
            .first()
        )

    def _current_world_hash(self, scene_id: uuid.UUID) -> str | None:
        """World-transform content hash in effect right now (FIX-05 §23).

        Recorded on the collision at build/rebuild dispatch; the runtime
        descriptor compares it with the freshest value to flag STALE.
        """
        pres = self._get_presentation(scene_id)
        if pres is None:
            return None
        return world_transform_hash(
            pres.world_position, pres.world_rotation, pres.world_scale
        )

    def _record_build_transform(
        self, collision: Any, world_hash: str | None
    ) -> None:
        """Persist the build-time world transform on the collision's build_params.

        Merges so the worker's own artifact metadata (``to_params()``) is not
        overwritten at dispatch; the worker re-records the same key on
        SUCCEEDED (threaded through the task args).
        """
        params = dict(collision.build_params or {})
        params["worldTransformHash"] = world_hash
        collision.build_params = params
        self._session.flush()

    def get_collision(self, slug: str, user_id: uuid.UUID | None) -> CollisionAssetOut:
        """Get collision asset status for a scene."""
        scene = self._get_scene(slug)
        collision = self._repo.get_by_scene_id(scene.id)
        if collision is None:
            raise NotFoundError(f"场景 {slug} 没有碰撞资产")
        presentation = self._get_presentation(scene.id)
        enabled = presentation.collision_enabled if presentation else False
        # FIX-05 §23/§25：STALE = 构建时世界变换 hash 与当前不一致。
        build_params = collision.build_params or {}
        current_hash = self._current_world_hash(scene.id)
        stale = build_params.get("worldTransformHash") != current_hash
        return CollisionAssetOut(
            id=str(collision.id),
            scene_id=str(collision.scene_id),
            mode=collision.mode,
            status=collision.status,
            asset_id=str(collision.asset_id) if collision.asset_id else None,
            job_id=str(collision.job_id) if collision.job_id else None,
            gravity=collision.gravity,
            slope_limit_degrees=collision.slope_limit_degrees,
            step_offset=collision.step_offset,
            player_height=collision.player_height,
            collision_enabled=enabled,
            error_message=collision.error_message,
            attempt=collision.attempt,
            created_at=collision.created_at,
            updated_at=collision.updated_at,
            stale=stale,
            world_transform_hash=current_hash,
        )

    def serve_collision_mesh(self, slug: str) -> tuple[bytes, str]:
        """Return collision mesh bytes + mime (or raise NotFound).

        Serves the built GLB (``AssetKind.COLLISION_GLB``) so the runtime
        contract's ``collision.url`` is a real viewer-accessible URL. The
        official viewer routes a url ending in ``.glb`` to its mesh loader.
        Public like the presentation serve routes.
        """
        scene = self._get_scene(slug)
        asset = self._latest_collision_asset(scene.id, "COLLISION_GLB")
        if asset is None:
            # Legacy single-asset layout: the collision row's asset_id itself.
            collision = self._repo.get_by_scene_id(scene.id)
            if collision is not None and collision.asset_id is not None:
                asset = self._session.get(Asset, collision.asset_id)
                if asset is not None and asset.kind != "COLLISION_GLB":
                    asset = None
        if asset is None:
            raise NotFoundError(f"场景 {slug} 没有碰撞网格")
        data = self._storage.read(asset.storage_key)
        return data, asset.mime_type

    def serve_collision_voxel(
        self, slug: str, *, binary: bool
    ) -> tuple[bytes, str]:
        """Return the voxel collision pair byte stream.

        ``binary=False`` → the ``.voxel.json`` metadata; ``binary=True`` → the
        ``.voxel.bin`` leaf octree data. The official viewer fetches the json
        first, then derives the bin url by replacing ``.voxel.json`` with
        ``.voxel.bin``, so both must be served from the same scene directory.
        """
        scene = self._get_scene(slug)
        asset = self._latest_collision_asset(scene.id, "COLLISION_VOXEL")
        if asset is None:
            raise NotFoundError(f"场景 {slug} 没有碰撞体素数据")
        if binary:
            bin_key = (asset.metadata_ or {}).get("binStorageKey")
            if not bin_key:
                raise NotFoundError(f"场景 {slug} 缺少 voxel.bin 资源")
            return self._storage.read(bin_key), "application/octet-stream"
        return self._storage.read(asset.storage_key), "application/json"

    def _latest_collision_asset(
        self, scene_id: uuid.UUID, kind: str
    ) -> Asset | None:
        return (
            self._session.query(Asset)
            .filter(Asset.scene_id == scene_id, Asset.kind == kind)
            .order_by(Asset.created_at.desc())
            .first()
        )

    def create_and_build(
        self,
        slug: str,
        req: CollisionAssetCreateRequest,
        owner_id: uuid.UUID,
    ) -> CollisionBuildResponse:
        """Create collision asset record and dispatch build job."""
        scene = self._get_scene(slug)
        _validate_owner(scene, owner_id)

        if req.mode not in ("INDOOR", "OUTDOOR"):
            raise ConflictError("mode 必须是 INDOOR 或 OUTDOOR")

        existing = self._repo.get_by_scene_id(scene.id)
        if existing is not None and existing.status in ("QUEUED", "RUNNING"):
            raise ConflictError("碰撞构建任务正在进行中")

        if existing is None:
            collision = self._repo.create(
                scene_id=scene.id,
                mode=req.mode,
                gravity=req.gravity,
                slope_limit_degrees=req.slope_limit_degrees,
                step_offset=req.step_offset,
                player_height=req.player_height,
            )
        else:
            collision = existing
            collision.mode = req.mode
            collision.gravity = req.gravity
            collision.slope_limit_degrees = req.slope_limit_degrees
            collision.step_offset = req.step_offset
            collision.player_height = req.player_height
            collision.status = "QUEUED"
            collision.error_message = None
            collision.attempt += 1
            self._session.flush()

        # Create job
        job = Job(
            scene_id=scene.id,
            owner_id=owner_id,
            kind=JobKind.BUILD_COLLISION.value,
            status=JobStatus.QUEUED.value,
            progress=0,
        )
        self._session.add(job)
        self._session.flush()

        collision.job_id = job.id
        # FIX-05 §23：记录构建时的世界变换（STALE 判定的基准）。
        world_hash = self._current_world_hash(scene.id)
        self._record_build_transform(collision, world_hash)
        self._session.flush()

        # Dispatch task
        task_name = "tasks.build_collision"
        args = [str(job.id), str(scene.id), str(collision.id), req.mode, world_hash]
        if self._send_task is not None:
            result = self._send_task(task_name, args=args)
            job.celery_task_id = str(result.id)
            self._session.flush()
            logger.info("Dispatched %s for scene %s", task_name, slug)
        else:
            logger.warning("send_task not available; job %s created but not dispatched", job.id)

        return CollisionBuildResponse(
            job_id=str(job.id),
            status="QUEUED",
            message=f"碰撞构建任务已创建 (模式: {req.mode})",
        )

    def update_params(
        self,
        slug: str,
        req: CollisionAssetUpdateRequest,
        owner_id: uuid.UUID,
    ) -> CollisionAssetOut:
        """Update collision physics parameters."""
        scene = self._get_scene(slug)
        _validate_owner(scene, owner_id)

        collision = self._repo.get_by_scene_id(scene.id)
        if collision is None:
            raise NotFoundError(f"场景 {slug} 没有碰撞资产")

        self._repo.update_params(
            collision.id,
            gravity=req.gravity,
            slope_limit_degrees=req.slope_limit_degrees,
            step_offset=req.step_offset,
            player_height=req.player_height,
        )

        if req.collision_enabled is not None:
            presentation = self._get_presentation(scene.id)
            if presentation is not None:
                presentation.collision_enabled = req.collision_enabled
                self._session.flush()

        return self.get_collision(slug, owner_id)

    def rebuild(
        self,
        slug: str,
        owner_id: uuid.UUID,
    ) -> CollisionBuildResponse:
        """Rebuild collision asset."""
        scene = self._get_scene(slug)
        _validate_owner(scene, owner_id)

        collision = self._repo.get_by_scene_id(scene.id)
        if collision is None:
            raise NotFoundError(f"场景 {slug} 没有碰撞资产")

        if collision.status in ("QUEUED", "RUNNING"):
            raise ConflictError("碰撞构建任务正在进行中")

        self._repo.increment_attempt(collision.id)

        job = Job(
            scene_id=scene.id,
            owner_id=owner_id,
            kind=JobKind.BUILD_COLLISION.value,
            status=JobStatus.QUEUED.value,
            progress=0,
        )
        self._session.add(job)
        self._session.flush()

        collision.job_id = job.id
        # FIX-05 §23：重建同样记录当前世界变换 —— 重建后 hash 与场景一致 → 不 STALE。
        world_hash = self._current_world_hash(scene.id)
        self._record_build_transform(collision, world_hash)
        self._session.flush()

        task_name = "tasks.build_collision"
        args = [str(job.id), str(scene.id), str(collision.id), collision.mode, world_hash]
        if self._send_task is not None:
            result = self._send_task(task_name, args=args)
            job.celery_task_id = str(result.id)
            self._session.flush()
            logger.info("Rebuilt collision for scene %s (attempt %d)", slug, collision.attempt)

        return CollisionBuildResponse(
            job_id=str(job.id),
            status="QUEUED",
            message=f"碰撞重建任务已创建 (尝试 #{collision.attempt})",
        )
