"""Allow calibrated centimeter meshes without relabeling historical meter geometry."""

from alembic import op

revision = "e6a701000006"
down_revision = "e6a701000005"
branch_labels = None
depends_on = None


def upgrade():
    op.drop_constraint(op.f("ck_mesh_models_units_valid"), "mesh_models", type_="check")
    op.create_check_constraint("units_valid", "mesh_models", "units IN ('cm','m','scene')")


def downgrade():
    op.execute(
        "DO $$ BEGIN IF EXISTS (SELECT 1 FROM mesh_models WHERE units='cm') "
        "THEN RAISE EXCEPTION 'Centimeter meshes exist; refusing relabeling'; END IF; END $$"
    )
    op.drop_constraint(op.f("ck_mesh_models_units_valid"), "mesh_models", type_="check")
    op.create_check_constraint("units_valid", "mesh_models", "units IN ('m','scene')")
