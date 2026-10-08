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
import time
import uuid
from typing import Any

from sqlalchemy.orm import Session

from app.core.errors import ConflictError, ForbiddenError, NotFoundError
from app.db.models.asset import Asset
from app.db.models.collision_asset import CollisionAsset
from app.db.models.enums import JobKind, JobStatus
from app.db.models.job import Job
from app.db.models.scene import Scene, SceneVersion
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

# FIX-UPLOAD-01.1 §C dispatch-claim protocol.
# ``Job.celery_task_id`` encodes dispatch state:
#   - None             → dispatch never confirmed; may be sent (re-sent);
#   - "sending:<uuid>:<ts>" → a sender has claimed the send but the broker has
#     not confirmed yet (crash window between commit and send);
#   - any other value → the real broker task id (confirmed delivery).
# A concurrent ensure/reconcile never re-sends a FRESH claim (the sender is
# mid-flight); it waits briefly for confirmation.  A STALE claim (>TTL) means
# the sender crashed between commit and send — a new sender takes it over by
# FOR UPDATE compare-and-set on the Job row, re-sending the SAME job id.
_CLAIM_PREFIX = "sending:"
_DISPATCH_CLAIM_TTL_S = 60.0
_DISPATCH_WAIT_CONFIRM_S = 5.0

_JOB_TERMINAL_STATUSES = {
    JobStatus.SUCCEEDED.value,
    JobStatus.FAILED.value,
    JobStatus.CANCELLED.value,
    JobStatus.CANCEL_REQUESTED.value,
}


def _new_claim() -> str:
    return f"{_CLAIM_PREFIX}{uuid.uuid4().hex}:{time.monotonic():.3f}"


def _claim_stale(claim: str, ttl_s: float = _DISPATCH_CLAIM_TTL_S) -> bool:
    try:
        ts = float(claim.rsplit(":", 1)[1])
    except ValueError:
        return True
    return time.monotonic() - ts > ttl_s


def _validate_owner(scene: Scene, owner_id: uuid.UUID) -> None:
    if scene.owner_id != owner_id:
        raise ForbiddenError("只有场景所有者可以编辑")


# FIX-UPLOAD-01 §11 — 自动碰撞只为每个 scene 的 *当前版本* 构建一次：
#   - CollisionAsset 不存在 → 新建；
#   - 存在但绑定了当前版本且状态为 QUEUED/RUNNING/SUCCEEDED（资产有效）→ 复用，无重复任务；
#   - 状态 FAILED → 转 QUEUED 并派发新 Job（可重试）；
#   - 绑定到旧版本（assetVersion 不同）→ 认为旧碰撞失效，新版本需要重建。
def _version_binding_satisfied(build_params: dict[str, Any] | None, asset_version: str) -> bool:
    """True when a SUCCEEDED collision belongs to *this* published version."""
    return build_params is not None and build_params.get("sourceVersion") == asset_version

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
        # FIX-UPLOAD-01 §C：构建绑定到旧版本（sourceVersion ≠ 当前发布版本）时
        # 同样视为 STALE —— 旧版本碰撞绝不冒充当前碰撞。
        build_params = collision.build_params or {}
        current_hash = self._current_world_hash(scene.id)
        stale = build_params.get("worldTransformHash") != current_hash
        # FIX-UPLOAD-01 §C：构建记录过 sourceVersion 且与当前发布版本不一致 →
        # 旧版本碰撞绝不冒充当前碰撞。未记录 sourceVersion 的存量碰撞（FIX-05
        # 时代构建）保持原有 STALE 语义（不因版本判断而 STALE）——零回归。
        if collision.status == "SUCCEEDED" and build_params.get("sourceVersion"):
            current_version = self._session.get(SceneVersion, scene.current_version_id)
            if current_version is not None and not _version_binding_satisfied(
                build_params, current_version.asset_version
            ):
                stale = True
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

        Serves the built GLB so the runtime contract's ``collision.url`` is a
        real viewer-accessible URL.  FIX-UPLOAD-01.1 §C: resolution is
        **job-scoped** — the artifacts belong to *the collision row's own
        build* (``metadata_["collisionJobId"]``), never a ``created_at DESC``
        guess that could pick a different build's files.
        """
        scene = self._get_scene(slug)
        collision = self._repo.get_by_scene_id(scene.id)
        asset = None
        if collision is not None:
            # Primary: the collision's own build.
            job_assets = self._assets_of_job(scene.id, collision.job_id, "COLLISION_GLB")
            if job_assets:
                asset = job_assets[0]
        if asset is None and collision is not None and collision.asset_id is not None:
            # Legacy single-asset layout: the collision row's own asset_id.
            candidate = self._session.get(Asset, collision.asset_id)
            if candidate is not None and candidate.kind == "COLLISION_GLB":
                asset = candidate
        if asset is None:
            # Legacy single-build layouts (pre job isolation) — last resort.
            asset = self._latest_collision_asset(scene.id, "COLLISION_GLB")
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
        ``.voxel.bin``, so both must be served from the *same build's*
        directory.  FIX-UPLOAD-01.1 §C: job-scoped resolution — the json and
        its bin necessarily come from the same Asset row.
        """
        scene = self._get_scene(slug)
        collision = self._repo.get_by_scene_id(scene.id)
        asset = None
        if collision is not None:
            job_assets = self._assets_of_job(scene.id, collision.job_id, "COLLISION_VOXEL")
            if job_assets:
                asset = job_assets[0]
        if asset is None and collision is not None and collision.asset_id is not None:
            candidate = self._session.get(Asset, collision.asset_id)
            if candidate is not None and candidate.kind == "COLLISION_VOXEL":
                asset = candidate
        if asset is None:
            asset = self._latest_collision_asset(scene.id, "COLLISION_VOXEL")
        if asset is None:
            raise NotFoundError(f"场景 {slug} 没有碰撞体素数据")
        if binary:
            bin_key = (asset.metadata_ or {}).get("binStorageKey")
            if not bin_key:
                raise NotFoundError(f"场景 {slug} 缺少 voxel.bin 资源")
            return self._storage.read(bin_key), "application/octet-stream"
        return self._storage.read(asset.storage_key), "application/json"

    def _assets_of_job(
        self, scene_id: uuid.UUID, job_id: uuid.UUID | None, kind: str
    ) -> list[Asset]:
        """Asset rows belonging to ONE collision build (job-scoped, §C/D).

        Serving resolves the collision's own build by the persisted
        ``job_id`` — never ``ORDER BY created_at DESC``, which could pick a
        different (stale) build's files.
        """
        if job_id is None:
            return []
        return (
            self._session.query(Asset)
            .filter(
                Asset.scene_id == scene_id,
                Asset.kind == kind,
                Asset.metadata_["collisionJobId"].astext == str(job_id),
            )
            .order_by(Asset.created_at.asc())
            .all()
        )

    def _latest_collision_asset(
        self, scene_id: uuid.UUID, kind: str
    ) -> Asset | None:
        """Legacy fallback for pre-§C single-build layouts (no job scoping)."""
        return (
            self._session.query(Asset)
            .filter(Asset.scene_id == scene_id, Asset.kind == kind)
            .order_by(Asset.created_at.desc())
            .first()
        )

    def dispatch_auto_collision(
        self,
        scene_id: uuid.UUID,
        owner_id: uuid.UUID,
        *,
        mode: str = "OUTDOOR",
    ) -> CollisionBuildResponse | None:
        """FIX-UPLOAD-01 §7-§9 — auto-build collision after a publish commits.

        Thin wrapper kept for the publish worker; FIX-UPLOAD-01.1 routes both
        the publish path and the scheduled recovery through the idempotent
        :meth:`ensure_auto_collision_for_current_version` with ``retry_failed``
        enabled (a fresh publish may retry a FAILED collision).
        """
        return self.ensure_auto_collision_for_current_version(
            scene_id, owner_id, mode=mode, retry_failed=True
        )

    def ensure_auto_collision_for_current_version(
        self,
        scene_id: uuid.UUID,
        owner_id: uuid.UUID,
        *,
        mode: str = "OUTDOOR",
        retry_failed: bool = True,
    ) -> CollisionBuildResponse | None:
        """Idempotent ensure of the collision build for the scene's *current*
        published version (§B/§C).

        - Scene row is locked FOR UPDATE — check + write + commit happen under
          the same lock so exactly one build decision is made per scene; the
          broker send happens only AFTER the commit, never inside the lock.
        - Distinguishes MISSING / DISPATCH_INCOMPLETE / QUEUED / RUNNING /
          SUCCEEDED / FAILED.  Dispatch state is the persisted
          ``Job.celery_task_id`` under the sending-claim protocol (see module
          constants): two concurrent crash-recovery threads can never both
          dispatch the same job — the commit-then-send window is closed by the
          claim, and a duplicate that still slips through is absorbed by the
          worker's idempotency guard.
        - ``retry_failed=True`` (publish path): a FAILED collision is rebuilt.
          ``retry_failed=False`` (scheduled reconcile): a FAILED collision
          whose task was *confirmed delivered* is left for manual retry —
          automatic resurrection of delivered work needs its own cap/backoff.
        """
        scene = self._lock_scene_for_update(scene_id)
        if scene is None:
            return None
        if scene.status != "PUBLISHED":
            self._session.rollback()  # release the row lock on the early return
            return None
        # §C: build collision from the scene's CURRENT version asset only.
        current_version = self._session.get(SceneVersion, scene.current_version_id)
        if current_version is None:
            self._session.rollback()
            return None

        existing = self._repo.get_by_scene_id(scene.id)
        current_asset = current_version.asset_version

        def _fresh_job() -> Job:
            job = Job(
                scene_id=scene.id,
                owner_id=owner_id,
                kind=JobKind.BUILD_COLLISION.value,
                status=JobStatus.QUEUED.value,
                progress=0,
                celery_task_id=_new_claim(),
            )
            self._session.add(job)
            self._session.flush()
            return job

        if existing is None:
            # MISSING — publish committed, but the auto-collision never ran
            # (crash between ``commit_version`` and the chaining block).
            collision = self._repo.create(scene_id=scene.id, mode=mode)
            collision.attempt += 1
            collision.status = "QUEUED"
            job = _fresh_job()
            collision.job_id = job.id
        elif existing.status in ("QUEUED", "RUNNING"):
            if existing.job_id is None:
                # DISPATCH_INCOMPLETE — collision row exists but its Job was
                # lost; re-create the job and dispatch.
                job = _fresh_job()
                existing.job_id = job.id
                collision = existing
            else:
                pending_job = self._session.get(Job, existing.job_id)
                if pending_job is None:
                    job = _fresh_job()
                    existing.job_id = job.id
                    collision = existing
                else:
                    job = pending_job
                    tid = job.celery_task_id
                    if tid is None:
                        # DISPATCH_INCOMPLETE — rows committed but the broker
                        # send was never confirmed; claim and re-send the same
                        # job (worker is duplicate-safe).  Never a second job.
                        job.celery_task_id = _new_claim()
                        job.status = JobStatus.QUEUED.value
                        job.error_code = None
                        job.error_message_safe = None
                        collision = existing
                    elif str(tid).startswith(_CLAIM_PREFIX):
                        # A concurrent (or crashed) sender holds the claim.
                        self._session.rollback()  # never wait while holding the
                        # scene lock — the sender needs it released to confirm.
                        if _claim_stale(tid, _DISPATCH_CLAIM_TTL_S):
                            # Orphaned claim (sender died between commit and
                            # send) → take it over in a fresh transaction.
                            return self._take_over_stale_claim(
                                existing.id, scene, current_version
                            )
                        confirmed = self._wait_for_dispatch_confirmation(
                            job.id, _DISPATCH_WAIT_CONFIRM_S
                        )
                        if confirmed is not None:
                            return CollisionBuildResponse(
                                job_id=str(existing.job_id),
                                status=existing.status,
                                message="碰撞构建任务派发已确认",
                            )
                        # Sender vanished right after claiming without a broker
                        # id → take over.
                        return self._take_over_stale_claim(
                            existing.id, scene, current_version
                        )
                    else:
                        # In-flight with a confirmed dispatch — no second job.
                        self._session.rollback()
                        return CollisionBuildResponse(
                            job_id=str(existing.job_id or ""),
                            status=existing.status,
                            message="碰撞构建任务已在进行中",
                        )
        elif existing.status == "SUCCEEDED" and _version_binding_satisfied(
            existing.build_params, current_asset
        ):
            # Same-version SUCCEEDED collision already exists → reuse.
            self._session.rollback()
            return CollisionBuildResponse(
                job_id=str(existing.job_id or ""),
                status="SUCCEEDED",
                message="当前版本碰撞已存在",
            )
        else:
            # FAILED, or SUCCEEDED-but-bound-to-an-old-version → this scene's
            # current version still needs a collision for it.
            collision = existing
            if existing.status == "SUCCEEDED":
                # Old-version build invalidated by a newer publish → rebuild.
                collision.build_params = None
            elif not retry_failed:
                # Scheduled reconcile semantics: only resurrect FAILED work that
                # was never confirmed-delivered, or that belongs to an OLD
                # version.  A delivered-and-failed build is left for manual retry.
                existing_job = (
                    self._session.get(Job, existing.job_id) if existing.job_id else None
                )
                dispatch_confirmed = (
                    existing_job is not None
                    and existing_job.celery_task_id is not None
                )
                if dispatch_confirmed and _version_binding_satisfied(
                    existing.build_params, current_asset
                ):
                    self._session.rollback()
                    return CollisionBuildResponse(
                        job_id=str(existing.job_id or ""),
                        status="FAILED",
                        message="碰撞构建已失败（任务已派发），保留手动重试",
                    )
            collision.mode = mode
            collision.status = "QUEUED"
            collision.error_message = None
            collision.attempt += 1
            existing_job = (
                self._session.get(Job, existing.job_id) if existing.job_id else None
            )
            if existing_job is not None and existing_job.celery_task_id is None:
                # DISPATCH_INCOMPLETE — re-send the SAME job (worker is
                # duplicate-safe); never stack a second job row.
                job = existing_job
                job.celery_task_id = _new_claim()
                job.status = JobStatus.QUEUED.value
                job.error_code = None
                job.error_message_safe = None
            else:
                job = _fresh_job()
            collision.job_id = job.id

        return self._dispatch_build(job, collision, scene, current_version)

    def _dispatch_build(
        self,
        job: Job,
        collision: Any,
        scene: Scene,
        current_version: SceneVersion,
    ) -> CollisionBuildResponse:
        """Record the version binding, commit the claim, THEN send (§C).

        Precondition: ``job.celery_task_id`` is a fresh ``sending:*`` claim set
        by the caller in the same transaction as the collision rows.  The
        commit releases the scene row lock; a concurrent crash-recovery thread
        sees the claim and waits for confirmation instead of double-sending.
        The send runs outside the lock; once the broker accepts, the real task
        id replaces the claim.  A dispatch failure clears the claim (dispatch
        was never confirmed → recoverable) and FAILs only the collision side —
        the scene stays PUBLISHED.
        """
        world_hash = self._current_world_hash(scene.id)
        params = dict(collision.build_params or {})
        # §D persistent version binding: content-addressed ``sourceVersion``
        # plus the pinned SceneVersion UUID the worker loads the SOG from.
        params["sourceVersion"] = current_version.asset_version
        params["sourceVersionId"] = str(current_version.id)
        params["worldTransformHash"] = world_hash
        collision.build_params = params
        self._session.flush()
        # DB commit FIRST (worker must see the job row + the claim survives a
        # crash), then dispatch.  Releases the scene row lock.
        self._session.commit()

        task_name = "tasks.build_collision"
        args = [
            str(job.id), str(scene.id), str(collision.id),
            collision.mode, world_hash, str(current_version.id),
        ]
        try:
            if self._send_task is not None:
                result = self._send_task(task_name, args=args)
                job.celery_task_id = str(result.id)
                self._session.commit()
                logger.info(
                    "Auto-dispatched %s for scene %s version %s",
                    task_name, scene.id, current_version.asset_version,
                )
            return CollisionBuildResponse(
                job_id=str(job.id),
                status="QUEUED",
                message=f"碰撞构建任务已创建 (模式: {collision.mode})",
            )
        except Exception:
            # Dispatch failure: FAIL collision side with a stable code, never
            # leak broker internals, and never touch the scene state.  Clear
            # the claim so recovery treats it as dispatch-incomplete.
            logger.exception("Auto-collision dispatch failed for scene %s", scene.id)
            try:
                job.status = "FAILED"
                job.error_code = "COLLISION_DISPATCH_FAILED"
                job.error_message_safe = "碰撞构建任务派发失败，可稍后重试"
                job.celery_task_id = None
                collision.status = "FAILED"
                collision.error_message = "碰撞构建任务派发失败，可稍后重试"
                self._session.commit()
            except Exception:  # pragma: no cover - best-effort bookkeeping
                self._session.rollback()
            return CollisionBuildResponse(
                job_id=str(job.id),
                status="FAILED",
                message="碰撞构建任务派发失败",
            )

    def _wait_for_dispatch_confirmation(
        self, job_id: uuid.UUID, timeout_s: float
    ) -> str | None:
        """Poll (fresh sessions, no locks held) until the job's celery_task_id
        becomes a real broker id — returns it — or ``None`` on timeout.

        Used by a concurrent ensure that observed a FRESH sending-claim: the
        sender is mid-flight (commit → send → confirm) and confirmation is a
        matter of milliseconds; blocking on the DB lock would deadlock it.
        """
        from app.db.session import SessionLocal

        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            sess = SessionLocal()
            try:
                row = sess.get(Job, job_id)
                tid = row.celery_task_id if row is not None else None
            finally:
                sess.close()
            if tid is not None and not str(tid).startswith(_CLAIM_PREFIX):
                return tid
            time.sleep(0.05)
        return None

    def _take_over_stale_claim(
        self,
        collision_id: uuid.UUID,
        scene: Scene,
        current_version: SceneVersion,
    ) -> CollisionBuildResponse:
        """Take over a crashed sender's claim in a FRESH transaction and send.

        FOR UPDATE compare-and-set on the Job row: only take over when the
        claim is still the (stale) one observed; a parallel takeover or a newer
        real delivery wins and we do nothing.  The same job id is re-sent —
        the worker's idempotency guard absorbs a duplicate that slipped through.
        """
        from sqlalchemy import select

        from app.db.models.collision_asset import CollisionAsset
        from app.db.session import SessionLocal

        sess = SessionLocal()
        try:
            coll = sess.get(CollisionAsset, collision_id)
            if coll is None or coll.job_id is None:
                return CollisionBuildResponse(
                    job_id="", status="FAILED", message="碰撞构建任务不存在"
                )
            job = sess.scalars(
                select(Job).where(Job.id == coll.job_id).with_for_update()
            ).first()
            if job is None or job.status in _JOB_TERMINAL_STATUSES:
                return CollisionBuildResponse(
                    job_id=str(coll.job_id),
                    status="QUEUED",
                    message="碰撞构建任务已结束，无需接管",
                )
            tid = job.celery_task_id
            if tid is None or not str(tid).startswith(_CLAIM_PREFIX):
                # A real (or newer missing) dispatch won → nothing to take over.
                return CollisionBuildResponse(
                    job_id=str(coll.job_id),
                    status="QUEUED",
                    message="碰撞构建任务已在进行中",
                )
            job.celery_task_id = _new_claim()
            job.status = JobStatus.QUEUED.value
            job.error_code = None
            job.error_message_safe = None
            sess.commit()
            try:
                if self._send_task is not None:
                    result = self._send_task(
                        "tasks.build_collision",
                        args=[
                            str(coll.job_id), str(scene.id), str(coll.id),
                            coll.mode, self._current_world_hash(scene.id),
                            str(current_version.id),
                        ],
                    )
                    job.celery_task_id = str(result.id)
                    sess.commit()
                return CollisionBuildResponse(
                    job_id=str(coll.job_id),
                    status="QUEUED",
                    message="碰撞构建任务已在同一作业下重新派发",
                )
            except Exception:
                logger.exception(
                    "Claim takeover dispatch failed for scene %s", scene.id
                )
                job.status = JobStatus.FAILED.value
                job.error_code = "COLLISION_DISPATCH_FAILED"
                job.error_message_safe = "碰撞构建任务派发失败，可稍后重试"
                job.celery_task_id = None
                coll.status = "FAILED"
                coll.error_message = "碰撞构建任务派发失败，可稍后重试"
                sess.commit()
                return CollisionBuildResponse(
                    job_id=str(coll.job_id),
                    status="FAILED",
                    message="碰撞构建任务派发失败",
                )
        finally:
            sess.close()

    def reconcile_auto_collision(self, limit: int = 50) -> dict[str, Any]:
        """Scheduled post-publish recovery (FIX-UPLOAD-01.1 §B).

        Invoked by the already-scheduled ``tasks.cleanup_expired_uploads``
        systemd timer — NOT Celery redelivery.  Walks PUBLISHED scenes with a
        current version and re-asserts the collision chain for MISSING rows
        and DISPATCH_INCOMPLETE / stale-version rows; a FAILED collision whose
        task was confirmed-delivered is left for the manual rebuild entry.
        """
        missing_scenes = (
            self._session.query(Scene)
            .filter(
                Scene.status == "PUBLISHED",
                Scene.current_version_id.isnot(None),
                ~self._session.query(CollisionAsset)
                .filter(CollisionAsset.scene_id == Scene.id)
                .exists(),
            )
            .order_by(Scene.created_at.desc())
            .limit(limit)
            .all()
        )
        attention_rows = (
            self._session.query(CollisionAsset)
            .join(Scene, Scene.id == CollisionAsset.scene_id)
            .filter(
                Scene.status == "PUBLISHED",
                Scene.current_version_id.isnot(None),
                CollisionAsset.status.in_(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"]),
            )
            .order_by(Scene.created_at.desc())
            .limit(limit)
            .all()
        )
        candidate_ids = {s.id for s in missing_scenes}
        candidate_ids.update(r.scene_id for r in attention_rows)

        checked = 0
        ensured = 0
        for scene_id in candidate_ids:
            scene = self._session.get(Scene, scene_id)
            if scene is None:
                continue
            checked += 1
            response = self.ensure_auto_collision_for_current_version(
                scene_id, scene.owner_id, retry_failed=False
            )
            if response is not None and response.status == "QUEUED":
                ensured += 1
        return {"ok": True, "scenes_checked": checked, "ensured": ensured}

    def _lock_scene_for_update(self, scene_id: uuid.UUID) -> Scene | None:
        """FOR UPDATE on the Scene row: exactly one collision build decision
        per scene, and the check+write+commit all happen under the lock.  The
        broker send in :meth:`_dispatch_build` runs after the commit releases
        it (§C).

        ``of=Scene`` restricts the lock to the scenes table — the model's
        ``lazy="joined"`` relationships would otherwise turn the statement into
        an outer join, which PostgreSQL refuses to lock.
        """
        from sqlalchemy import select

        stmt = (
            select(Scene)
            .where(Scene.id == scene_id)
            .with_for_update(of=Scene)
        )
        return self._session.scalars(stmt).first()

    def create_and_build(
        self,
        slug: str,
        req: CollisionAssetCreateRequest,
        owner_id: uuid.UUID,
    ) -> CollisionBuildResponse:
        """Create collision asset record and dispatch build job.

        FIX-UPLOAD-01.1 §C: serializes with the auto-dispatch / rebuild on the
        scene row lock and pins the source version onto the job.
        """
        scene = self._get_scene(slug)
        _validate_owner(scene, owner_id)
        # §C — serialize with auto-dispatch / rebuild on the scene row lock.
        locked_scene = self._lock_scene_for_update(scene.id)
        if locked_scene is None:  # pragma: no cover - row disappeared between reads
            raise NotFoundError(f"场景不存在: {slug}")
        scene = locked_scene

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
        # FIX-UPLOAD-01.1 §D：持久化版本绑定 —— 若场景已发布，钉扎当前版本。
        current_version = (
            self._session.get(SceneVersion, scene.current_version_id)
            if scene.current_version_id is not None
            else None
        )
        if current_version is not None:
            params = dict(collision.build_params or {})
            params["sourceVersion"] = current_version.asset_version
            params["sourceVersionId"] = str(current_version.id)
            collision.build_params = params
        self._session.flush()
        # §C — commit (releases the scene lock) BEFORE the broker send.
        self._session.commit()

        # Dispatch task
        task_name = "tasks.build_collision"
        args = [
            str(job.id), str(scene.id), str(collision.id), req.mode, world_hash,
            str(current_version.id) if current_version is not None else None,
        ]
        if self._send_task is not None:
            try:
                result = self._send_task(task_name, args=args)
                job.celery_task_id = str(result.id)
                self._session.commit()
                logger.info("Dispatched %s for scene %s", task_name, slug)
            except Exception:
                logger.exception("Collision dispatch failed for scene %s", slug)
                job.status = JobStatus.FAILED.value
                job.error_code = "COLLISION_DISPATCH_FAILED"
                job.error_message_safe = "碰撞构建任务派发失败，可稍后重试"
                collision.status = "FAILED"
                collision.error_message = "碰撞构建任务派发失败，可稍后重试"
                self._session.commit()
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
        # §C — serialize with auto-dispatch / manual build on the scene row.
        locked_scene = self._lock_scene_for_update(scene.id)
        if locked_scene is None:  # pragma: no cover - row disappeared between reads
            raise NotFoundError(f"场景不存在: {slug}")
        scene = locked_scene

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
        # FIX-UPLOAD-01.1 §D：重建钉扎当前发布版本（若有）。
        current_version = (
            self._session.get(SceneVersion, scene.current_version_id)
            if scene.current_version_id is not None
            else None
        )
        if current_version is not None:
            params = dict(collision.build_params or {})
            params["sourceVersion"] = current_version.asset_version
            params["sourceVersionId"] = str(current_version.id)
            collision.build_params = params
        self._session.flush()
        # §C — commit (releases the scene lock) BEFORE the broker send.
        self._session.commit()

        task_name = "tasks.build_collision"
        args = [
            str(job.id), str(scene.id), str(collision.id), collision.mode, world_hash,
            str(current_version.id) if current_version is not None else None,
        ]
        if self._send_task is not None:
            try:
                result = self._send_task(task_name, args=args)
                job.celery_task_id = str(result.id)
                self._session.commit()
                logger.info("Rebuilt collision for scene %s (attempt %d)", slug, collision.attempt)
            except Exception:
                logger.exception("Collision rebuild dispatch failed for scene %s", slug)
                job.status = JobStatus.FAILED.value
                job.error_code = "COLLISION_DISPATCH_FAILED"
                job.error_message_safe = "碰撞重建任务派发失败，可稍后重试"
                collision.status = "FAILED"
                collision.error_message = "碰撞重建任务派发失败，可稍后重试"
                self._session.commit()

        return CollisionBuildResponse(
            job_id=str(job.id),
            status="QUEUED",
            message=f"碰撞重建任务已创建 (尝试 #{collision.attempt})",
        )
