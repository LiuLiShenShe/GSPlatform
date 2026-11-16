"""Register pre-library successful mesh jobs without changing scenes or versions.

Run with the existing deployment environment and PYTHONPATH=apps/api:.
Prints a plan by default; --apply commits verified completed artifacts.
"""

import argparse
import json
from pathlib import Path

from app.core.config import settings
from app.db.models.job import Job
from app.db.models.mesh_model import MeshModel
from app.db.models.scene import Scene
from app.db.session import SessionLocal
from app.services.mesh_models import register_mesh
from sqlalchemy import select


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    result = []
    with SessionLocal() as db:
        for job in db.scalars(
            select(Job).where(Job.kind == "BUILD_MESH", Job.status == "SUCCEEDED")
        ).unique():
            if db.scalar(select(MeshModel.id).where(MeshModel.job_id == job.id)):
                continue
            scene = db.get(Scene, job.scene_id)
            if not scene or scene.owner_id != job.owner_id:
                raise ValueError(f"Mesh job {job.id} ownership mismatch")
            path = (
                Path(settings.storage_root)
                / "meshes"
                / str(scene.id)
                / str(job.id)
                / "mesh.ply"
            )
            metadata = job.task_parameters.get("result")
            if not path.is_file() or not metadata or not metadata.get("sha256"):
                raise ValueError(
                    f"Mesh job {job.id} has no verifiable completed artifact"
                )
            # Registration checks the original stored checksum before any commit.
            row = register_mesh(db, settings, scene, job, metadata)
            result.append(
                {"jobId": str(job.id), "modelId": str(row.id), "sha256": row.sha256}
            )
        if args.apply:
            db.commit()
        else:
            db.rollback()
    print(json.dumps({"applied": args.apply, "models": result}, indent=2))


if __name__ == "__main__":
    main()
