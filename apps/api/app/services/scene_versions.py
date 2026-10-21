"""GS-NEXT-11 — scene version browsing and **safe rollback** (activation).

Rollback means re-pointing ``Scene.current_version_id`` at an **existing
immutable** ``SceneVersion``. It never:

* regenerates a SOG / re-runs any conversion,
* rewrites a historical manifest,
* copies over or deletes a storage directory,
* deletes any old version.

Consistency ordering (the filesystem and PostgreSQL are *not* one
transaction):

1. take the scene row lock and validate everything (ownership, target
   version, asset readiness, optimistic-concurrency token, in-flight jobs);
2. bridge the scene-origin ``current`` alias to the target version (idempotent)
   and verify the authorized asset endpoint can resolve the target entry;
3. only then mutate the DB pointer (``current_version_id`` + catalogue summary
   + spatial binding) and commit explicitly (read-your-write, GS-NEXT-02);
4. if step 2 fails → roll back the DB (current version unchanged); if step 3
   fails → best-effort bridge the alias back to the previous version.

So the forbidden state — *DB switched but the resource entry still points at
the old version* — cannot happen: the pointer only moves after the entry is
already serving the target.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.errors import (
    ConflictError,
    ForbiddenError,
    NotFoundError,
    ServiceUnavailableError,
    UnauthorizedError,
)
from app.core.identity import RequestIdentity
from app.db.models.asset import Asset
from app.db.models.enums import AssetKind
from app.db.models.job import Job
from app.db.models.scene import Scene, SceneVersion
from app.db.models.scene_edit_session import SceneEditSession
from app.db.models.scene_spatial_state import SceneSpatialState
from app.repositories.scene_versions import SceneVersionRepository
from app.schemas.common import PageMeta
from app.schemas.scene_version import (
    SceneVersionActivateOut,
    SceneVersionListOut,
    SceneVersionOut,
    SpatialBindingOut,
)
from app.services.publish_service import (
    bridge_scene_origin,
    scene_origin_slug_dir,
    verify_scene_origin_alias,
)
from app.services.scene_processing import processing_for_scene

#: Default on-disk entry filename for single-file versions, by version format.
_SINGLE_FILE_DEFAULTS = {"sog": "scene.sog", "ply": "scene.ply", "splat": "scene.splat"}

#: Job states that mean "work is still running for this scene".
_ACTIVE_JOB_STATES = ("QUEUED", "RUNNING", "CANCEL_REQUESTED")

#: Edit-session states that mean "an edit flow is still open".
_INACTIVE_EDIT_STATES = ("COMPLETED", "FAILED", "CANCELLED", "EXPIRED")

#: Scene statuses on which a rollback makes sense (never promote a non-published
#: scene by rolling back — a READY scene stays READY).
_ACTIVATABLE_STATUSES = ("PUBLISHED", "READY")


def version_entry_name(version: SceneVersion) -> str | None:
    """The entry file a viewer loads for *version* (``scene.sog`` …).

    Derived from the published manifest when present (``assetUrl`` for
    single-file, ``stream.entryUrl`` for streamed), else from the well-known
    per-format default. Deliberately **no** filesystem access.
    """
    manifest = version.manifest or {}
    streamed = version.format == "streamed-sog" or manifest.get("format") == "streamed-sog"
    if streamed:
        stream = manifest.get("stream")
        entry = stream.get("entryUrl") if isinstance(stream, dict) else None
        if isinstance(entry, str) and entry.strip():
            return entry.rstrip("/").rsplit("/", 1)[-1]
        return "lod-meta.json"
    asset_url = manifest.get("assetUrl")
    if isinstance(asset_url, str) and asset_url.strip():
        return asset_url.rstrip("/").rsplit("/", 1)[-1]
    return _SINGLE_FILE_DEFAULTS.get(version.format)


def version_physical_dir(scene: Scene, asset_version: str) -> Path | None:
    """Directory that physically serves ``versions/<asset_version>``, or None.

    Two legitimate layouts are recognised:

    * the publish pipeline's immutable tree
      ``<storage_root>/published/<scene_id>/versions/<av>``;
    * a legacy/seed layout that already lives in the scene-origin tree at
      ``<origin>/<slug>/versions/<av>`` (a real directory, or a symlink into
      the published tree).
    """
    settings = get_settings()
    storage_dir = (
        Path(settings.storage_root).expanduser()
        / "published"
        / str(scene.id)
        / "versions"
        / asset_version
    )
    if storage_dir.is_dir():
        return storage_dir
    slug_dir = scene_origin_slug_dir(scene)
    if slug_dir is not None:
        origin_dir = slug_dir / "versions" / asset_version
        if origin_dir.is_dir():
            return origin_dir
    return None


def _readiness(scene: Scene, version: SceneVersion) -> tuple[bool, bool, str | None]:
    """``(manifestReady, assetsReady, entryName)`` for a version — no writes."""
    entry = version_entry_name(version)
    directory = version_physical_dir(scene, version.asset_version)
    manifest_ready = bool(version.manifest)
    if directory is None or entry is None:
        return manifest_ready, False, entry

    entry_file = directory / entry
    assets_ready = entry_file.is_file()
    if assets_ready and version.manifest is not None:
        # The published manifest must be present, parseable, and describe
        # *this* version's entry — otherwise the version is corrupt or only
        # partially published. Identity fields are checked instead of a full
        # dict equality: the on-disk manifest may legitimately carry extra
        # build metadata that the DB record does not repeat.
        manifest_file = directory / "manifest.json"
        if not manifest_file.is_file():
            return True, False, entry
        try:
            payload = json.loads(manifest_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return True, False, entry
        if not isinstance(payload, dict):
            return True, False, entry
        recorded_version = payload.get("assetVersion")
        if recorded_version is not None and recorded_version != version.asset_version:
            return True, False, entry
        manifest_format = payload.get("format")
        if manifest_format is not None and manifest_format != version.format:
            return True, False, entry
        stream = payload.get("stream")
        references = [payload.get("assetUrl")]
        if isinstance(stream, dict):
            references.append(stream.get("entryUrl"))
        prefix = f"versions/{version.asset_version}/"
        for reference in references:
            if isinstance(reference, str) and reference and not reference.startswith(
                ("http://", "https://")
            ):
                if not reference.lstrip("/").startswith(prefix):
                    # Entry pointing at a different version = corrupt record.
                    return True, False, entry
    return manifest_ready, assets_ready, entry


def _counts(version: SceneVersion, asset_counts: list[int] | None) -> list[int]:
    manifest = version.manifest or {}
    for key in ("content", "stream"):
        block = manifest.get(key)
        if isinstance(block, dict):
            counts = block.get("counts")
            if isinstance(counts, list) and counts:
                return [int(c) for c in counts]
    if asset_counts:
        return list(asset_counts)
    return []


class SceneVersionService:
    """Version history + activation for one scene (owner-scoped)."""

    def __init__(self, session: Session) -> None:
        self._session = session
        self._repo = SceneVersionRepository(session)

    # ------------------------------------------------------------------ #
    # helpers
    # ------------------------------------------------------------------ #
    def _owner_scene(self, slug: str, identity: RequestIdentity) -> Scene:
        """Resolve a scene for its owner: 404 missing/deleted, 403 not owner."""
        scene = self._session.scalars(
            select(Scene).where(Scene.slug == slug)
        ).first()
        if scene is None or scene.deleted_at is not None:
            raise NotFoundError(f"场景 {slug} 不存在")
        if identity.user_id is None:
            raise UnauthorizedError("请先登录")
        if scene.owner_id != identity.user_id:
            raise ForbiddenError("只有场景所有者可以管理历史版本")
        return scene

    def _spatial_binding(self, scene: Scene) -> SpatialBindingOut:
        from app.services.spatial_binding import resolve_status

        status = resolve_status(self._session, scene)
        return SpatialBindingOut(
            state=status.state,
            boundVersionId=(
                str(status.bound_version_id) if status.bound_version_id else None
            ),
            requiresConfirmation=status.requires_confirmation,
            staleAt=status.stale_at,
            revision=status.revision,
            pendingFeatures=list(status.pending_features),
            confirmedFeatures=list(status.confirmed_features),
        )

    def _to_out(
        self, scene: Scene, version: SceneVersion, counts: list[int] | None
    ) -> SceneVersionOut:
        manifest_ready, assets_ready, entry = _readiness(scene, version)
        resolved = _counts(version, counts)
        return SceneVersionOut(
            id=str(version.id),
            assetVersion=version.asset_version,
            format=version.format,
            sizeBytes=version.size_bytes,
            sha256=version.sha256,
            gaussianCount=resolved[0] if resolved else None,
            lodLevels=len(resolved) or None,
            createdAt=version.created_at,
            isCurrent=scene.current_version_id == version.id,
            manifestReady=manifest_ready,
            assetsReady=assets_ready,
            entryName=entry,
        )

    # ------------------------------------------------------------------ #
    # public API
    # ------------------------------------------------------------------ #
    def list_versions(
        self,
        slug: str,
        identity: RequestIdentity,
        *,
        limit: int = 20,
        cursor: str | None = None,
    ) -> SceneVersionListOut:
        """Owner-only, newest-first, stable keyset pagination."""
        scene = self._owner_scene(slug, identity)
        try:
            rows, next_cursor = self._repo.list_by_scene(
                scene.id, limit=limit, cursor=cursor
            )
        except ValueError as exc:
            raise ConflictError(str(exc)) from exc

        counts_by_version: dict[uuid.UUID, list[int]] = {}
        if rows:
            asset_rows = self._session.scalars(
                select(Asset).where(
                    Asset.version_id.in_([v.id for v in rows]),
                    Asset.kind == AssetKind.SOG.value,
                )
            ).all()
            for asset in asset_rows:
                meta = asset.metadata_ or {}
                counts = meta.get("counts")
                if asset.version_id is not None and isinstance(counts, list) and counts:
                    counts_by_version[asset.version_id] = [int(c) for c in counts]

        items = [self._to_out(scene, v, counts_by_version.get(v.id)) for v in rows]
        return SceneVersionListOut(
            items=items,
            meta=PageMeta(
                limit=limit,
                nextCursor=next_cursor,
                total=self._repo.count_by_scene(scene.id),
            ),
            currentVersionId=(
                str(scene.current_version_id) if scene.current_version_id else None
            ),
            spatial=self._spatial_binding(scene),
        )

    def activate(
        self,
        slug: str,
        version_id: uuid.UUID,
        identity: RequestIdentity,
        *,
        expected_current_version_id: uuid.UUID | None,
    ) -> SceneVersionActivateOut:
        """Re-activate (roll back to) an existing immutable version."""
        # 1) Row lock first: every read below is then consistent with the flip.
        scene = self._session.scalars(
            select(Scene)
            .where(Scene.slug == slug)
            .with_for_update(of=Scene)
            .execution_options(populate_existing=True)
        ).first()
        if scene is None or scene.deleted_at is not None:
            raise NotFoundError(f"场景 {slug} 不存在")
        if identity.user_id is None:
            raise UnauthorizedError("请先登录")
        if scene.owner_id != identity.user_id:
            raise ForbiddenError("只有场景所有者可以切换历史版本")

        if scene.status not in _ACTIVATABLE_STATUSES:
            raise ConflictError(
                f"场景当前状态为 {scene.status}，只有已发布（或待发布）的作品可以切换历史版本",
                details={"status": scene.status},
            )

        # The CAS token — the client tells us which version it believes is
        # current; a mismatch means a background publish / another window
        # moved the pointer first. Never blindly overwrite.
        current_id = scene.current_version_id
        expected = expected_current_version_id
        if current_id != expected:
            raise ConflictError(
                "当前版本已被其他操作改变，请刷新后重试",
                details={
                    "currentVersionId": str(current_id) if current_id else None,
                    "expectedCurrentVersionId": str(expected) if expected else None,
                },
            )

        target = self._session.get(SceneVersion, version_id)
        if target is None or target.scene_id != scene.id:
            # Never confirm the existence of another scene's version.
            raise NotFoundError("目标版本不存在")

        # In-flight publication / editing must not be silently overwritten.
        active_job = self._session.scalars(
            select(Job.id).where(
                Job.scene_id == scene.id, Job.status.in_(_ACTIVE_JOB_STATES)
            )
        ).first()
        if active_job is not None:
            raise ConflictError("场景仍有正在运行的任务，请等待任务结束后再切换版本")
        open_edit = self._session.scalars(
            select(SceneEditSession.id).where(
                SceneEditSession.scene_id == scene.id,
                SceneEditSession.status.notin_(_INACTIVE_EDIT_STATES),
            )
        ).first()
        if open_edit is not None:
            raise ConflictError("场景存在进行中的编辑会话，请先结束编辑再切换版本")

        manifest_ready, assets_ready, entry = _readiness(scene, target)
        if not assets_ready or not manifest_ready:
            # A corrupt / missing / incompletely published target is never a
            # valid rollback destination.
            raise ConflictError(
                "目标版本资产缺失或未完整发布，无法切换",
                details={
                    "versionId": str(target.id),
                    "manifestReady": manifest_ready,
                    "assetsReady": assets_ready,
                },
            )

        # Idempotent re-activation of the current version: verify the entry is
        # healthy (self-heal the alias) but change nothing.
        if current_id == target.id:
            bridge_scene_origin(scene, target.asset_version)
            return SceneVersionActivateOut(
                message="该版本已是当前版本",
                sceneId=scene.slug,
                previousVersionId=str(target.id),
                currentVersionId=str(target.id),
                changed=False,
                spatial=self._spatial_binding(scene),
                collisionPolicy=self._collision_policy(scene),
                affectedSpatialFeatures=[],
            )

        previous = self._session.get(SceneVersion, current_id) if current_id else None
        previous_av = previous.asset_version if previous is not None else None

        # 2) Filesystem first: point the origin alias at the target and make
        # sure the authorized endpoint can serve it *before* the DB moves.
        bridged = bridge_scene_origin(scene, target.asset_version)
        if not bridged or verify_scene_origin_alias(scene, target.asset_version) is False:
            if previous_av is not None:
                bridge_scene_origin(scene, previous_av)
            raise ServiceUnavailableError(
                "版本资源入口切换失败，当前版本未改变，请稍后重试"
            )

        # 3) DB pointer + catalogue summary + conservative spatial invalidation.
        scene.current_version_id = target.id
        resolved = _counts(target, None)
        scene.splat_count = resolved[0] if resolved else scene.splat_count
        scene.size_bytes = target.size_bytes
        affected = self._invalidate_spatial(scene, previous)
        self._session.flush()

        try:
            self._session.commit()
        except Exception:
            self._session.rollback()
            if previous_av is not None:
                bridge_scene_origin(scene, previous_av)
            raise

        return SceneVersionActivateOut(
            message="已切换当前版本",
            sceneId=scene.slug,
            previousVersionId=str(previous.id) if previous is not None else None,
            currentVersionId=str(target.id),
            changed=True,
            spatial=self._spatial_binding(scene),
            collisionPolicy=self._collision_policy(scene),
            affectedSpatialFeatures=affected,
        )

    # ------------------------------------------------------------------ #
    # spatial protection
    # ------------------------------------------------------------------ #
    def _affectable_features(self, scene: Scene) -> list[str]:
        """Names of the authored spatial features that exist for this scene."""
        from app.db.models.asset import Asset as _Asset
        from app.repositories.authoring import (
            SceneAnnotationRepository,
            ScenePresentationRepository,
            SceneViewpointRepository,
        )

        features: list[str] = []
        presentation = ScenePresentationRepository(self._session).get_by_scene(scene.id)
        if presentation is not None:
            if presentation.initial_camera_position and presentation.initial_camera_target:
                features.append("initialCamera")
            if (
                presentation.world_position
                or presentation.world_rotation
                or presentation.world_scale
            ):
                features.append("worldTransform")
            if presentation.collision_enabled:
                features.append("collision")
        if SceneViewpointRepository(self._session).list_by_scene(scene.id):
            features.append("viewpoints")
        if SceneAnnotationRepository(self._session).list_by_scene(scene.id):
            features.append("annotations")
        collision = self._session.scalars(
            select(_Asset.id).where(
                _Asset.scene_id == scene.id,
                _Asset.kind.in_(
                    [AssetKind.COLLISION_GLB.value, AssetKind.COLLISION_VOXEL.value]
                ),
            )
        ).first()
        if collision is not None:
            features.append("collisionAsset")
        processing = processing_for_scene(self._session, scene)
        if processing.calibration.recordedState != "UNVERIFIED":
            features.append("calibration")
        return features

    def _invalidate_spatial(self, scene: Scene, previous: SceneVersion | None) -> list[str]:
        """Conservatively mark the spatial authoring STALE after a switch.

        We never delete the saved initial camera / viewpoints / annotations /
        collision records — the runtime contract simply stops trusting them
        while the binding is STALE, and the UI must ask the owner to
        re-confirm.  This is deliberately unconditional, even when the target
        is the very version the authoring was made against: the platform has
        no verified spatial re-confirmation entry point yet, and the same
        switch would otherwise silently re-enable collision / calibration /
        ground Walk.
        """
        affected = self._affectable_features(scene)
        now = datetime.now(UTC)
        row = self._session.get(SceneSpatialState, scene.id)
        if row is None:
            if not affected:
                return []
            source = previous.id if previous is not None else scene.current_version_id
            if source is None:
                return affected
            self._session.add(
                SceneSpatialState(
                    scene_id=scene.id,
                    source_version_id=source,
                    state="STALE",
                    stale_at=now,
                    revision=1,
                )
            )
            return affected
        # Keep the recorded binding (historical evidence) — only flip the state
        # and bump the monotonic revision.  The revision invalidates collision
        # builds that survived an A→B→A round-trip.  Per-feature (re)bindings on
        # the presentation / viewpoints / annotations are deliberately left
        # untouched: they stay bound to the version they were authored against.
        row.state = "STALE"
        row.stale_at = now
        row.revision = (row.revision or 0) + 1
        return affected

    def _collision_policy(self, scene: Scene) -> str | None:
        return processing_for_scene(self._session, scene).collisionPolicy
