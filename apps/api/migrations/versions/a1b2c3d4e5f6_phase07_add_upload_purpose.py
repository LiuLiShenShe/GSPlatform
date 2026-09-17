"""phase07: add purpose column to upload_sessions for compute routing

Revision ID: a1b2c3d4e5f6
Revises: e5c2a9b0f6d1
Create Date: 2026-09-15

Purpose distinguishes PUBLISH (Phase 06 path) from RECONSTRUCT (Phase 07
3DGS pipeline). The default is 'PUBLISH' for backward compatibility so all
existing rows behave exactly as before.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a1b2c3d4e5f6"
down_revision: str | None = "e5c2a9b0f6d1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "upload_sessions",
        sa.Column(
            "purpose",
            sa.String(20),
            nullable=False,
            server_default="PUBLISH",
        ),
    )
    op.create_check_constraint(
        "purpose_valid",
        "upload_sessions",
        "purpose IN ('PUBLISH', 'RECONSTRUCT')",
    )


def downgrade() -> None:
    op.drop_constraint("purpose_valid", "upload_sessions", type_="check")
    op.drop_column("upload_sessions", "purpose")
