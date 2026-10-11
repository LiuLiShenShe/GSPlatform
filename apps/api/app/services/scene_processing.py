"""Read defaults without writes; changes affect future work, never published bytes."""

from __future__ import annotations

import math

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, ForbiddenError
from app.core.identity import RequestIdentity
from app.db.models.scene import Scene, SceneVersion
from app.db.models.scene_presentation import ScenePresentation
from app.db.models.scene_processing import SceneProcessingSettings
from app.schemas.scene_processing import CalibrationOut, SceneProcessingOut, SceneProcessingPatch
from app.services.scene_access import SceneAccessPolicy


def transform_identity(session: Session, scene: Scene) -> str:
    from app.services.collision import world_transform_hash

    presentation = session.scalar(
        select(ScenePresentation).where(ScenePresentation.scene_id == scene.id)
    )
    if presentation is None:
        return "identity"
    return world_transform_hash(
        presentation.world_position, presentation.world_rotation, presentation.world_scale
    ) or "identity"


def processing_for_scene(session: Session, scene: Scene) -> SceneProcessingOut:
    row = session.get(SceneProcessingSettings, scene.id)
    if row is None:
        return SceneProcessingOut()
    calibration = CalibrationOut(
        recordedState=row.calibration_state,
        metersPerSceneUnit=row.meters_per_scene_unit,
        referenceMethod=row.reference_method,
        referenceValue=row.reference_value,
        sourceVersion=row.calibration_source_version,
        transformIdentity=row.calibration_transform_identity,
        evidence=row.calibration_evidence,
    )
    version = (
        session.get(SceneVersion, scene.current_version_id) if scene.current_version_id else None
    )
    bound = (
        version is not None
        and row.calibration_source_version == version.asset_version
        and row.calibration_transform_identity == transform_identity(session, scene)
    )
    calibration.stale = row.calibration_state != "UNVERIFIED" and not bound
    if bound:
        calibration.state = calibration.recordedState
    calibration.physicalWalkAllowed = (
        calibration.state == "VERIFIED"
        and calibration.metersPerSceneUnit is not None
        and math.isclose(calibration.metersPerSceneUnit, 1.0, rel_tol=1e-9)
        and calibration.transformIdentity == "identity"
    )
    return SceneProcessingOut(
        sceneType=row.scene_type,
        conversionProfile=row.conversion_profile,
        collisionPolicy=row.collision_policy,
        calibration=calibration,
        createdAt=row.created_at,
        updatedAt=row.updated_at,
    )


class SceneProcessingService:
    def __init__(self, session: Session) -> None:
        self._session = session
        self._access = SceneAccessPolicy(session)

    def get(
        self, slug: str, identity: RequestIdentity | None, share_token: str | None = None
    ) -> SceneProcessingOut:
        scene = self._access.resolve_readable_scene(slug, identity, share_token=share_token)
        result = processing_for_scene(self._session, scene)
        from app.services.collision_policy import resolve_collision_decision

        result.collisionDecision = resolve_collision_decision(self._session, scene)
        return result

    def patch(
        self, slug: str, identity: RequestIdentity, request: SceneProcessingPatch
    ) -> SceneProcessingOut:
        scene = self._access.resolve_readable_scene(slug, identity)
        if not self._access.is_owner(scene, identity.user_id):
            raise ForbiddenError("只有场景所有者可以修改处理策略")
        scene = self._session.scalars(
            select(Scene).where(Scene.id == scene.id).with_for_update(of=Scene)
        ).one()
        row = self._session.get(SceneProcessingSettings, scene.id)
        if row is None:
            row = SceneProcessingSettings(scene_id=scene.id)
            self._session.add(row)
        for field, column in (
            ("sceneType", "scene_type"),
            ("conversionProfile", "conversion_profile"),
            ("collisionPolicy", "collision_policy"),
        ):
            if field in request.model_fields_set:
                setattr(row, column, getattr(request, field))
        assumption = request.calibration
        if assumption is not None:
            version = (
                self._session.get(SceneVersion, scene.current_version_id)
                if scene.current_version_id else None
            )
            if assumption.state == "ASSUMED" and version is None:
                raise ConflictError("尺度假设必须绑定已发布版本")
            row.calibration_state = assumption.state
            row.meters_per_scene_unit = assumption.metersPerSceneUnit
            row.reference_method = assumption.referenceMethod
            row.reference_value = assumption.referenceValue
            row.calibration_source_version = version.asset_version if version else None
            row.calibration_transform_identity = transform_identity(self._session, scene)
            row.calibration_evidence = {"provenance": assumption.provenance}
        self._session.flush()
        result = processing_for_scene(self._session, scene)
        from app.services.collision_policy import resolve_collision_decision

        result.collisionDecision = resolve_collision_decision(self._session, scene)
        return result
