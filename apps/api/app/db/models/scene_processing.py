"""Finite processing policy, independent of catalog and immutable assets."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, Float, ForeignKey, String, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SceneProcessingSettings(Base):
    __tablename__ = "scene_processing_settings"

    scene_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("scenes.id", ondelete="CASCADE"), primary_key=True
    )
    scene_type: Mapped[str] = mapped_column(
        String(30), nullable=False, default="UNSPECIFIED", server_default="UNSPECIFIED"
    )
    conversion_profile: Mapped[str] = mapped_column(
        String(20), nullable=False, default="balanced", server_default="balanced"
    )
    collision_policy: Mapped[str] = mapped_column(
        String(30), nullable=False, default="MANUAL_ONLY", server_default="MANUAL_ONLY"
    )
    calibration_state: Mapped[str] = mapped_column(
        String(20), nullable=False, default="UNVERIFIED", server_default="UNVERIFIED"
    )
    meters_per_scene_unit: Mapped[float | None] = mapped_column(Float, nullable=True)
    reference_method: Mapped[str | None] = mapped_column(String(40), nullable=True)
    reference_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    calibration_source_version: Mapped[str | None] = mapped_column(String(80), nullable=True)
    calibration_transform_identity: Mapped[str | None] = mapped_column(String(16), nullable=True)
    calibration_evidence: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    __table_args__ = (
        CheckConstraint(
            "scene_type IN ('UNSPECIFIED','PLANT_OBJECT','GREENHOUSE_SCENE','FIELD_SCENE')",
            name="scene_type_valid",
        ),
        CheckConstraint(
            "conversion_profile IN ('balanced','eco','quality')", name="conversion_profile_valid"
        ),
        CheckConstraint(
            "collision_policy IN ('MANUAL_ONLY','AUTO_WHEN_CALIBRATED')",
            name="collision_policy_valid",
        ),
        CheckConstraint(
            "calibration_state IN ('UNVERIFIED','ASSUMED','VERIFIED')",
            name="calibration_state_valid",
        ),
        CheckConstraint(
            "calibration_state = 'UNVERIFIED' OR ("
            "meters_per_scene_unit IS NOT NULL AND meters_per_scene_unit > 0 AND "
            "meters_per_scene_unit < 'Infinity'::float8 AND "
            "reference_value IS NOT NULL AND reference_value > 0 AND "
            "reference_value < 'Infinity'::float8 AND reference_method IS NOT NULL AND "
            "calibration_source_version IS NOT NULL AND "
            "calibration_transform_identity IS NOT NULL AND calibration_evidence IS NOT NULL "
            "AND jsonb_typeof(calibration_evidence) = 'object')",
            name="calibration_binding_required",
        ),
        CheckConstraint(
            "calibration_state <> 'VERIFIED' OR ("
            "reference_method IN ('MEASURED_DISTANCE','SURVEY_CONTROL') AND "
            "calibration_evidence ? 'verifiedBy' AND "
            "coalesce(length(calibration_evidence->>'verifiedBy'), 0) > 0 AND "
            "calibration_evidence ? 'evidenceSha256' AND "
            "coalesce(calibration_evidence->>'evidenceSha256', '') ~ '^[a-f0-9]{64}$' AND "
            "calibration_evidence ? 'provenance' AND "
            "coalesce(length(calibration_evidence->>'provenance'), 0) > 0)",
            name="verified_evidence_required",
        ),
    )
