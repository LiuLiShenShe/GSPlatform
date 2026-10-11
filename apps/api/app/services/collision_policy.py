"""Admission of new collision work; not job recovery or voxel generation."""

from __future__ import annotations

import math
import os
from typing import Any, Literal

from sqlalchemy.orm import Session

from app.db.models.collision_asset import CollisionAsset
from app.db.models.job import Job
from app.db.models.scene import Scene, SceneVersion
from app.schemas.scene_processing import SceneProcessingOut
from app.services.scene_processing import processing_for_scene, transform_identity


def _positive_limit(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
        return value if value > 0 else default
    except ValueError:
        return default


def resolve_collision_decision(
    session: Session, scene: Scene, *, trigger_mode: Literal["AUTO", "MANUAL"] = "AUTO",
    acknowledge_unverified_scale: bool = False, rebuilding: bool = False,
) -> dict[str, Any]:
    processing = processing_for_scene(session, scene)
    version = (
        session.get(SceneVersion, scene.current_version_id)
        if scene.current_version_id else None
    )
    collision = session.query(CollisionAsset).filter(CollisionAsset.scene_id == scene.id).first()
    result: dict[str, Any] = {
        "shouldBuild": False, "triggerMode": trigger_mode, "sceneType": processing.sceneType,
        "calibrationState": processing.calibration.state,
        "sourceVersion": version.asset_version if version else None,
        "reasonCode": "POLICY_MANUAL_ONLY", "resourceEstimate": None,
        "physicalScaleVerified": processing.calibration.physicalWalkAllowed,
    }

    def denied(reason: str) -> dict[str, Any]:
        result["reasonCode"] = reason
        return result

    if version is None or scene.status != "PUBLISHED":
        return denied("CURRENT_VERSION_REQUIRED")
    if (collision is not None and collision.status in ("QUEUED", "RUNNING")
            and collision.job_id is not None
            and session.get(Job, collision.job_id) is not None
            and (collision.build_params or {}).get("sourceVersion") == version.asset_version):
        return denied("ALREADY_RUNNING")
    if collision is not None and collision.status == "SUCCEEDED" and not rebuilding:
        params = collision.build_params or {}
        if (params.get("sourceVersion") == version.asset_version
                and (params.get("worldTransformHash") or "identity")
                == transform_identity(session, scene)):
            return denied("ALREADY_SUCCEEDED")
    if trigger_mode == "AUTO" and processing.collisionPolicy == "MANUAL_ONLY":
        return denied("POLICY_MANUAL_ONLY")
    if processing.calibration.stale and not acknowledge_unverified_scale:
        return denied("CALIBRATION_STALE")
    if processing.calibration.state != "VERIFIED":
        if trigger_mode == "AUTO" or not acknowledge_unverified_scale:
            return denied("CALIBRATION_UNVERIFIED")
    elif not processing.calibration.physicalWalkAllowed:
        if trigger_mode == "AUTO" or not acknowledge_unverified_scale:
            return denied("CALIBRATION_REQUIRES_UNIT_NORMALIZATION")
    estimate = _resource_estimate(scene, version)
    result["resourceEstimate"] = estimate
    if not estimate["withinOperatorBudget"]:
        return denied("RESOURCE_BUDGET_EXCEEDED")
    if trigger_mode == "AUTO" and not _auto_budget_approved(processing, estimate):
        return denied("RESOURCE_BUDGET_EXCEEDED")
    result["shouldBuild"] = True
    result["reasonCode"] = "READY_TO_BUILD"
    return result


def _resource_estimate(scene: Scene, version: SceneVersion) -> dict[str, Any]:
    manifest = version.manifest or {}
    counts = manifest.get("stream", {}).get("counts", [])
    count = scene.splat_count or (counts[0] if counts else None)
    source_bytes = scene.size_bytes or version.size_bytes
    limits = {
        "maxGaussians": _positive_limit("GS_COLLISION_MAX_GAUSSIANS", 1_000_000),
        "maxSourceBytes": _positive_limit("GS_COLLISION_MAX_SOURCE_BYTES", 256 * 1024 * 1024),
    }
    within_budget = (
        isinstance(count, int) and not isinstance(count, bool)
        and 0 < count <= limits["maxGaussians"]
        and 0 < source_bytes <= limits["maxSourceBytes"]
    )
    return {
        "gaussianCount": count, "sourceBytes": source_bytes,
        "withinOperatorBudget": within_budget,
        "limits": limits, "estimateKind": "count-and-source-byte-admission",
    }


def _auto_budget_approved(processing: SceneProcessingOut, estimate: dict[str, Any]) -> bool:
    evidence = processing.calibration.evidence or {}
    approved = evidence.get("collisionBudget")
    if not isinstance(approved, dict) or not approved.get("approvedBy"):
        return False
    for field, measured in (("maxGaussians", estimate["gaussianCount"]),
                            ("maxSourceBytes", estimate["sourceBytes"])):
        maximum = approved.get(field)
        if type(maximum) is not int or maximum <= 0 or measured > maximum:
            return False
    scale = processing.calibration.metersPerSceneUnit
    return scale is not None and math.isclose(scale, 1.0, rel_tol=1e-9)
