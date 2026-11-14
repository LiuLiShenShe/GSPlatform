"""Calibration is the first, one-time geometry operation for a scene."""

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import ConflictError
from app.db.models.scene import Scene
from app.db.models.scene_annotation import SceneAnnotation
from app.db.models.scene_edit_session import SceneEditSession
from app.db.models.scene_presentation import ScenePresentation
from app.db.models.scene_processing import SceneProcessingSettings
from app.db.models.scene_viewpoint import SceneViewpoint


def calibration_blocked_reason(db: Session, scene: Scene) -> str | None:
    processing = db.get(SceneProcessingSettings, scene.id)
    evidence = (processing.calibration_evidence or {}) if processing else {}
    if evidence.get("geometryScaleAppliedBy"):
        return "尺度标定已完成，请继续调整视角和标注；不能重复缩放。"
    if scene.calibration_locked_at or evidence.get("authoringStartedAt"):
        return (
            "已保存其他编辑操作，尺度标定已锁定，避免破坏视角和标注。"
            "请在未编辑的重建结果上先完成标定。"
        )
    presentation = db.scalar(
        select(ScenePresentation).where(ScenePresentation.scene_id == scene.id)
    )
    if presentation and any(
        (
            presentation.initial_camera_position,
            presentation.initial_camera_target,
            presentation.initial_camera_fov,
            presentation.world_position,
            presentation.world_rotation,
            presentation.world_scale,
            presentation.background_color,
            presentation.background_asset_id,
            presentation.cover_asset_id,
            presentation.background_audio_asset_id,
            presentation.post_effects,
            presentation.tonemapping != "aces",
            presentation.high_precision_rendering,
        )
    ):
        return "此场景已保存视角或场景设置，尺度标定必须在这些操作之前完成。"
    for model in (SceneViewpoint, SceneAnnotation):
        if db.scalar(select(model.id).where(model.scene_id == scene.id).limit(1)):
            return "此场景已有视角点或标注，尺度标定已锁定。"
    if db.scalar(
        select(SceneEditSession.id)
        .where(SceneEditSession.scene_id == scene.id, SceneEditSession.status == "COMPLETED")
        .limit(1)
    ):
        return "此场景已发布过编辑结果，尺度标定必须在其他编辑操作之前完成。"
    return None


def mark_authoring_started(db: Session, scene: Scene) -> None:
    # Same scene lock as calibration admission/publication: a save cannot slip
    # between the initial check and the worker's publication.
    db.execute(select(Scene.id).where(Scene.id == scene.id).with_for_update())
    db.refresh(scene)
    active = db.scalars(
        select(SceneEditSession).where(
            SceneEditSession.scene_id == scene.id,
            SceneEditSession.status.not_in(["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"]),
            SceneEditSession.expires_at > datetime.now(UTC),
        )
    ).all()
    if any((edit.provenance or {}).get("automaticCalibration") for edit in active):
        raise ConflictError("尺度标定正在进行，请等待完成后再保存其他编辑。")
    if scene.calibration_locked_at is None:
        scene.calibration_locked_at = datetime.now(UTC)
        db.flush()
