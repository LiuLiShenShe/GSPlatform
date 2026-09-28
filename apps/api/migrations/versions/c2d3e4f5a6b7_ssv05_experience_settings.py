"""ssv05: experience settings v2 columns on scene_presentations

Adds tonemapping, high_precision_rendering (scalars) and post_effects (JSONB
structured document) to scene_presentations. These map to the official
SuperSplat ExperienceSettings v2. Post effects intentionally use ONE JSONB
column validated by a Pydantic schema, not one column per effect.

Revision ID: c2d3e4f5a6b7
Revises: a1b2c3d4e5f7
Create Date: 2026-09-28 18:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "c2d3e4f5a6b7"
down_revision: Union[str, None] = "a1b2c3d4e5f7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "scene_presentations",
        sa.Column("tonemapping", sa.String(length=20), nullable=False, server_default="aces"),
    )
    op.add_column(
        "scene_presentations",
        sa.Column("high_precision_rendering", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "scene_presentations",
        sa.Column("post_effects", postgresql.JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("scene_presentations", "post_effects")
    op.drop_column("scene_presentations", "high_precision_rendering")
    op.drop_column("scene_presentations", "tonemapping")
