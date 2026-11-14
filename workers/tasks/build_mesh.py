"""Surface mesh work shares the serialized GPU reconstruction queue."""

from app.core.config import settings
from app.db.session import SessionLocal

from workers.celery_app import celery_app
from workers.meshing.job import run_mesh_job


@celery_app.task(name="tasks.build_mesh")
def build_mesh(job_id):
    run_mesh_job(job_id, SessionLocal, settings)
