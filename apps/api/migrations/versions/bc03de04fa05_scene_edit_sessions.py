"""Add expiring version-pinned official Editor sessions without changing assets."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "bc03de04fa05"
down_revision = "ab02cd03ef04"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "scene_edit_sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("scene_id", sa.Uuid(), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("source_version_id", sa.Uuid(), nullable=False),
        sa.Column("source_asset_version", sa.String(80), nullable=False),
        sa.Column("source_kind", sa.String(30), nullable=False),
        sa.Column("source_entry", sa.String(500), nullable=False),
        sa.Column("selected_lod", sa.Integer(), nullable=True),
        sa.Column("source_counts", postgresql.JSONB(), nullable=False),
        sa.Column("editor_upstream_commit", sa.String(40), nullable=False),
        sa.Column("editor_build_identity", sa.String(64), nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("upload_id", sa.Uuid(), nullable=True),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column("result_version_id", sa.Uuid(), nullable=True),
        sa.Column("result_sha256", sa.String(64), nullable=True),
        sa.Column("error_code", sa.String(60), nullable=True),
        sa.Column("provenance", postgresql.JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("opened_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["scene_id"], ["scenes.id"]),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["source_version_id"], ["scene_versions.id"]),
        sa.ForeignKeyConstraint(["upload_id"], ["upload_sessions.id"]),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"]),
        sa.ForeignKeyConstraint(["result_version_id"], ["scene_versions.id"]),
        sa.UniqueConstraint("upload_id"),
        sa.CheckConstraint("status IN ('CREATED','OPENED','UPLOADING','UPLOADED','QUEUED','VALIDATING','CONVERTING','VERIFYING','PUBLISHING','COMPLETED','FAILED','CANCELLED','EXPIRED')", name="status_valid"),
        sa.CheckConstraint("source_kind IN ('FULL_RESOLUTION_SOURCE','SELECTED_STREAMED_LOD')", name="source_kind_valid"),
        sa.CheckConstraint("expires_at > created_at", name="expiry_valid"),
        sa.CheckConstraint("selected_lod IS NULL OR selected_lod >= 0", name="lod_valid"),
    )
    op.create_index("ix_scene_edit_sessions_owner_scene", "scene_edit_sessions", ["owner_id", "scene_id", "created_at"])


def downgrade():
    op.drop_index("ix_scene_edit_sessions_owner_scene", table_name="scene_edit_sessions")
    op.drop_table("scene_edit_sessions")
