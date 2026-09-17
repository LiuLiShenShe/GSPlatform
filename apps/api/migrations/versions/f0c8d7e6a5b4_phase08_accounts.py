"""phase08: accounts, sessions, favorites, shares, audit

Revision ID: f0c8d7e6a5b4
Revises: a1b2c3d4e5f6
Create Date: 2026-09-17 18:00:00

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f0c8d7e6a5b4"
down_revision: str | None = "a1b2c3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ---- 1. users: add password_hash (nullable — existing/dev users have none) ----
    op.add_column(
        "users",
        sa.Column("password_hash", sa.String(200), nullable=True),
    )

    # ---- 2. sessions ----
    op.create_table(
        "sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("csrf_token_hash", sa.String(64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_sessions_user_id_users")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_sessions")),
    )
    op.create_index(op.f("ix_sessions_token_hash"), "sessions", ["token_hash"], unique=True)
    op.create_index(op.f("ix_sessions_user_id"), "sessions", ["user_id"], unique=False)
    op.create_index(op.f("ix_sessions_user_created"), "sessions", ["user_id", "created_at"], unique=False)

    # ---- 3. favorites ----
    op.create_table(
        "favorites",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("scene_id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["scene_id"], ["scenes.id"], name=op.f("fk_favorites_scene_id_scenes")),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_favorites_user_id_users")),
        sa.PrimaryKeyConstraint("user_id", "scene_id", name=op.f("pk_favorites")),
    )

    # ---- 4. share_links ----
    op.create_table(
        "share_links",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("scene_id", sa.Uuid(), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], name=op.f("fk_share_links_owner_id_users")),
        sa.ForeignKeyConstraint(["scene_id"], ["scenes.id"], name=op.f("fk_share_links_scene_id_scenes")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_share_links")),
    )
    op.create_index(op.f("ix_share_links_token_hash"), "share_links", ["token_hash"], unique=True)
    op.create_index(op.f("ix_share_links_scene_id"), "share_links", ["scene_id"], unique=False)
    op.create_index(op.f("ix_share_links_scene_created"), "share_links", ["scene_id", "created_at"], unique=False)

    # ---- 5. audit_events ----
    op.create_table(
        "audit_events",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("ip_address", sa.String(64), nullable=True),
        sa.Column("detail", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_audit_events_user_id_users")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_audit_events")),
    )
    op.create_index(op.f("ix_audit_events_action"), "audit_events", ["action"], unique=False)
    op.create_index(op.f("ix_audit_events_user_id"), "audit_events", ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_audit_events_user_id"), table_name="audit_events")
    op.drop_index(op.f("ix_audit_events_action"), table_name="audit_events")
    op.drop_table("audit_events")

    op.drop_index(op.f("ix_share_links_scene_created"), table_name="share_links")
    op.drop_index(op.f("ix_share_links_scene_id"), table_name="share_links")
    op.drop_index(op.f("ix_share_links_token_hash"), table_name="share_links")
    op.drop_table("share_links")

    op.drop_table("favorites")

    op.drop_index(op.f("ix_sessions_user_created"), table_name="sessions")
    op.drop_index(op.f("ix_sessions_user_id"), table_name="sessions")
    op.drop_index(op.f("ix_sessions_token_hash"), table_name="sessions")
    op.drop_table("sessions")

    op.drop_column("users", "password_hash")
