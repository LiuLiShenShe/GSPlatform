"""Allow version-pinned surface meshing jobs."""

from alembic import op

revision = "e6a701000003"
down_revision = "e6a701000002"
branch_labels = None
depends_on = None

KINDS = "'VALIDATE_UPLOAD', 'BUILD_STREAMED_SOG', 'RECONSTRUCT', 'PUBLISH', 'DELETE_ASSETS', 'BUILD_COLLISION'"


def upgrade():
    op.drop_constraint("ck_jobs_kind_valid", "jobs", type_="check")
    op.create_check_constraint("kind_valid", "jobs", f"kind IN ({KINDS}, 'BUILD_MESH')")


def downgrade():
    # Existing mesh jobs are durable user history; refuse a lossy downgrade.
    op.execute(
        "DO $$ BEGIN IF EXISTS (SELECT 1 FROM jobs WHERE kind='BUILD_MESH') THEN RAISE EXCEPTION 'BUILD_MESH jobs exist'; END IF; END $$"
    )
    op.drop_constraint("ck_jobs_kind_valid", "jobs", type_="check")
    op.create_check_constraint("kind_valid", "jobs", f"kind IN ({KINDS})")
