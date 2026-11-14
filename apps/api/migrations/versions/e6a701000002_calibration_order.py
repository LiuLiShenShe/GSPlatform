"""Persist the one-way calibration admission gate independently of scale settings."""

from alembic import op
import sqlalchemy as sa

revision = "e6a701000002"
down_revision = "e6a701000001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "scenes", sa.Column("calibration_locked_at", sa.DateTime(timezone=True), nullable=True)
    )
    # Preserve locks on legacy authored scenes even after their settings are reset.
    op.execute("""UPDATE scenes s SET calibration_locked_at = CURRENT_TIMESTAMP
      WHERE EXISTS (SELECT 1 FROM scene_viewpoints v WHERE v.scene_id=s.id)
         OR EXISTS (SELECT 1 FROM scene_annotations a WHERE a.scene_id=s.id)
         OR EXISTS (SELECT 1 FROM scene_edit_sessions e WHERE e.scene_id=s.id AND e.status='COMPLETED')
         OR EXISTS (SELECT 1 FROM scene_presentations p WHERE p.scene_id=s.id AND
          (p.initial_camera_position IS NOT NULL OR p.initial_camera_target IS NOT NULL
           OR p.initial_camera_fov IS NOT NULL OR p.world_position IS NOT NULL
           OR p.world_rotation IS NOT NULL OR p.world_scale IS NOT NULL
           OR p.cover_asset_id IS NOT NULL OR p.background_asset_id IS NOT NULL
           OR p.background_audio_asset_id IS NOT NULL OR p.background_color IS NOT NULL
           OR p.post_effects IS NOT NULL OR p.tonemapping <> 'aces' OR p.high_precision_rendering))""")


def downgrade():
    op.drop_column("scenes", "calibration_locked_at")
