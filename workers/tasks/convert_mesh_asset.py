"""GLB conversion only uses the existing CPU queue."""

from app.core.config import settings
from app.db.session import SessionLocal
from workers.celery_app import celery_app
from workers.meshing.asset_job import run_asset_job


@celery_app.task(name="tasks.convert_mesh_asset", soft_time_limit=3900, time_limit=4000)
def convert_mesh_asset(variant_id):
    run_asset_job(variant_id, SessionLocal, settings)
