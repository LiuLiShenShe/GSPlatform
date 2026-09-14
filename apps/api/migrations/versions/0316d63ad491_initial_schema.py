"""initial schema

Revision ID: 0316d63ad491
Revises:
Create Date: 2026-09-14 13:29:31

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0316d63ad491"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ---- 1. Users (no FK dependencies) ----
    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("display_name", sa.String(120), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_users")),
    )
    op.create_index(op.f("ix_users_email"), "users", ["email"], unique=True)

    # ---- 2. Scenes (FK → users; current_version_id FK added later) ----
    op.create_table(
        "scenes",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("slug", sa.String(120), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("category", sa.String(40), nullable=False),
        sa.Column("visibility", sa.String(20), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("current_version_id", sa.Uuid(), nullable=True),
        sa.Column("splat_count", sa.BigInteger(), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("views", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
        sa.Column("likes", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "category IN ('urban','architecture','interior','nature','portrait','experiment')",
            name=op.f('ck_scenes_category_valid'),
        ),
        sa.CheckConstraint(
            "visibility IN ('PRIVATE','UNLISTED','PUBLIC')",
            name=op.f('ck_scenes_visibility_valid'),
        ),
        sa.CheckConstraint(
            "status IN ('DRAFT','VALIDATING','PROCESSING','READY','PUBLISHED','FAILED','ARCHIVED')",
            name=op.f('ck_scenes_status_valid'),
        ),
        sa.ForeignKeyConstraint(
            ["owner_id"], ["users.id"],
            name=op.f('fk_scenes_owner_id_users'),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_scenes")),
    )
    op.create_index(op.f("ix_scenes_slug"), "scenes", ["slug"], unique=True)
    op.create_index(
        op.f("ix_scenes_public_list"),
        "scenes",
        ["visibility", "status", "published_at", "id"],
    )
    op.create_index(
        op.f("ix_scenes_owner_status"),
        "scenes",
        ["owner_id", "status", "updated_at"],
    )

    # ---- 3. SceneVersions (FK → scenes — no cycle now that scenes exists) ----
    op.create_table(
        "scene_versions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("scene_id", sa.Uuid(), nullable=False),
        sa.Column("asset_version", sa.String(80), nullable=False),
        sa.Column("format", sa.String(20), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=True),
        sa.Column("manifest", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "format IN ('sog','ply','splat','streamed-sog')",
            name=op.f('ck_scene_versions_version_format_valid'),
        ),
        sa.CheckConstraint(
            "length(asset_version) BETWEEN 8 AND 80",
            name=op.f('ck_scene_versions_asset_version_length_valid'),
        ),
        sa.ForeignKeyConstraint(
            ["scene_id"], ["scenes.id"],
            name=op.f('fk_scene_versions_scene_id_scenes'),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_scene_versions")),
    )
    op.create_index(
        op.f("uq_scene_versions_scene_asset"),
        "scene_versions",
        ["scene_id", "asset_version"],
        unique=True,
    )

    # ---- 4. Add scenes.current_version_id FK to scene_versions ----
    op.create_foreign_key(
        op.f("fk_scenes_current_version_id_scene_versions"),
        "scenes",
        "scene_versions",
        ["current_version_id"],
        ["id"],
    )

    # ---- 5. Assets (FK → scenes, FK → scene_versions) ----
    op.create_table(
        "assets",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("scene_id", sa.Uuid(), nullable=False),
        sa.Column("version_id", sa.Uuid(), nullable=True),
        sa.Column("kind", sa.String(30), nullable=False),
        sa.Column("storage_key", sa.String(500), nullable=False),
        sa.Column("mime_type", sa.String(120), nullable=False),
        sa.Column("byte_size", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=True),
        sa.Column("metadata_", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["scene_id"], ["scenes.id"],
            name=op.f("fk_assets_scene_id_scenes"),
        ),
        sa.ForeignKeyConstraint(
            ["version_id"], ["scene_versions.id"],
            name=op.f("fk_assets_version_id_scene_versions"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_assets")),
    )
    op.create_index(op.f("ix_assets_scene_kind"), "assets", ["scene_id", "kind"])
    op.create_index(op.f("ix_assets_version"), "assets", ["version_id"])

    # ---- 6. Jobs (FK → scenes, FK → users) ----
    op.create_table(
        "jobs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("scene_id", sa.Uuid(), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(40), nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("progress", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
        sa.Column("stage", sa.String(120), nullable=True),
        sa.Column("error_code", sa.String(60), nullable=True),
        sa.Column("error_message_safe", sa.String(1000), nullable=True),
        sa.Column("attempt", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
        sa.Column("celery_task_id", sa.String(120), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "kind IN ('VALIDATE_UPLOAD','BUILD_STREAMED_SOG','RECONSTRUCT','PUBLISH','DELETE_ASSETS')",
            name=op.f("ck_jobs_kind_valid"),
        ),
        sa.CheckConstraint(
            "status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCEL_REQUESTED','CANCELLED')",
            name=op.f("ck_jobs_status_valid"),
        ),
        sa.CheckConstraint("progress BETWEEN 0 AND 100", name=op.f("ck_jobs_progress_range")),
        sa.CheckConstraint("attempt >= 0", name=op.f("ck_jobs_attempt_non_negative")),
        sa.ForeignKeyConstraint(
            ["scene_id"], ["scenes.id"],
            name=op.f("fk_jobs_scene_id_scenes"),
        ),
        sa.ForeignKeyConstraint(
            ["owner_id"], ["users.id"],
            name=op.f("fk_jobs_owner_id_users"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_jobs")),
    )
    op.create_index(op.f("ix_jobs_celery_task_id"), "jobs", ["celery_task_id"])
    op.create_index(
        op.f("ix_jobs_owner_status"), "jobs", ["owner_id", "status", "created_at"]
    )
    op.create_index(op.f("ix_jobs_scene_status"), "jobs", ["scene_id", "status"])

    # ---- 7. UploadSessions (FK → users) ----
    op.create_table(
        "upload_sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("storage_key", sa.String(500), nullable=False),
        sa.Column("mime_type", sa.String(120), nullable=False),
        sa.Column("offset", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
        sa.Column("total_size", sa.BigInteger(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "status IN ('INITIATED','UPLOADING','VALIDATING','READY','EXPIRED','CANCELLED')",
            name=op.f("ck_upload_sessions_status_valid"),
        ),
        sa.CheckConstraint('"offset" >= 0', name=op.f("ck_upload_sessions_offset_non_negative")),
        sa.CheckConstraint("total_size > 0", name=op.f("ck_upload_sessions_total_size_positive")),
        sa.CheckConstraint('"offset" <= total_size', name=op.f("ck_upload_sessions_offset_within_total")),
        sa.ForeignKeyConstraint(
            ["owner_id"], ["users.id"],
            name=op.f("fk_upload_sessions_owner_id_users"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_upload_sessions")),
    )
    op.create_index(
        op.f("ix_upload_sessions_owner"), "upload_sessions", ["owner_id", "created_at"]
    )


def downgrade() -> None:
    op.drop_table("upload_sessions")
    op.drop_table("jobs")
    op.drop_table("assets")
    # scenes.current_version_id FK references scene_versions — must be dropped first.
    op.drop_constraint(
        op.f("fk_scenes_current_version_id_scene_versions"),
        "scenes",
        type_="foreignkey",
    )
    op.drop_table("scene_versions")
    op.drop_table("scenes")
    op.drop_table("users")
