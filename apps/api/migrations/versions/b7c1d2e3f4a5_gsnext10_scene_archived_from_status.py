"""GS-NEXT-10: remember the pre-archive status so restore returns the scene to it.

`archive` accepts PUBLISHED/READY; restoring must not blanket-promote a READY
scene to the public catalogue. Add a nullable column that archive fills and
restore consumes (then clears).

"""

from alembic import op
import sqlalchemy as sa

revision = "b7c1d2e3f4a5"
down_revision = "cd03ef05ab06"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "scenes",
        sa.Column("archived_from_status", sa.String(20), nullable=True),
    )


def downgrade():
    op.drop_column("scenes", "archived_from_status")
