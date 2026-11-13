"""GS-RECON-01: durable inputs on the existing Job, including segmentation."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "e6a701000001"
down_revision = "d4f5a6b7c8d9"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("jobs", sa.Column("task_parameters", postgresql.JSONB(),
                                   nullable=False, server_default=sa.text("'{}'::jsonb")))


def downgrade():
    op.drop_column("jobs", "task_parameters")
