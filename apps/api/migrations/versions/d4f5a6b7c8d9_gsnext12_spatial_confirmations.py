"""GS-NEXT-12: per-feature version binding for re-authored spatial data.

GS-NEXT-11 invalidated the *whole* spatial authoring on every version switch
(``scene_spatial_states.state = 'STALE'``) and the runtime dropped initial
camera / world transform / viewpoints / annotations unconditionally.  Nothing
ever re-confirmed them, so a scene that had been rolled back could never serve
a freshly saved initial camera again — the "permanently STALE" P1.

These columns record, per authored feature, the :class:`SceneVersion` the data
was last written against.  The runtime then trusts a feature only when that
version is the scene's current version (or when the scene was never
invalidated at all).  Historical rows stay NULL = "unconfirmed legacy": they
are served only while the scene has no invalidation record, and stay disabled
afterwards until the owner re-saves them.

Deliberately **no data backfill**: NULL already has exactly the old semantics
(no spatial-state row → served; STALE row → dropped).  Collision and scale
calibration keep their own independent bindings (``build_params.sourceVersion``
/ ``calibration_source_version``) and are never re-enabled by these columns.
"""

from alembic import op
import sqlalchemy as sa

revision = "d4f5a6b7c8d9"
down_revision = "b7c1d2e3f4a5"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "scene_spatial_states",
        sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "scene_presentations",
        sa.Column("initial_camera_version_id", sa.Uuid(), nullable=True),
    )
    op.add_column(
        "scene_presentations",
        sa.Column("world_transform_version_id", sa.Uuid(), nullable=True),
    )
    op.add_column(
        "scene_viewpoints",
        sa.Column("source_version_id", sa.Uuid(), nullable=True),
    )
    op.add_column(
        "scene_annotations",
        sa.Column("source_version_id", sa.Uuid(), nullable=True),
    )
    op.create_foreign_key(
        "fk_scene_presentations_initial_cam_ver",
        "scene_presentations",
        "scene_versions",
        ["initial_camera_version_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_scene_presentations_world_xform_ver",
        "scene_presentations",
        "scene_versions",
        ["world_transform_version_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_scene_viewpoints_source_version_id_scene_versions",
        "scene_viewpoints",
        "scene_versions",
        ["source_version_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_scene_annotations_source_version_id_scene_versions",
        "scene_annotations",
        "scene_versions",
        ["source_version_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade():
    op.drop_constraint(
        "fk_scene_annotations_source_version_id_scene_versions",
        "scene_annotations",
        type_="foreignkey",
    )
    op.drop_constraint(
        "fk_scene_viewpoints_source_version_id_scene_versions",
        "scene_viewpoints",
        type_="foreignkey",
    )
    op.drop_constraint(
        "fk_scene_presentations_world_xform_ver",
        "scene_presentations",
        type_="foreignkey",
    )
    op.drop_constraint(
        "fk_scene_presentations_initial_cam_ver",
        "scene_presentations",
        type_="foreignkey",
    )
    op.drop_column("scene_annotations", "source_version_id")
    op.drop_column("scene_viewpoints", "source_version_id")
    op.drop_column("scene_presentations", "world_transform_version_id")
    op.drop_column("scene_presentations", "initial_camera_version_id")
    op.drop_column("scene_spatial_states", "revision")
