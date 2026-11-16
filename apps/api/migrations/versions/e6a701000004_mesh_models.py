"""Durable library of completed mesh artifacts."""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "e6a701000004"
down_revision = "e6a701000003"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "mesh_models",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("owner_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("scene_id", sa.Uuid(), sa.ForeignKey("scenes.id"), nullable=False),
        sa.Column(
            "source_version_id", sa.Uuid(), sa.ForeignKey("scene_versions.id"), nullable=False
        ),
        sa.Column("job_id", sa.Uuid(), sa.ForeignKey("jobs.id"), unique=True),
        sa.Column("title", sa.String(240), nullable=False),
        sa.Column("algorithm", sa.String(20), nullable=False),
        sa.Column("units", sa.String(10), nullable=False),
        sa.Column("vertices", sa.BigInteger(), nullable=False),
        sa.Column("faces", sa.BigInteger(), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("storage_key", sa.String(600), nullable=False, unique=True),
        sa.Column("provenance", postgresql.JSONB(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("algorithm IN ('nksr','2dgs-tsdf')", name="algorithm_valid"),
        sa.CheckConstraint("units IN ('m','scene')", name="units_valid"),
        sa.CheckConstraint("vertices > 0 AND faces > 0 AND size_bytes > 0", name="geometry_valid"),
    )
    op.create_index("ix_mesh_models_owner_created", "mesh_models", ["owner_id", "created_at", "id"])


def downgrade():
    op.execute(
        "DO $$ BEGIN IF EXISTS (SELECT 1 FROM mesh_models) THEN RAISE EXCEPTION 'Mesh models exist; refusing lossy downgrade'; END IF; END $$"
    )
    op.drop_table("mesh_models")
