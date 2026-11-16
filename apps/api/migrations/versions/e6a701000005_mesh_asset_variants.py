"""Derived standard GLB assets, original MeshModel and PLY unchanged."""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from alembic import op

revision = "e6a701000005"
down_revision = "e6a701000004"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "mesh_asset_variants",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("mesh_model_id", sa.Uuid(), sa.ForeignKey("mesh_models.id"), nullable=False),
        sa.Column("recipe_key", sa.String(64), nullable=False, unique=True),
        sa.Column("source_ply_sha256", sa.String(64), nullable=False),
        sa.Column("format", sa.String(10), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("rotation", postgresql.JSONB(), nullable=False),
        sa.Column("orientation_evidence", postgresql.JSONB(), nullable=False),
        sa.Column("converter_version", sa.String(100), nullable=False),
        sa.Column("transform_version", sa.String(100), nullable=False),
        sa.Column("storage_key", sa.String(700), unique=True),
        sa.Column("sha256", sa.String(64)),
        sa.Column("size_bytes", sa.BigInteger()),
        sa.Column("result", postgresql.JSONB()),
        sa.Column("error_code", sa.String(50)),
        sa.Column("generation", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True)),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint("status IN ('QUEUED','RUNNING','READY','FAILED')", name="status_valid"),
        sa.CheckConstraint("format = 'glb'", name="format_valid"),
    )
    # Include the model identity: equal bytes in two private assets are separate derivations.
    op.create_index(
        "ix_mesh_asset_variants_mesh_model_id", "mesh_asset_variants", ["mesh_model_id"]
    )


def downgrade():
    op.execute(
        "DO $$ BEGIN IF EXISTS (SELECT 1 FROM mesh_asset_variants) THEN RAISE EXCEPTION 'Assets exist'; END IF; END $$"
    )
    op.drop_table("mesh_asset_variants")
