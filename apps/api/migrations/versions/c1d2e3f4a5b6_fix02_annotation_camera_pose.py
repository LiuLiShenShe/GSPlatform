"""fix02: per-annotation camera pose (camera_position / camera_target / camera_fov)

FIX-02 §12-§14 — every SceneAnnotation gets its OWN camera pose captured at
authoring time (the viewer camera when the author clicked the 3D anchor), so
the runtime restores that annotation's camera instead of sharing the scene
initial camera. Nullable: legacy annotations with no authored camera read as
NULL and the runtime falls back to the scene initial camera (never a shared
[0,0,0] guess).

Revision ID: c1d2e3f4a5b6
Revises: d3e4f5a6b7c8
Create Date: 2026-09-29 00:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c1d2e3f4a5b6"
down_revision: Union[str, None] = "d3e4f5a6b7c8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = (
    "camera_position_x",
    "camera_position_y",
    "camera_position_z",
    "camera_target_x",
    "camera_target_y",
    "camera_target_z",
    "camera_fov",
)


def upgrade() -> None:
    for name in _COLUMNS:
        op.add_column("scene_annotations", sa.Column(name, sa.Float(), nullable=True))


def downgrade() -> None:
    for name in _COLUMNS:
        op.drop_column("scene_annotations", name)
