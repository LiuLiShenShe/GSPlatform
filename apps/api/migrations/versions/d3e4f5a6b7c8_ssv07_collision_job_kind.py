"""ssv07: allow BUILD_COLLISION in the jobs kind check constraint

The Phase 12 collision migration created ``collision_assets`` but never widened
``ck_jobs_kind_valid`` — the DB still rejected ``Job(kind='BUILD_COLLISION')``
even though the ORM enum and the Celery task both use it. The SSV-07 audit
(§1) found this: dispatching a collision build raised a CheckViolation.

This migration only widens the CHECK constraint; no new column.

Revision ID: d3e4f5a6b7c8
Revises: c2d3e4f5a6b7
Create Date: 2026-09-28 22:00:00.000000
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d3e4f5a6b7c8"
down_revision: Union[str, None] = "c2d3e4f5a6b7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_KIND_ALL = (
    "kind IN ('VALIDATE_UPLOAD','BUILD_STREAMED_SOG','RECONSTRUCT',"
    "'PUBLISH','DELETE_ASSETS','BUILD_COLLISION')"
)
_KIND_PRE_SSV07 = (
    "kind IN ('VALIDATE_UPLOAD','BUILD_STREAMED_SOG','RECONSTRUCT',"
    "'PUBLISH','DELETE_ASSETS')"
)


def upgrade() -> None:
    op.execute("ALTER TABLE jobs DROP CONSTRAINT IF EXISTS ck_jobs_kind_valid")
    op.create_check_constraint("ck_jobs_kind_valid", "jobs", _KIND_ALL)


def downgrade() -> None:
    op.execute("ALTER TABLE jobs DROP CONSTRAINT IF EXISTS ck_jobs_kind_valid")
    op.create_check_constraint("ck_jobs_kind_valid", "jobs", _KIND_PRE_SSV07)
