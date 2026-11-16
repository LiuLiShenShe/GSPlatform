"""CPU subprocess and leased/generation-fenced atomic GLB publication."""

import json
import logging
import os
import sys
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

from app.db.models.mesh_asset_variant import MeshAssetVariant
from app.db.models.mesh_model import MeshModel
from app.db.models.scene import Scene
from sqlalchemy import select

from workers.reconstruction.command_runner import CommandRunner

logger = logging.getLogger(__name__)


def run_asset_job(identifier, session_factory, settings):
    identifier = uuid.UUID(str(identifier))
    with session_factory() as db:
        row = db.scalar(
            select(MeshAssetVariant)
            .where(MeshAssetVariant.id == identifier)
            .with_for_update()
        )
        if not row or row.status in ("READY", "FAILED"):
            return
        if (
            row.status == "RUNNING"
            and row.lease_expires_at
            and row.lease_expires_at > datetime.now(UTC)
        ):
            return
        model = db.get(MeshModel, row.mesh_model_id)
        scene = db.get(Scene, model.scene_id)
        if (
            scene.deleted_at
            or model.units != "m"
            or model.sha256 != row.source_ply_sha256
        ):
            row.status = "FAILED"
            row.error_code = "SOURCE_UNAVAILABLE"
            db.commit()
            return
        row.generation += 1
        generation = row.generation
        row.status = "RUNNING"
        row.lease_expires_at = datetime.now(UTC) + timedelta(seconds=120)
        model_id = model.id
        source = (Path(settings.storage_root) / model.storage_key).resolve()
        if (
            not source.is_relative_to(
                (Path(settings.storage_root) / "meshes").resolve()
            )
            or not source.is_file()
        ):
            row.status = "FAILED"
            row.error_code = "SOURCE_UNAVAILABLE"
            db.commit()
            return
        request = {
            "source": str(source),
            "rotation": row.rotation,
            "sha256": model.sha256,
            "vertices": model.vertices,
            "faces": model.faces,
        }
        db.commit()
    directory = (
        Path(settings.storage_root)
        / "mesh-assets"
        / str(model_id)
        / str(identifier)
        / f"generation-{generation}"
    )
    directory.mkdir(parents=True, exist_ok=True)
    request_file = directory / "request.json"
    request_file.write_text(json.dumps(request))
    heartbeat = 0.0

    def cancelled():
        nonlocal heartbeat
        with session_factory() as db:
            row = db.scalar(
                select(MeshAssetVariant)
                .where(MeshAssetVariant.id == identifier)
                .with_for_update()
            )
            model = db.get(MeshModel, model_id)
            scene = db.get(Scene, model.scene_id)
            if (
                row.generation != generation
                or row.status != "RUNNING"
                or scene.deleted_at
                or model.sha256 != request["sha256"]
                or model.units != "m"
            ):
                return True
            if time.monotonic() - heartbeat > 10:
                row.lease_expires_at = datetime.now(UTC) + timedelta(seconds=120)
                db.commit()
                heartbeat = time.monotonic()
        return False

    try:
        root = Path(__file__).resolve().parents[2]
        result = CommandRunner(
            cwd=directory,
            env={
                "PYTHONPATH": f"{root / 'apps/api'}:{root}",
                "CUDA_VISIBLE_DEVICES": "",
                "OMP_NUM_THREADS": "4",
                "OPENBLAS_NUM_THREADS": "4",
            },
            timeout=3600,
            is_cancelled=cancelled,
        ).run(
            [
                sys.executable,
                "-m",
                "workers.meshing.standard_asset",
                "--request",
                str(request_file),
                "--output",
                str(directory / "mesh.tmp.glb"),
            ]
        )
        (directory / "conversion.log").write_text(result.output)
        if not result.ok:
            raise ValueError("GLB conversion failed")
        metadata = json.loads((directory / "mesh.tmp.result.json").read_text())
        with session_factory() as db:
            row = db.scalar(
                select(MeshAssetVariant)
                .where(MeshAssetVariant.id == identifier)
                .with_for_update()
            )
            model = db.get(MeshModel, model_id)
            scene = db.get(Scene, model.scene_id)
            if row.generation != generation or row.status != "RUNNING":
                return
            if (
                scene.deleted_at
                or model.sha256 != request["sha256"]
                or model.units != "m"
            ):
                raise ValueError("Source changed")
            final = directory / "mesh.glb"
            # No successful result is overwritten: every execution has its own generation.
            if final.exists():
                raise ValueError("Immutable output exists")
            os.replace(directory / "mesh.tmp.glb", final)
            row.storage_key = str(final.relative_to(Path(settings.storage_root)))
            row.sha256 = metadata["sha256"]
            row.size_bytes = metadata["sizeBytes"]
            row.result = metadata
            row.status = "READY"
            row.finished_at = datetime.now(UTC)
            row.lease_expires_at = None
            db.commit()
    except Exception:
        logger.exception("GLB conversion %s failed", identifier)
        with session_factory() as db:
            row = db.scalar(
                select(MeshAssetVariant)
                .where(MeshAssetVariant.id == identifier)
                .with_for_update()
            )
            if row.generation == generation and row.status == "RUNNING":
                row.status = "FAILED"
                row.error_code = "CONVERSION_OR_VALIDATION_FAILED"
                row.lease_expires_at = None
                row.finished_at = datetime.now(UTC)
                db.commit()
