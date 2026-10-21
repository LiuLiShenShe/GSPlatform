"""Per-feature version binding for spatial authoring (GS-NEXT-12 §A).

GS-NEXT-11 made a version switch conservatively invalidate the *whole* spatial
authoring: ``scene_spatial_states.state = 'STALE'`` and the runtime dropped the
initial camera, world transform, viewpoints, annotations and collision
unconditionally.  That was the right default, but there was **no way out**:
nothing ever re-confirmed anything, so after a single rollback a scene could
never serve a freshly saved initial camera again.  That is the P1 this module
fixes.

The mechanism is deliberately per-feature and version-bound:

* every viewpoint / annotation records the ``SceneVersion`` it was last
  authored or explicitly updated against (``source_version_id``);
* the presentation records the version its initial camera / world transform
  were last saved against;
* collision (and scale calibration, via its own binding) keep their
  independent gates — they are **never** re-enabled by re-authoring a camera.

The runtime trusts a feature only when it is bound to the scene's *current*
version.  Historical rows keep their old binding (or stay NULL = "legacy,
never confirmed") and are not deleted, so they can never be re-enabled just
because a different feature was saved.

When the scene has no :class:`SceneSpatialState` row at all, nothing was ever
invalidated, so everything is trusted — this is the exact pre-GS-NEXT-11
behaviour and keeps existing scenes regression-free.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models.collision_asset import CollisionAsset
from app.db.models.scene import Scene, SceneVersion
from app.db.models.scene_annotation import SceneAnnotation
from app.db.models.scene_presentation import ScenePresentation
from app.db.models.scene_processing import SceneProcessingSettings
from app.db.models.scene_spatial_state import SceneSpatialState
from app.db.models.scene_viewpoint import SceneViewpoint

#: Features that authoring writes may (re)confirm against the current version.
REAUTHORABLE_FEATURES = ("initialCamera", "worldTransform", "viewpoints", "annotations")

#: Features that are only ever enabled by their own independent build /
#: verification flow (never by saving a camera).
GATED_FEATURES = ("collision", "calibration")

#: Every feature the spatial binding can report on.
ALL_FEATURES = (*REAUTHORABLE_FEATURES, *GATED_FEATURES)


@dataclass(frozen=True)
class SpatialStatus:
    """Derived, per-feature view of the scene's spatial bindings.

    ``state`` is ``VALID`` / ``STALE`` / ``NONE``; ``pending_features`` lists
    what still has to be re-confirmed before the runtime trusts it again.
    """

    state: str
    bound_version_id: uuid.UUID | None
    requires_confirmation: bool
    stale_at: datetime | None = None
    revision: int = 0
    pending_features: list[str] = field(default_factory=list)
    confirmed_features: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------- #
# primitives
# --------------------------------------------------------------------------- #
def current_version(session: Session, scene: Scene) -> SceneVersion | None:
    if scene.current_version_id is None:
        return None
    return session.get(SceneVersion, scene.current_version_id)


def spatial_state_row(session: Session, scene: Scene) -> SceneSpatialState | None:
    return session.get(SceneSpatialState, scene.id)


def spatial_revision(session: Session, scene: Scene) -> int:
    """Monotonic invalidation counter (0 when the scene was never invalidated)."""
    row = spatial_state_row(session, scene)
    return (row.revision or 0) if row is not None else 0


def is_stale(session: Session, scene: Scene) -> bool:
    """True when an invalidation record exists and does not match the current version.

    A scene with no record at all was never invalidated → never stale.  Only
    the explicit ``STALE`` marker counts as an invalidation: historical rows
    may carry other legacy state strings (e.g. ``VERIFIED``) which were always
    served by the runtime.
    """
    row = spatial_state_row(session, scene)
    if row is None:
        return False
    if row.state == "STALE":
        return True
    if scene.current_version_id is None:
        # A scene without a current version cannot confirm anything against it;
        # serving legacy author data here would be an unversioned trust grant.
        return True
    return row.source_version_id != scene.current_version_id


def bound_to_current(session: Session, scene: Scene, version_id: uuid.UUID | None) -> bool:
    """Whether an authored record is trusted for the current version.

    While the scene is *not* stale everything is trusted (legacy semantics).
    Once invalidated, only an explicit binding to the current version is.
    """
    if not is_stale(session, scene):
        return True
    return version_id is not None and version_id == scene.current_version_id


def confirm_current(session: Session, scene: Scene, *features: str) -> None:
    """Bind authored presentation features to the scene's current version.

    Never flips the global ``SceneSpatialState`` row to VALID: that row is the
    historical invalidation record and independently gates collision / walk.
    """
    if scene.current_version_id is None:
        return
    pres = presentation_for(session, scene)
    if pres is None:
        return
    now = datetime.now(UTC)
    for feature in features:
        if feature == "initialCamera":
            pres.initial_camera_version_id = scene.current_version_id
        elif feature == "worldTransform":
            pres.world_transform_version_id = scene.current_version_id
    pres.updated_at = now
    session.flush()


# --------------------------------------------------------------------------- #
# lookups
# --------------------------------------------------------------------------- #
def presentation_for(session: Session, scene: Scene) -> ScenePresentation | None:
    return session.scalar(
        select(ScenePresentation).where(ScenePresentation.scene_id == scene.id)
    )


def _viewpoints(session: Session, scene: Scene) -> list[SceneViewpoint]:
    return list(
        session.scalars(select(SceneViewpoint).where(SceneViewpoint.scene_id == scene.id))
    )


def _annotations(session: Session, scene: Scene) -> list[SceneAnnotation]:
    return list(
        session.scalars(select(SceneAnnotation).where(SceneAnnotation.scene_id == scene.id))
    )


def _collision(session: Session, scene: Scene) -> CollisionAsset | None:
    return session.scalar(
        select(CollisionAsset).where(CollisionAsset.scene_id == scene.id)
    )


def _collision_exists(session: Session, scene: Scene) -> bool:
    collision = _collision(session, scene)
    return (
        collision is not None
        and collision.status == "SUCCEEDED"
        and collision.asset_id is not None
    )


def collision_pending(session: Session, scene: Scene) -> bool:
    """A succeeded collision is pending until rebuilt after the invalidation.

    Only meaningful while the scene is stale (otherwise the collision's own
    version/hash/calibration gates decide, exactly as before GS-NEXT-12).
    A collision whose ``build_params`` predate this mechanism has no
    ``spatialRevision`` — it cannot prove it was built after the invalidation,
    so it stays disabled until an explicit rebuild records the current one.
    """
    if not is_stale(session, scene):
        return False
    collision = _collision(session, scene)
    if collision is None or collision.status != "SUCCEEDED" or collision.asset_id is None:
        return False
    params = collision.build_params or {}
    recorded = params.get("spatialRevision")
    if recorded is None or recorded != spatial_revision(session, scene):
        return True
    version = current_version(session, scene)
    recorded_version = params.get("sourceVersion")
    return (
        bool(recorded_version)
        and version is not None
        and recorded_version != version.asset_version
    )


def calibration_pending(session: Session, scene: Scene) -> bool:
    if not is_stale(session, scene):
        return False
    row = session.get(SceneProcessingSettings, scene.id)
    if row is None or row.calibration_state == "UNVERIFIED":
        return False
    version = current_version(session, scene)
    return version is None or row.calibration_source_version != version.asset_version


def _feature_present(session: Session, scene: Scene, feature: str) -> bool:
    pres = presentation_for(session, scene)
    if feature == "initialCamera":
        return bool(pres and pres.initial_camera_position and pres.initial_camera_target)
    if feature == "worldTransform":
        return bool(
            pres and (pres.world_position or pres.world_rotation or pres.world_scale)
        )
    if feature == "viewpoints":
        return bool(_viewpoints(session, scene))
    if feature == "annotations":
        return bool(_annotations(session, scene))
    return False


# --------------------------------------------------------------------------- #
# derived status
# --------------------------------------------------------------------------- #
def resolve_status(session: Session, scene: Scene) -> SpatialStatus:
    """Compute the derived per-feature binding status for API consumers."""
    row = spatial_state_row(session, scene)
    if row is None:
        return SpatialStatus(
            state="NONE",
            bound_version_id=None,
            requires_confirmation=False,
            stale_at=None,
            revision=0,
        )

    current_id = scene.current_version_id
    stale = (
        row.state == "STALE"
        or current_id is None
        or row.source_version_id != current_id
    )
    revision = row.revision or 0
    if not stale:
        return SpatialStatus(
            state="VALID",
            bound_version_id=row.source_version_id,
            requires_confirmation=False,
            stale_at=row.stale_at,
            revision=revision,
            confirmed_features=[
                feature
                for feature in REAUTHORABLE_FEATURES
                if _feature_present(session, scene, feature)
            ],
        )

    pending: list[str] = []
    confirmed: list[str] = []
    pres = presentation_for(session, scene)
    if pres is not None and pres.initial_camera_position and pres.initial_camera_target:
        target = (
            confirmed
            if current_id is not None and pres.initial_camera_version_id == current_id
            else pending
        )
        target.append("initialCamera")
    if pres is not None and (
        pres.world_position or pres.world_rotation or pres.world_scale
    ):
        target = (
            confirmed
            if current_id is not None and pres.world_transform_version_id == current_id
            else pending
        )
        target.append("worldTransform")
    viewpoints = _viewpoints(session, scene)
    if viewpoints:
        if current_id is not None and all(
            vp.source_version_id == current_id for vp in viewpoints
        ):
            confirmed.append("viewpoints")
        else:
            pending.append("viewpoints")
    annotations = _annotations(session, scene)
    if annotations:
        if current_id is not None and all(
            ann.source_version_id == current_id for ann in annotations
        ):
            confirmed.append("annotations")
        else:
            pending.append("annotations")
    if collision_pending(session, scene):
        pending.append("collision")
    elif _collision_exists(session, scene):
        confirmed.append("collision")
    if calibration_pending(session, scene):
        pending.append("calibration")
    else:
        calibration = session.get(SceneProcessingSettings, scene.id)
        if calibration is not None and calibration.calibration_state != "UNVERIFIED":
            confirmed.append("calibration")

    return SpatialStatus(
        # Stays STALE while any invalidation is recorded, even if every
        # *re-authorable* feature has been re-confirmed: the record also gates
        # collision / scale calibration, and GS-NEXT-11's contract (and the
        # web UI) treats "STALE" as "this scene was switched and needs
        # attention", not "the runtime is serving nothing".  What the runtime
        # actually trusts is exactly ``pending_features``.
        state="STALE",
        bound_version_id=row.source_version_id if pending else current_id,
        requires_confirmation=bool(pending),
        stale_at=row.stale_at,
        revision=revision,
        pending_features=pending,
        confirmed_features=confirmed,
    )
