"""phase12: collision assets and walkable collision proxy

Revision ID: a1b2c3d4e5f7
Revises: 1f37b01d244b
Create Date: 2026-09-20 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f7'
down_revision: Union[str, None] = '1f37b01d244b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # collision_assets table
    op.create_table('collision_assets',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('scene_id', sa.Uuid(), nullable=False),
    sa.Column('mode', sa.String(length=20), nullable=False),
    sa.Column('asset_id', sa.Uuid(), nullable=True),
    sa.Column('job_id', sa.Uuid(), nullable=True),
    sa.Column('status', sa.String(length=30), nullable=False),
    sa.Column('gravity', sa.Float(), nullable=False),
    sa.Column('slope_limit_degrees', sa.Float(), nullable=False),
    sa.Column('step_offset', sa.Float(), nullable=False),
    sa.Column('player_height', sa.Float(), nullable=False),
    sa.Column('build_params', sa.JSON(), nullable=True),
    sa.Column('error_message', sa.String(length=1000), nullable=True),
    sa.Column('attempt', sa.Float(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['asset_id'], ['assets.id'], name=op.f('fk_collision_assets_asset_id_assets'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], name=op.f('fk_collision_assets_job_id_jobs'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['scene_id'], ['scenes.id'], name=op.f('fk_collision_assets_scene_id_scenes'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_collision_assets'))
    )
    op.create_index('ix_collision_assets_scene_id', 'collision_assets', ['scene_id'], unique=False)

    # collision columns on scene_presentations
    op.add_column('scene_presentations', sa.Column('collision_mode', sa.String(length=20), nullable=True))
    op.add_column('scene_presentations', sa.Column('collision_asset_id', sa.Uuid(), nullable=True))
    op.add_column('scene_presentations', sa.Column('collision_gravity', sa.Float(), nullable=False))
    op.add_column('scene_presentations', sa.Column('collision_slope_limit_degrees', sa.Float(), nullable=False))
    op.add_column('scene_presentations', sa.Column('collision_step_offset', sa.Float(), nullable=False))
    op.add_column('scene_presentations', sa.Column('collision_player_height', sa.Float(), nullable=False))
    op.add_column('scene_presentations', sa.Column('collision_enabled', sa.Boolean(), nullable=False))
    op.create_foreign_key(op.f('fk_scene_presentations_collision_asset_id_assets'), 'scene_presentations', 'assets', ['collision_asset_id'], ['id'], ondelete='SET NULL')


def downgrade() -> None:
    op.drop_constraint(op.f('fk_scene_presentations_collision_asset_id_assets'), 'scene_presentations', type_='foreignkey')
    op.drop_column('scene_presentations', 'collision_enabled')
    op.drop_column('scene_presentations', 'collision_player_height')
    op.drop_column('scene_presentations', 'collision_step_offset')
    op.drop_column('scene_presentations', 'collision_slope_limit_degrees')
    op.drop_column('scene_presentations', 'collision_gravity')
    op.drop_column('scene_presentations', 'collision_asset_id')
    op.drop_column('scene_presentations', 'collision_mode')
    op.drop_index('ix_collision_assets_scene_id', table_name='collision_assets')
    op.drop_table('collision_assets')
