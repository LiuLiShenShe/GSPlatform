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
import os
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
#   - "sending:<uuid>:<epoch_ms>" → a sender has claimed the send but the broker
#     has not confirmed yet (crash window between commit and send);
#   - any other value → the real broker task id (confirmed delivery).
# A concurrent ensure/reconcile never re-sends a FRESH claim (the sender is
# mid-flight); it waits briefly for confirmation.  A STALE claim (older than
# the TTL *measured on the database clock*) means the sender crashed between
# commit and send — a new sender takes it over by FOR UPDATE compare-and-set on
# the Job row, re-sending the SAME job id.
#
# FIX-UPLOAD-01.2 PART A: the embedded timestamp is a **database** epoch
# (``clock_timestamp()``), never ``time.monotonic()``.  A monotonic reading has
# no meaningful origin, so it is not comparable across processes, hosts, or
# restarts — a persisted lease must be judged by a clock everyone shares.
_CLAIM_PREFIX = "sending:"
_DISPATCH_CLAIM_TTL_S = 60.0
_DISPATCH_WAIT_CONFIRM_S = 5.0
# A claim timestamp from the future beyond this skew is treated as unusable
# (recoverable) rather than as "fresh forever".
_CLAIM_MAX_FUTURE_SKEW_S = 300.0

# FIX-UPLOAD-01.3 PART A: an execution lease is renewed by the worker's
# heartbeat, so an EXPIRED one provably means "the claiming worker died".  The
# scheduled reconcile re-queues such an orphan job for a fresh execution
# generation.  The cap stops a permanently failing build from looping forever
# through automatic recovery — past it, the owner rebuilds manually.
_MAX_AUTO_RECOVERY_ATTEMPTS = 3

_JOB_TERMINAL_STATUSES = {
    JobStatus.SUCCEEDED.value,
    JobStatus.FAILED.value,
    JobStatus.CANCELLED.value,
    JobStatus.CANCEL_REQUESTED.value,
}


def _db_now_ms(session: Session) -> int:
    """Authoritative current time in epoch milliseconds, read from PostgreSQL.

    The single time source for dispatch leases (FIX-UPLOAD-01.2 PART A).  Using
    the database clock keeps TTL semantics identical across API hosts, worker
    processes, and restarts, and immune to local clock skew.
    """
    from sqlalchemy import text

    row = session.execute(
        text("SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint")
    ).first()
    if row is None:  # pragma: no cover - SELECT 1 always returns a row
        raise RuntimeError("database clock query returned no row")
    return int(row[0])


def _new_claim(session: Session) -> str:
    """Mint a fresh claim token stamped with the database clock."""
    return f"{_CLAIM_PREFIX}{uuid.uuid4().hex}:{_db_now_ms(session)}"


def _parse_claim(claim: str | None) -> tuple[str, int] | None:
    """Parse ``sending:<uuid>:<epoch_ms>``.

    Returns ``None`` for anything else — including the pre-01.2
    ``time.monotonic()`` format and truncated ``celery_task_id`` values.  A
    token we cannot parse cannot be aged, so it is treated as *unusable*
    (recoverable by takeover) rather than as fresh-forever.
    """
    if not isinstance(claim, str) or not claim.startswith(_CLAIM_PREFIX):
        return None
    parts = claim.split(":")
    if len(parts) != 3 or len(parts[1]) != 32:
        return None
    try:
        stamp = int(parts[2])
    except ValueError:
        return None
    if stamp <= 0:
        return None
    return parts[1], stamp


def _claim_expired(
    claim: str | None, now_ms: int, ttl_s: float = _DISPATCH_CLAIM_TTL_S
) -> bool:
    """True when ``claim`` may be taken over, judged on the DB clock.

    * unparseable → ``True`` (recoverable; never blocks recovery forever);
    * timestamped in the future beyond the allowed skew → ``True`` (unusable);
    * otherwise expired only once ``now - stamp`` exceeds the TTL.
    """
    parsed = _parse_claim(claim)
    if parsed is None:
        return True
    _uuid_hex, stamp_ms = parsed
    if stamp_ms > now_ms + (_CLAIM_MAX_FUTURE_SKEW_S * 1000):
        return True
    return (now_ms - stamp_ms) > (ttl_s * 1000)


def _claim_stale(claim: str | None, session: Session | None = None) -> bool:
    """Thin compatibility wrapper — ages ``claim`` against the DB clock.

    FIX-UPLOAD-01.1 callers used this without a session; when no session is
    supplied we open one so the clock is still the database's.
    """
    if session is not None:
        return _claim_expired(claim, _db_now_ms(session))
    from app.db.session import SessionLocal

    sess = SessionLocal()
    try:
        return _claim_expired(claim, _db_now_ms(sess))
    finally:
        sess.close()


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

        FIX-UPLOAD-01.2 PART C — serving binds the whole chain:
        Scene → current SceneVersion → CollisionAsset → status SUCCEEDED →
        version-aligned build_params → current jobId → same-build asset →
        asset version matches the current version.  Any link missing (or an
        old job's artifact still on disk) ⇒ refuse, never fall back to a
        ``created_at DESC`` guess.
        """
        scene = self._get_scene(slug)
        asset, _bin_key = self._resolve_collision_asset(scene, "COLLISION_GLB")
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
        directory (C-10: a json whose binStorageKey points at another job's
        directory must be refused).
        """
        scene = self._get_scene(slug)
        asset, bin_key = self._resolve_collision_asset(
            scene, "COLLISION_VOXEL", wanted_bin=binary
        )
        if asset is None:
            raise NotFoundError(f"场景 {slug} 没有碰撞体素数据")
        if binary:
            if not bin_key:
                raise NotFoundError(f"场景 {slug} 缺少 voxel.bin 资源")
            self._assert_bin_key_safe(scene.id, bin_key)
            return self._storage.read(bin_key), "application/octet-stream"
        return self._storage.read(asset.storage_key), "application/json"

    def _resolve_collision_asset(
        self,
        scene: Scene,
        kind: str,
        *,
        wanted_bin: bool = False,
    ) -> tuple[Asset | None, str | None]:
        """PART C — the full version-safe binding, in one place.

        Returns ``(asset, bin_key)``; ``(None, None)`` when any link of the
        chain is missing so callers refuse rather than guess.

        * Collision row must exist and be SUCCEEDED (QUEUED / RUNNING /
          FAILED / version-mismatch must not surface old artifacts).
        * ``build_params`` must align with the scene's CURRENT SceneVersion
          (``sourceVersion`` content hash and, when recorded, the version id).
        * Job-scoped layouts: the Asset row must belong to the collision's own
          job (``metadata_["collisionJobId"]``) and match the current version.
        * Legacy single-build layouts (``job_id IS NULL``) are served ONLY when
          ownership is provable: ``collision.asset_id`` points at a unique
          legacy Asset consistent with the current version and not owned by a
          job; a sibling kind (json↔glb) must live in the SAME storage
          directory with exactly-one candidate — otherwise refuse and require
          a rebuild (never ``created_at DESC`` guessing).
        """
        current_version = self._session.get(SceneVersion, scene.current_version_id)
        if current_version is None:
            return None, None
        collision = self._repo.get_by_scene_id(scene.id)
        if collision is None or collision.status != "SUCCEEDED":
            return None, None
        # Version alignment, mirroring get_collision's STALE semantics: a
        # RECORDED sourceVersion/sourceVersionId that mismatches the current
        # version refuses serving (old builds never masquerade as current).
        # Rows that recorded nothing (FIX-05-era legacy) cannot be proven
        # mismatched and keep serving — zero regression.
        params = collision.build_params or {}
        recorded_sv = params.get("sourceVersion")
        if recorded_sv and recorded_sv != current_version.asset_version:
            return None, None
        recorded_svid = params.get("sourceVersionId")
        if recorded_svid and str(recorded_svid) != str(current_version.id):
            return None, None
        if collision.job_id is not None:
            asset = self._job_scoped_asset(scene, current_version, collision.job_id, kind)
        else:
            asset = self._legacy_asset(scene, current_version, collision, kind)
        if asset is None:
            return None, None
        if wanted_bin:
            bin_key = (asset.metadata_ or {}).get("binStorageKey")
            if not bin_key:
                return None, None
            # C-10: json and its bin MUST come from the same build directory.
            # A json whose binStorageKey points at another job's dir (or a
            # sibling legacy dir) is a mispairing — refuse.
            if os.path.dirname(bin_key) != os.path.dirname(asset.storage_key):
                return None, None
            return asset, bin_key
        return asset, None

    def _job_scoped_asset(
        self, scene: Scene, current_version: SceneVersion, job_id: uuid.UUID, kind: str
    ) -> Asset | None:
        """Asset row of ONE collision build, owned by the collision's job."""
        for candidate in self._assets_of_job(scene.id, job_id, kind):
            if candidate.version_id in (
                None,  # pre-pinning rows still belong to their own job
                current_version.id,
            ):
                return candidate
        return None

    def _legacy_asset(
        self,
        scene: Scene,
        current_version: SceneVersion,
        collision: Any,
        kind: str,
    ) -> Asset | None:
        """Provable legacy single-build resolution (no job scoping)."""
        if collision.asset_id is None:
            # No pointer at all → we cannot prove ownership → refuse (C-09).
            return None
        pointed = self._session.get(Asset, collision.asset_id)
        if pointed is None or pointed.version_id not in (None, current_version.id):
            return None
        if pointed.kind == kind:
            return pointed
        # Sibling of the same legacy build: same kind + same storage
        # directory + version-aligned + never owned by a job, and EXACTLY
        # one candidate — anything else is unprovable, refuse.
        pointed_dir = os.path.dirname(pointed.storage_key)
        matches = [
            candidate
            for candidate in (
                self._session.query(Asset)
                .filter(
                    Asset.scene_id == scene.id,
                    Asset.kind == kind,
                    Asset.created_at.is_not(None),
                )
                .order_by(Asset.created_at.asc())
            )
            if candidate.version_id in (None, current_version.id)
            and (candidate.metadata_ or {}).get("collisionJobId") is None
            and os.path.dirname(candidate.storage_key) == pointed_dir
        ]
        if len(matches) != 1:
            return None
        return matches[0]

    def _assert_bin_key_safe(self, scene_id: uuid.UUID, bin_key: str) -> None:
        """C-10 + PART H: ``binStorageKey`` must stay in the scene's own
        collision area and must never escape it (no traversal, no absolute
        path, no leading slash, no ``..``)."""
        norm = os.path.normpath(bin_key)
        if (
            norm.startswith(("/", "../"))
            or ".." in norm.split("/")
            or f"collision/{scene_id}/" not in "/" + norm
        ):
            raise NotFoundError(f"场景 {scene_id} 缺少合法的 voxel.bin 资源")

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
                celery_task_id=_new_claim(self._session),
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
                    # FIX-UPLOAD-01.3 PART A: an ORPHANED execution — the job
                    # is RUNNING but its execution lease expired (the worker
                    # died, so nothing renews it any more) — is re-queued here
                    # and re-dispatched by the scheduled reconcile.  We do NOT
                    # rely on Celery redelivery (acks_late is best-effort and a
                    # hard kill loses the message entirely).
                    orphan_lease = (
                        job.status == JobStatus.RUNNING.value
                        and job.lease_expires_at is not None
                        and job.lease_expires_at.timestamp()
                        <= _db_now_ms(self._session) / 1000.0
                    )
                    if orphan_lease:
                        if (
                            job.execution_generation >= _MAX_AUTO_RECOVERY_ATTEMPTS
                        ):
                            # Recovery cap reached — leave the (fenced, orphan)
                            # job as-is and surface the collision as FAILED so
                            # the owner can trigger a manual rebuild instead of
                            # the reconcile looping forever.
                            logger.warning(
                                "Collision job %s for scene %s hit the auto "
                                "recovery cap (%d executions); manual rebuild "
                                "required", job.id, scene.id,
                                _MAX_AUTO_RECOVERY_ATTEMPTS,
                            )
                            existing.status = "FAILED"
                            existing.error_message = (
                                "碰撞构建反复中断，请手动重建"
                            )
                            self._session.commit()
                            return CollisionBuildResponse(
                                job_id=str(existing.job_id or ""),
                                status="FAILED",
                                message="碰撞构建反复中断，请手动重建",
                            )
                        job.status = JobStatus.QUEUED.value
                        job.started_at = None
                        job.lease_expires_at = None
                        job.error_code = None
                        job.error_message_safe = None
                        job.celery_task_id = _new_claim(self._session)
                        existing.status = "QUEUED"
                        collision = existing
                    elif tid is None:
                        # DISPATCH_INCOMPLETE — rows committed but the broker
                        # send was never confirmed; claim and re-send the same
                        # job (worker is duplicate-safe).  Never a second job.
                        job.celery_task_id = _new_claim(self._session)
                        job.status = JobStatus.QUEUED.value
                        job.error_code = None
                        job.error_message_safe = None
                        collision = existing
                    elif str(tid).startswith(_CLAIM_PREFIX):
                        # A concurrent (or crashed) sender holds the claim.
                        # FIX-UPLOAD-01.2 PART A: waiting 5s for a confirmation
                        # does NOT make a 60s claim stale.  A FRESH claim is
                        # never taken over; only a claim that is actually older
                        # than the TTL on the *database* clock may be.
                        observed_claim = str(tid)
                        expired = _claim_expired(
                            observed_claim, _db_now_ms(self._session)
                        )
                        self._session.rollback()  # never wait while holding the
                        # scene lock — the sender needs it released to confirm.
                        if expired:
                            # Orphaned claim (sender died between commit and
                            # send) → CAS takeover in a fresh transaction.
                            return self._take_over_stale_claim(
                                existing.id,
                                scene.id,
                                observed_claim,
                                current_version,
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
                        # Still fresh: the sender may just be slow.  Report
                        # pending — taking over now would double-dispatch.
                        return CollisionBuildResponse(
                            job_id=str(existing.job_id),
                            status=existing.status,
                            message="碰撞构建任务派发中（尚未确认）",
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
                job.celery_task_id = _new_claim(self._session)
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
        current_version: SceneVersion | None,
        *,
        success_message: str | None = None,
    ) -> CollisionBuildResponse:
        """Record the version binding, commit the claim, THEN send (§C).

        Precondition: ``job.celery_task_id`` is a fresh ``sending:*`` claim set
        by the caller in the same transaction as the collision rows.  The
        commit releases the scene row lock; a concurrent crash-recovery thread
        sees the claim and waits for confirmation instead of double-sending.
        The send runs outside the lock; once the broker accepts, the real task
        id replaces the claim.

        FIX-UPLOAD-01.3 PART B: this is the SINGLE dispatch contract for every
        entry point (auto-ensure, claim takeover, manual create, manual
        rebuild).  An uncertain send outcome moves a still-QUEUED job to the
        *recoverable* dispatch-incomplete state (claim cleared, reconciled
        later) — it never FAILs a job, because a network error does not prove
        the broker never received the message.

        ``current_version`` may be ``None`` for a scene that has never been
        published: no version binding is recorded and the worker falls back to
        the scene's current version at build time.
        """
        world_hash = self._current_world_hash(scene.id)
        params = dict(collision.build_params or {})
        # §D persistent version binding: content-addressed ``sourceVersion``
        # plus the pinned SceneVersion UUID the worker loads the SOG from.
        if current_version is not None:
            params["sourceVersion"] = current_version.asset_version
            params["sourceVersionId"] = str(current_version.id)
        params["worldTransformHash"] = world_hash
        collision.build_params = params
        # FIX-UPLOAD-01.2 PART A: remember the claim we hold so the broker
        # write-back is a compare-and-set — a late success can never overwrite
        # a newer sender's takeover.
        my_claim = str(job.celery_task_id or "")
        self._session.flush()
        # DB commit FIRST (worker must see the job row + the claim survives a
        # crash), then dispatch.  Releases the scene row lock.
        self._session.commit()

        task_name = "tasks.build_collision"
        args = [
            str(job.id), str(scene.id), str(collision.id),
            collision.mode, world_hash,
            str(current_version.id) if current_version is not None else None,
        ]
        try:
            if self._send_task is not None:
                result = self._send_task(task_name, args=args)
                # Claim-guarded write-back: only our claim may be replaced by
                # the broker id (a takeover winner's claim is left untouched).
                self._record_broker_confirmation(
                    job.id, expected_claim=my_claim, task_id=str(result.id)
                )
                self._session.expire_all()  # orphan the caller's stale view
                logger.info(
                    "Auto-dispatched %s for scene %s version %s",
                    task_name, scene.id,
                    current_version.asset_version if current_version else "-",
                )
            return CollisionBuildResponse(
                job_id=str(job.id),
                status="QUEUED",
                message=success_message
                or f"碰撞构建任务已创建 (模式: {collision.mode})",
            )
        except Exception:
            # Dispatch outcome is UNCERTAIN (PART B): the broker may well have
            # accepted the message before our socket died.  We therefore only
            # move a still-QUEUED job to the recoverable dispatch-incomplete
            # state — never FAILED, never touching a running/finished worker.
            logger.exception("Auto-collision dispatch failed for scene %s", scene.id)
            self._record_broker_failure(job.id, expected_claim=my_claim)
            self._session.expire_all()  # orphan the caller's stale view
            return CollisionBuildResponse(
                job_id=str(job.id),
                status="QUEUED",
                message="碰撞构建任务派发未确认（将自动重试）",
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

    def _record_broker_confirmation(
        self,
        job_id: uuid.UUID,
        *,
        expected_claim: str,
        task_id: str,
    ) -> bool:
        """CAS-confirm a broker accept onto the Job row (A-05/A-07).

        Only the sender whose claim is STILL the persisted one may write its
        broker task id.  A sender that lost its claim to a takeover (or to a
        newer dispatch) must not clobber the winner's state — a late success is
        silently dropped.  Returns True iff the write happened.
        """
        from sqlalchemy import select

        from app.db.session import SessionLocal

        sess = SessionLocal()
        try:
            job = sess.scalars(
                select(Job).where(Job.id == job_id).with_for_update()
            ).first()
            if job is None:
                sess.rollback()
                return False
            if str(job.celery_task_id or "") != expected_claim:
                # A newer sender replaced our claim — we lost the race.
                sess.rollback()
                return False
            job.celery_task_id = task_id
            sess.commit()
            return True
        except Exception:
            sess.rollback()
            raise
        finally:
            sess.close()

    def _record_broker_failure(
        self,
        job_id: uuid.UUID,
        *,
        expected_claim: str,
    ) -> bool:
        """CAS-record an UNCERTAIN dispatch outcome on the Job row.

        FIX-UPLOAD-01.3 PART B — **this callback may never FAIL a job that is
        running or finished.**  A broker send that raises is *uncertain*: a
        network error, a timeout or a broken socket does **not** prove the
        broker never received the message (the classic "accepted, reply lost"
        case).  Failing the job on that evidence discards a real build: the
        worker may already be mid-run, or may even have committed SUCCEEDED
        while this late callback is still unwinding its socket.

        The safe transition is therefore:

        * claim is no longer ours (a takeover/newer dispatch replaced it)
          → **do nothing** (``False``);
        * the job is RUNNING (a worker claimed it) or already terminal
          (SUCCEEDED / FAILED / CANCELLED) → **do nothing** (``False``).
          A late callback never overwrites live or completed state;
        * the job is still ``QUEUED`` → the outcome is genuinely uncertain, so
          we move it to the *recoverable* dispatch-incomplete state: clear the
          claim (letting the scheduled reconcile re-send the SAME job) and drop
          the transient error fields.  The job is **not** FAILED — nothing
          proves the broker refused it, and a permanently-FAILED job would be
          indistinguishable from a real build failure.

        Returns ``True`` iff this callback actually changed the state (i.e. it
        owned the claim and moved the job to the recoverable state).
        """
        from sqlalchemy import select

        from app.db.models.collision_asset import CollisionAsset
        from app.db.models.scene import Scene
        from app.db.session import SessionLocal

        sess = SessionLocal()
        try:
            # Peek the job's scene id WITHOUT any lock (only to pick rows).
            peek = sess.get(Job, job_id)
            if peek is None:
                sess.rollback()
                return False
            scene_id = peek.scene_id
            # Unified lock order Scene → CollisionAsset → Job, matching the
            # worker finalization (avoids any cross-order deadlock).
            sess.scalars(
                select(Scene)
                .where(Scene.id == scene_id)
                .with_for_update(of=Scene)
            ).first()
            sess.scalars(
                select(CollisionAsset)
                .where(CollisionAsset.scene_id == scene_id)
                .with_for_update()
            ).first()
            probe = sess.scalars(
                select(Job).where(Job.id == job_id).with_for_update()
            ).first()
            if probe is None:
                sess.rollback()
                return False
            if str(probe.celery_task_id or "") != expected_claim:
                sess.rollback()
                return False
            # A live or already-finished build is never touched by a late
            # sender failure (PART B: RUNNING/SUCCEEDED must survive).
            if probe.status != JobStatus.QUEUED.value:
                logger.info(
                    "Ignoring late dispatch failure for job %s in status %s "
                    "(uncertain broker outcome; the worker owns it)",
                    job_id, probe.status,
                )
                sess.rollback()
                return False
            # Still QUEUED ⇒ the send was never confirmed.  Make it recoverable:
            # clear the claim so the scheduled reconcile re-sends the SAME job
            # (worker execution is fenced by generation, so a duplicate send is
            # a safe no-op).
            probe.celery_task_id = None
            probe.error_code = None
            probe.error_message_safe = None
            sess.commit()
            logger.info(
                "Dispatch outcome uncertain for job %s; left recoverable for "
                "reconcile re-send", job_id,
            )
            return True
        except Exception:
            sess.rollback()
            raise
        finally:
            sess.close()

    def _take_over_stale_claim(
        self,
        collision_id: uuid.UUID,
        scene_id: uuid.UUID,
        expected_claim: str,
        current_version: SceneVersion,
    ) -> CollisionBuildResponse:
        """Take over a crashed sender's claim in a FRESH transaction and send.

        FIX-UPLOAD-01.2 PART A — the takeover is a locked compare-and-set, not
        a "has 5s passed → fire".  Under the unified lock order
        (Scene → CollisionAsset → Job) we re-read fresh state and proceed ONLY
        if ALL of:

          * the scene row still exists and is the same scene;
          * the collision row still exists and still points at the same job;
          * the job is not terminal;
          * the persisted claim is EXACTLY the ``expected_claim`` we observed
            (a parallel takeover replaced it → we lose, do nothing);
          * that claim is still expired on the DATABASE clock;
          * the scene's current version is unchanged (a newer publish
            invalidates the claim — we must not dispatch the old version).

        The replace + COMMIT happen under the locks, then the broker send runs
        outside them and is confirmed by a claim-guarded CAS write-back, so a
        late sender can never overwrite the winner's broker id.
        """
        from sqlalchemy import select

        from app.db.models.collision_asset import CollisionAsset
        from app.db.models.scene import Scene
        from app.db.session import SessionLocal

        sess = SessionLocal()
        try:
            # Lock order Scene → CollisionAsset → Job, fresh reads only.
            scene = sess.scalars(
                select(Scene)
                .where(Scene.id == scene_id)
                .with_for_update(of=Scene)
                .execution_options(populate_existing=True)
            ).first()
            if scene is None:
                sess.rollback()
                return CollisionBuildResponse(
                    job_id="", status="FAILED", message="碰撞构建任务不存在"
                )
            coll = sess.scalars(
                select(CollisionAsset)
                .where(CollisionAsset.id == collision_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            ).first()
            if coll is None or coll.job_id is None:
                sess.rollback()
                return CollisionBuildResponse(
                    job_id="", status="FAILED", message="碰撞构建任务不存在"
                )
            job = sess.scalars(
                select(Job)
                .where(Job.id == coll.job_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            ).first()
            if job is None or job.status in _JOB_TERMINAL_STATUSES:
                sess.rollback()
                return CollisionBuildResponse(
                    job_id=str(coll.job_id),
                    status="QUEUED",
                    message="碰撞构建任务已结束，无需接管",
                )
            # CAS step 1: the persisted claim must still be the one observed.
            if str(job.celery_task_id or "") != expected_claim:
                # A parallel takeover (or a confirmed newer dispatch) won.
                sess.rollback()
                return CollisionBuildResponse(
                    job_id=str(coll.job_id),
                    status="QUEUED",
                    message="碰撞构建任务已在进行中",
                )
            # CAS step 2: the claim must still be expired on the DB clock.
            if not _claim_expired(expected_claim, _db_now_ms(sess)):
                # Fresh again — the sender may have confirmed between our read
                # and our lock.  Never take over a live claim.
                sess.rollback()
                return CollisionBuildResponse(
                    job_id=str(coll.job_id),
                    status="QUEUED",
                    message="碰撞构建任务派发中（尚未确认）",
                )
            # CAS step 3: the scene must still point at the version we were
            # asked to dispatch — a newer publish invalidates the old claim.
            if scene.current_version_id != current_version.id:
                sess.rollback()
                return CollisionBuildResponse(
                    job_id=str(coll.job_id),
                    status="QUEUED",
                    message="碰撞构建任务版本已更新，由新版本接管",
                )
            # Atomic replace + COMMIT under the locks.
            new_claim = _new_claim(sess)
            job.celery_task_id = new_claim
            job.status = JobStatus.QUEUED.value
            job.error_code = None
            job.error_message_safe = None
            coll.status = "QUEUED"
            coll.error_message = None
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
                    # Claim-guarded write-back: only our new claim can be
                    # replaced by the broker id.
                    self._record_broker_confirmation(
                        coll.job_id,
                        expected_claim=new_claim,
                        task_id=str(result.id),
                    )
                return CollisionBuildResponse(
                    job_id=str(coll.job_id),
                    status="QUEUED",
                    message="碰撞构建任务已在同一作业下重新派发",
                )
            except Exception:
                logger.exception(
                    "Claim takeover dispatch failed for scene %s", scene.id
                )
                self._record_broker_failure(
                    coll.job_id, expected_claim=new_claim
                )
                return CollisionBuildResponse(
                    job_id=str(coll.job_id),
                    status="QUEUED",
                    message="碰撞构建任务派发未确认（将自动重试）",
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
            collision.status = "QUEUED"
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
        # FIX-UPLOAD-01.3 PART B: manual builds use the SAME dispatch contract
        # as the auto path — a fresh ``sending:*`` claim minted in the same
        # transaction as the collision rows, then handed to ``_dispatch_build``
        # (commit → send → claim-guarded confirm / recoverable failure).
        job = Job(
            scene_id=scene.id,
            owner_id=owner_id,
            kind=JobKind.BUILD_COLLISION.value,
            status=JobStatus.QUEUED.value,
            progress=0,
            celery_task_id=_new_claim(self._session),
        )
        self._session.add(job)
        self._session.flush()

        collision.job_id = job.id
        # FIX-UPLOAD-01.1 §D：持久化版本绑定 —— 若场景已发布，钉扎当前版本。
        # (未发布场景没有版本可钉扎；worker 会在构建时回退到当前版本。)
        current_version = (
            self._session.get(SceneVersion, scene.current_version_id)
            if scene.current_version_id is not None
            else None
        )
        return self._dispatch_build(
            job,
            collision,
            scene,
            current_version,
            success_message=f"碰撞构建任务已创建 (模式: {req.mode})",
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
            # FIX-UPLOAD-01.3 PART B: same dispatch contract as every other
            # entry point — claim minted with the rows, then ``_dispatch_build``.
            celery_task_id=_new_claim(self._session),
        )
        self._session.add(job)
        self._session.flush()

        collision.job_id = job.id
        # FIX-UPLOAD-01.1 §D：重建钉扎当前发布版本（若有）。
        current_version = (
            self._session.get(SceneVersion, scene.current_version_id)
            if scene.current_version_id is not None
            else None
        )
        return self._dispatch_build(
            job,
            collision,
            scene,
            current_version,
            success_message=f"碰撞重建任务已创建 (尝试 #{collision.attempt})",
        )
