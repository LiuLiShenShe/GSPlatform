"""Fenced mesh job execution with real subprocess progress and cancellation."""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

from app.core.errors import ConflictError
from app.db.models.job import Job
from app.db.models.scene import Scene
from app.services.surface_mesh import SurfaceMeshService
from sqlalchemy import select

from workers.meshing.runtime import mesh_runtime
from workers.reconstruction.command_runner import CommandRunner

logger = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parents[2]
TERMINAL = ("SUCCEEDED", "FAILED", "CANCELLED")


def run_mesh_job(job_id, session_factory, settings):
    identifier = uuid.UUID(job_id)
    with session_factory() as db:
        job = db.scalar(select(Job).where(Job.id == identifier).with_for_update())
        if not job or job.kind != "BUILD_MESH" or job.status in TERMINAL:
            return
        now = datetime.now(UTC)
        if job.status == "CANCEL_REQUESTED":
            job.status, job.finished_at = "CANCELLED", now
            db.commit()
            return
        if (
            job.status == "RUNNING"
            and job.lease_expires_at
            and job.lease_expires_at > now
        ):
            return
        job.execution_generation += 1
        generation = job.execution_generation
        job.status, job.stage, job.started_at = "RUNNING", "PREPARING", now
        job.lease_expires_at = now + timedelta(seconds=120)
        parameters, scene_id = dict(job.task_parameters), job.scene_id
        db.commit()

    output = Path(settings.storage_root) / "meshes" / str(scene_id) / job_id
    attempt_output = output / f"generation-{generation}"
    attempt_output.mkdir(parents=True, exist_ok=True)
    heartbeat = 0.0

    def cancelled():
        nonlocal heartbeat
        with session_factory() as db:
            row = db.get(Job, identifier)
            scene = db.get(Scene, scene_id)
            if (
                not row
                or row.execution_generation != generation
                or row.status not in ("RUNNING",)
                or not scene
                or scene.deleted_at
                or str(scene.current_version_id) != parameters["sourceVersionId"]
            ):
                return True
            if time.monotonic() - heartbeat > 10:
                row = db.scalar(
                    select(Job).where(Job.id == identifier).with_for_update()
                )
                if row.execution_generation != generation or row.status != "RUNNING":
                    return True
                row.lease_expires_at = datetime.now(UTC) + timedelta(seconds=120)
                db.commit()
                heartbeat = time.monotonic()
        return False

    def progress(line):
        match = re.search(r"MESHPROGRESS ([A-Z_]+) (\d+)", line)
        if not match:
            return
        with session_factory() as db:
            row = db.scalar(select(Job).where(Job.id == identifier).with_for_update())
            if (
                row
                and row.execution_generation == generation
                and row.status == "RUNNING"
            ):
                row.stage = match[1]
                row.progress = max(row.progress, min(99, int(match[2])))
                db.commit()

    try:
        with session_factory() as db:
            scene = db.get(Scene, scene_id)
            if (
                not scene
                or scene.deleted_at
                or SurfaceMeshService(db, settings).source(scene) != parameters
            ):
                raise ConflictError("网格来源已变化")
        python, _ = mesh_runtime(parameters["algorithm"])
        source = (
            Path(settings.storage_root)
            / "jobs"
            / parameters["reconstructionJobId"]
            / f"attempt-{parameters['reconstructionAttempt']}"
        )
        runner = CommandRunner(
            cwd=attempt_output,
            env={"PYTHONPATH": f"{ROOT / 'apps/api'}:{ROOT}"},
            timeout=6600,
            is_cancelled=cancelled,
            on_progress=progress,
        )
        commands = []
        geometry_args = []
        if parameters.get("editedGeometry"):
            version_root = (
                Path(settings.storage_root) / "published" / str(scene_id) / "versions"
            ).resolve()
            entry = (
                version_root
                / parameters["sourceAssetVersion"]
                / parameters["geometryEntry"]
            ).resolve()
            if not entry.is_relative_to(version_root) or not entry.is_file():
                raise ConflictError("当前编辑几何文件不可用")
            geometry = attempt_output / "confirmed-geometry.ply"
            commands.append(
                [
                    sys.executable,
                    "-m",
                    "workers.meshing.confirmed_geometry",
                    "--input",
                    str(entry),
                    "--output",
                    str(geometry),
                    "--scale",
                    str(parameters["scaleFactor"]),
                ]
            )
            geometry_args = ["--gaussian-ply", str(geometry)]
        if parameters["algorithm"] == "gsplat":
            commands.append(
                [
                    sys.executable,
                    "-m",
                    "workers.meshing.render_gsplat",
                    "--source",
                    str(source),
                    "--output",
                    str(attempt_output / "observations.npz"),
                    *geometry_args,
                ]
            )
        commands.append(
            [
                str(python),
                "-m",
                "workers.meshing.extract",
                "--source",
                str(source),
                "--output",
                str(attempt_output),
                "--algorithm",
                parameters["algorithm"],
                *geometry_args,
                "--scale",
                str(parameters["scaleFactor"]),
                "--units",
                parameters.get("units", "m"),
            ]
        )
        for index, command in enumerate(commands):
            result = runner.run(command)
            (attempt_output / f"process-{index}.log").write_text(result.output)
            if not result.ok:
                if result.cancelled:
                    raise InterruptedError("Mesh generation cancelled")
                logger.error("Mesh subprocess failed: %s", result.output[-4000:])
                raise RuntimeError(
                    "GPU_OUT_OF_MEMORY"
                    if "out of memory" in result.output.lower()
                    else "MESH_EXTRACTION_FAILED"
                )
        metadata = json.loads((attempt_output / "result.json").read_text())
        with session_factory() as db:
            db.execute(select(Scene.id).where(Scene.id == scene_id).with_for_update())
            scene = db.get(Scene, scene_id)
            row = db.scalar(select(Job).where(Job.id == identifier).with_for_update())
            if row.execution_generation != generation:
                return
            if row.status != "RUNNING":
                raise InterruptedError("Mesh generation cancelled")
            if (
                not scene
                or scene.deleted_at
                or SurfaceMeshService(db, settings).source(scene) != parameters
            ):
                raise ConflictError("网格来源已变化")
            # Only the fenced execution may make its complete output downloadable.
            os.replace(attempt_output / "mesh.ply", output / "mesh.ply")
            os.replace(attempt_output / "result.json", output / "result.json")
            from app.services.mesh_models import register_mesh

            register_mesh(db, settings, scene, row, metadata)
            row.task_parameters = {**parameters, "result": metadata}
            row.status, row.stage, row.progress = "SUCCEEDED", "SUCCEEDED", 100
            row.finished_at, row.lease_expires_at = datetime.now(UTC), None
            db.commit()
    except Exception as exc:
        logger.exception("Mesh job %s failed", job_id)
        with session_factory() as db:
            row = db.scalar(select(Job).where(Job.id == identifier).with_for_update())
            if (
                not row
                or row.execution_generation != generation
                or row.status in TERMINAL
            ):
                return
            scene = db.get(Scene, scene_id)
            stale = (
                not scene
                or scene.deleted_at
                or str(scene.current_version_id) != parameters["sourceVersionId"]
            )
            row.status = (
                "CANCELLED"
                if isinstance(exc, InterruptedError) and not stale
                else "FAILED"
            )
            row.error_code = (
                "MESH_SOURCE_CHANGED"
                if stale or isinstance(exc, ConflictError)
                else (
                    "GPU_OUT_OF_MEMORY"
                    if str(exc) == "GPU_OUT_OF_MEMORY"
                    else "MESH_EXTRACTION_FAILED"
                )
            )
            row.error_message_safe = (
                "高斯几何版本已变化，请重新检查网格来源。"
                if stale
                else "显存不足，网格生成未完成；高斯模型仍可使用。"
                if row.error_code == "GPU_OUT_OF_MEMORY"
                else "网格生成已取消。"
                if row.status == "CANCELLED"
                else "网格提取失败，请检查重建质量或稍后重试；高斯模型仍可使用。"
            )
            row.finished_at, row.lease_expires_at = datetime.now(UTC), None
            db.commit()
