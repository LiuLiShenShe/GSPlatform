"""Bind automatically scaled geometry and its calibration evidence atomically."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models.scene import Scene, SceneVersion
from app.db.models.scene_edit_session import SceneEditSession
from app.db.models.scene_presentation import ScenePresentation
from app.db.models.scene_processing import SceneProcessingSettings
from app.services.scene_processing import transform_identity


def finish_calibration(
    db: Session, scene: Scene, result: SceneVersion, edit: SceneEditSession
) -> None:
    provenance = edit.provenance or {}
    request = provenance["automaticCalibration"]
    scene.calibration_locked_at = datetime.now(UTC)
    factor = request["scaleFactor"]
    presentation = db.scalar(
        select(ScenePresentation).where(ScenePresentation.scene_id == scene.id).with_for_update()
    )
    previous = None
    if presentation:
        previous = {
            "position": presentation.world_position,
            "rotation": presentation.world_rotation,
            "scale": presentation.world_scale,
            "sourceVersionId": str(presentation.world_transform_version_id)
            if presentation.world_transform_version_id
            else None,
        }
        # Only source-bound cameras in an identity world can be scaled directly.
        # Other cameras remain version-stale, so the viewer frames the new asset.
        identity_world = (
            not presentation.world_position
            and not presentation.world_rotation
            and not presentation.world_scale
        )
        if identity_world and presentation.initial_camera_version_id == edit.source_version_id:
            for name in ("initial_camera_position", "initial_camera_target"):
                value = getattr(presentation, name)
                if value:
                    setattr(presentation, name, {axis: n * factor for axis, n in value.items()})
            presentation.initial_camera_version_id = result.id
        presentation.world_position = None
        presentation.world_rotation = None
        presentation.world_scale = None
        presentation.world_transform_version_id = result.id
        presentation.updated_at = datetime.now(UTC)
    db.flush()
    evidence = {
        **request,
        "sourceVersionId": str(edit.source_version_id),
        "resultVersionId": str(result.id),
        "editSessionId": str(edit.id),
        "realLengthMeters": request["realLength"]
        * {"mm": 0.001, "cm": 0.01, "m": 1}[request["unit"]],
        "geometryScaleAppliedBy": "OFFICIAL_SPLAT_TRANSFORM",
        "verification": provenance["automaticVerification"],
        "exportSha256": edit.result_sha256,
        "previousWorldTransform": previous,
        "worldTransformPolicy": "METRIC_EXPORT_WITH_IDENTITY_PRESENTATION",
        "transformIdentity": transform_identity(db, scene),
        "evidenceTrust": "USER_ENTERED_REFERENCE; AUTOMATED_GEOMETRY_VERIFICATION",
        "recordedBy": str(edit.owner_id),
        "recordedAt": datetime.now(UTC).isoformat(),
    }
    canonical = json.dumps(evidence, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    evidence["evidenceSha256"] = hashlib.sha256(canonical.encode()).hexdigest()
    row = db.get(SceneProcessingSettings, scene.id)
    if row is None:
        row = SceneProcessingSettings(scene_id=scene.id)
        db.add(row)
    row.calibration_state = "ASSUMED"
    # Old queued calibrations used meter coordinates. Preserve their contract.
    row.meters_per_scene_unit = 0.01 if request.get("geometryUnits") == "cm" else 1.0
    row.reference_method = "USER_ASSUMPTION"
    row.reference_value = evidence["realLengthMeters"]
    row.calibration_source_version = result.asset_version
    row.calibration_transform_identity = evidence["transformIdentity"]
    row.calibration_evidence = evidence
    edit.provenance = {**provenance, "calibration": evidence}
