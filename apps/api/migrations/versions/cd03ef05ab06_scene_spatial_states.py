"""Preserve spatial authoring while explicitly invalidating edited geometry bindings."""

from alembic import op
import sqlalchemy as sa

revision = "cd03ef05ab06"
down_revision = "bc03de04fa05"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "scene_spatial_states",
        sa.Column("scene_id", sa.Uuid(), nullable=False),
        sa.Column("source_version_id", sa.Uuid(), nullable=False),
        sa.Column("state", sa.String(20), nullable=False),
        sa.Column("stale_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("scene_id"),
        sa.ForeignKeyConstraint(["scene_id"], ["scenes.id"]),
        sa.ForeignKeyConstraint(["source_version_id"], ["scene_versions.id"]),
    )


def downgrade():
    op.drop_table("scene_spatial_states")
