"""fix-upload-01.3: execution fencing columns on jobs

Adds ``execution_generation`` (monotonic worker-execution attempt ordinal,
advanced only under the worker's FOR UPDATE claim transaction) and
``lease_expires_at`` (DB-clock deadline a live worker heartbeats forward).
``started_at`` keeps its existing "task began" meaning and is never renewed.

Existing rows: ``execution_generation`` defaults to 0 (no execution has ever
been claimed), ``lease_expires_at`` stays NULL (no lease yet).  A pre-existing
RUNNING row therefore has an *unknown* lease: the worker treats RUNNING +
``lease_expires_at IS NULL`` as BUSY (never double-run without proof of
expiry) unless ``started_at`` is also NULL (legacy directly-invoked build,
which adopts a fresh lease).  No existing status / attempt semantics change
for any JobKind (PUBLISH / RECONSTRUCT are untouched).

Deployment order: run this migration BEFORE starting workers of the new build.
Old workers ignore the two new columns (SELECT only lists known fields), so a
running old worker fleet is safe during upgrade; after the migration lands the
new worker code must be deployed (heartbeat + fencing) before any long build
is dispatched.  The API's ``_record_broker_failure`` guard is advisory-only and
does not depend on the columns, so the dispatch side can be upgraded either
order.

Revision ID: f6a7b8c9d0e1
Revises: c1d2e3f4a5b6
Create Date: 2026-10-09 12:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f6a7b8c9d0e1"
down_revision: Union[str, None] = "c1d2e3f4a5b6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "jobs",
        sa.Column(
            "execution_generation",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )
    op.add_column(
        "jobs",
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_check_constraint(
        "execution_generation_non_negative",
        "jobs",
        "execution_generation >= 0",
    )


def downgrade() -> None:
    op.drop_constraint("execution_generation_non_negative", "jobs", type_="check")
    op.drop_column("jobs", "lease_expires_at")
    op.drop_column("jobs", "execution_generation")
