"""phase06: extend upload_sessions for scene metadata and publishing states

Revision ID: e5c2a9b0f6d1
Revises: 0316d63ad491
Create Date: 2026-09-15

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e5c2a9b0f6d1"
down_revision: str | None = "0316d63ad491"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1. New columns for scene declaration + publish association.
    op.add_column(
        "upload_sessions",
        sa.Column(
            "scene_id", sa.Uuid(), sa.ForeignKey("scenes.id", name=op.f("fk_upload_sessions_scene_id_scenes")), nullable=True
        ),
    )
    op.add_column(
        "upload_sessions",
        sa.Column("upload_format", sa.String(20), nullable=False, server_default="ply"),
    )
    op.add_column(
        "upload_sessions",
        sa.Column("declared_sha256", sa.String(64), nullable=True),
    )
    op.add_column(
        "upload_sessions",
        sa.Column("title", sa.String(200), nullable=False, server_default="Untitled"),
    )
    op.add_column(
        "upload_sessions",
        sa.Column("description", sa.Text(), nullable=True),
    )
    op.add_column(
        "upload_sessions",
        sa.Column("visibility", sa.String(20), nullable=False, server_default="PRIVATE"),
    )
    op.add_column(
        "upload_sessions",
        sa.Column("category", sa.String(40), nullable=False, server_default="experiment"),
    )
    op.create_index(
        op.f("ix_upload_sessions_scene_id"), "upload_sessions", ["scene_id"]
    )

    # 2. Widen the status CHECK constraint to the Phase 06 publishing state machine.
    op.drop_constraint("status_valid", "upload_sessions", type_="check")
    op.create_check_constraint(
        "status_valid",
        "upload_sessions",
        "status IN ('CREATED', 'UPLOADING', 'UPLOADED', 'QUEUED', 'VALIDATING', "
        "'CONVERTING', 'VERIFYING', 'PUBLISHING', 'SUCCEEDED', 'FAILED', "
        "'EXPIRED', 'CANCELLED')",
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_upload_sessions_scene_id"), table_name="upload_sessions")
    op.drop_constraint("status_valid", "upload_sessions", type_="check")
    op.create_check_constraint(
        "status_valid",
        "upload_sessions",
        "status IN ('INITIATED', 'UPLOADING', 'VALIDATING', 'READY', "
        "'EXPIRED', 'CANCELLED')",
    )
    op.drop_constraint(
        op.f("fk_upload_sessions_scene_id_scenes"), "upload_sessions", type_="foreignkey"
    )
    op.drop_column("upload_sessions", "category")
    op.drop_column("upload_sessions", "visibility")
    op.drop_column("upload_sessions", "description")
    op.drop_column("upload_sessions", "title")
    op.drop_column("upload_sessions", "declared_sha256")
    op.drop_column("upload_sessions", "upload_format")
    op.drop_column("upload_sessions", "scene_id")
