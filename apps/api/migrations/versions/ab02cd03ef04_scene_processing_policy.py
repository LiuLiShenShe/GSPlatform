"""Add independent scene processing policy; existing scene/version rows are untouched.

Revision ID: ab02cd03ef04
Revises: f6a7b8c9d0e1
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from sqlalchemy.dialects.postgresql import JSONB

revision: str = "ab02cd03ef04"
down_revision: str | None = "f6a7b8c9d0e1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "scene_processing_settings",
        sa.Column("scene_id", sa.Uuid(), sa.ForeignKey("scenes.id", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("scene_type", sa.String(30), nullable=False, server_default="UNSPECIFIED"),
        sa.Column("conversion_profile", sa.String(20), nullable=False, server_default="balanced"),
        sa.Column("collision_policy", sa.String(30), nullable=False, server_default="MANUAL_ONLY"),
        sa.Column("calibration_state", sa.String(20), nullable=False, server_default="UNVERIFIED"),
        sa.Column("meters_per_scene_unit", sa.Float(), nullable=True),
        sa.Column("reference_method", sa.String(40), nullable=True),
        sa.Column("reference_value", sa.Float(), nullable=True),
        sa.Column("calibration_source_version", sa.String(80), nullable=True),
        sa.Column("calibration_transform_identity", sa.String(16), nullable=True),
        sa.Column("calibration_evidence", JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.CheckConstraint(
            "scene_type IN ('UNSPECIFIED','PLANT_OBJECT','GREENHOUSE_SCENE','FIELD_SCENE')",
            name="scene_type_valid",
        ),
        sa.CheckConstraint("conversion_profile IN ('balanced','eco','quality')",
                           name="conversion_profile_valid"),
        sa.CheckConstraint("collision_policy IN ('MANUAL_ONLY','AUTO_WHEN_CALIBRATED')",
                           name="collision_policy_valid"),
        sa.CheckConstraint("calibration_state IN ('UNVERIFIED','ASSUMED','VERIFIED')",
                           name="calibration_state_valid"),
        sa.CheckConstraint(
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
        sa.CheckConstraint(
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
    op.add_column("upload_sessions", sa.Column(
        "scene_type", sa.String(30), nullable=False, server_default="UNSPECIFIED"
    ))
    op.add_column("upload_sessions", sa.Column(
        "conversion_profile", sa.String(20), nullable=False, server_default="balanced"
    ))
    op.create_check_constraint(
        "scene_type_valid", "upload_sessions",
        "scene_type IN ('UNSPECIFIED','PLANT_OBJECT','GREENHOUSE_SCENE','FIELD_SCENE')",
    )
    op.create_check_constraint(
        "conversion_profile_valid", "upload_sessions",
        "conversion_profile IN ('balanced','eco','quality')",
    )


def downgrade() -> None:
    op.drop_constraint("conversion_profile_valid", "upload_sessions", type_="check")
    op.drop_constraint("scene_type_valid", "upload_sessions", type_="check")
    op.drop_column("upload_sessions", "conversion_profile")
    op.drop_column("upload_sessions", "scene_type")
    op.drop_table("scene_processing_settings")
