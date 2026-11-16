"""Version-pinned, owner-only meshing of calibrated reconstruction results."""

from __future__ import annotations

import math
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.errors import ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError
from app.core.identity import RequestIdentity
from app.db.models.job import Job
from app.db.models.scene import Scene
from app.db.models.scene_edit_session import SceneEditSession
from app.db.models.scene_processing import SceneProcessingSettings
from app.schemas.surface_mesh import CreateSurfaceMeshRequest, SurfaceMeshOut
from app.services.jobs import JobService
from app.services.scene_access import SceneAccessPolicy

ACTIVE = ("QUEUED", "RUNNING", "CANCEL_REQUESTED")


class SurfaceMeshService:
    def __init__(self, db: Session, settings: Settings) -> None:
        self.db, self.settings = db, settings

    def owner_scene(self, slug: str, identity: RequestIdentity, *, lock: bool = False) -> Scene:
        scene = SceneAccessPolicy(self.db).find_scene(slug)
        if scene is None or scene.deleted_at:
            raise NotFoundError("场景不存在")
        if scene.owner_id != identity.user_id:
            raise ForbiddenError("仅作品拥有者可生成和下载网格")
        if lock:
            self.db.execute(select(Scene.id).where(Scene.id == scene.id).with_for_update())
            self.db.refresh(scene)
            if scene.deleted_at:
                raise NotFoundError("场景不存在")
        return scene

    def source(self, scene: Scene) -> dict[str, Any]:
        """Trace saved edits back to the metric version and its camera reconstruction."""
        row = self.db.get(SceneProcessingSettings, scene.id)
        evidence = (row.calibration_evidence or {}) if row else {}
        if not evidence.get("geometryScaleAppliedBy"):
            raise ConflictError("请先完成尺度标定，再生成具有真实尺度的网格。")
        metric_version = evidence.get("resultVersionId")
        cursor = scene.current_version_id
        visited = set()
        while str(cursor) != metric_version:
            if cursor is None or cursor in visited or len(visited) >= 256:
                raise ConflictError(
                    "当前版本无法追溯到已标定的重建，请使用该作品已保存的清理版本。"
                )
            visited.add(cursor)
            edit = self.db.scalar(
                select(SceneEditSession)
                .where(
                    SceneEditSession.scene_id == scene.id,
                    SceneEditSession.owner_id == scene.owner_id,
                    SceneEditSession.status == "COMPLETED",
                    SceneEditSession.result_version_id == cursor,
                    SceneEditSession.source_version_id != cursor,
                )
                .order_by(SceneEditSession.completed_at.desc())
                .limit(1)
            )
            if edit is None:
                raise ConflictError("当前高斯几何已变化，且缺少已保存的编辑来源；不能借用旧网格。")
            cursor = edit.source_version_id
        source_id = evidence.get("sourceVersionId")
        job = self.db.scalar(
            select(Job)
            .where(
                Job.scene_id == scene.id,
                Job.owner_id == scene.owner_id,
                Job.kind == "RECONSTRUCT",
                Job.status == "SUCCEEDED",
                Job.task_parameters["resultVersionId"].astext == source_id,
            )
            .order_by(Job.created_at.desc())
            .limit(1)
        )
        if job is None:
            raise ConflictError(
                "此作品缺少原始重建资料。请从照片重建结果生成网格；导入的高斯暂不支持此入口。"
            )
        factor = float(evidence.get("scaleFactor", 0))
        if not math.isfinite(factor) or factor <= 0:
            raise ConflictError("尺度标定证据缺少有效倍率")
        algorithm = (job.task_parameters or {}).get("algorithm", "gsplat")
        if algorithm not in ("gsplat", "2dgs"):
            raise ConflictError("原重建算法不受支持")
        directory = (
            Path(self.settings.storage_root) / "jobs" / str(job.id) / f"attempt-{job.attempt}"
        )
        if not (directory / "gsplat/final.ply").is_file():
            raise ConflictError("原始训练资料已不可用，请重新上传照片重建。")
        source = {
            "sourceVersionId": str(scene.current_version_id),
            "reconstructionJobId": str(job.id),
            "reconstructionAttempt": job.attempt,
            "algorithm": algorithm,
            "scaleFactor": factor,
            "mesherVersion": 1,
        }
        if visited:
            from app.db.models.scene import SceneVersion

            version = self.db.get(SceneVersion, scene.current_version_id)
            if not version or version.format not in ("sog", "ply", "streamed-sog"):
                raise ConflictError("当前清理版本没有可读取的高斯几何")
            entry = (
                "scene.ply"
                if version.format == "ply"
                else "scene.sog"
                if version.format == "sog"
                else "lod-meta.json"
            )
            source.update(
                editedGeometry=True,
                sourceAssetVersion=version.asset_version,
                geometryEntry=entry,
                geometryFormat=version.format,
                mesherVersion=2,
            )
        pending = self.db.scalar(
            select(SceneEditSession.id)
            .where(
                SceneEditSession.scene_id == scene.id,
                SceneEditSession.owner_id == scene.owner_id,
                SceneEditSession.status.in_(
                    [
                        "UPLOADING",
                        "UPLOADED",
                        "QUEUED",
                        "VALIDATING",
                        "CONVERTING",
                        "VERIFYING",
                        "PUBLISHING",
                    ]
                ),
            )
            .limit(1)
        )
        if pending:
            raise ConflictError("高斯编辑结果正在上传或发布，请保存完成后再确认生成 Mesh。")
        return source

    def status(self, slug: str, identity: RequestIdentity) -> SurfaceMeshOut:
        scene = self.owner_scene(slug, identity)
        output = SurfaceMeshOut(currentVersionId=scene.current_version_id, available=False)
        try:
            source = self.source(scene)
            output.algorithm = "2dgs-tsdf" if source["algorithm"] == "2dgs" else "nksr"
            from workers.meshing.runtime import mesh_runtime

            mesh_runtime(source["algorithm"])
            output.available = True
        except (ConflictError, ValueError) as exc:
            output.reason = str(exc)
        job = self.db.scalar(
            select(Job)
            .where(
                Job.scene_id == scene.id,
                Job.kind == "BUILD_MESH",
                Job.task_parameters["sourceVersionId"].astext == str(scene.current_version_id),
            )
            .order_by(Job.created_at.desc())
            .limit(1)
        )
        if job:
            output.job = JobService._to_out(job)
            if job.status == "SUCCEEDED" and output.available:
                result = (job.task_parameters or {}).get("result", {})
                output.job.result = {
                    **result,
                    "downloadUrl": f"/api/v1/scenes/{scene.slug}/mesh/{job.id}/download",
                }
                from app.db.models.mesh_model import MeshModel

                model = self.db.scalar(select(MeshModel).where(MeshModel.job_id == job.id))
                if model:
                    output.job.result.update(
                        meshModelId=str(model.id), previewUrl=f"/meshes/{model.id}"
                    )
        return output

    def submit(
        self,
        slug: str,
        body: CreateSurfaceMeshRequest,
        identity: RequestIdentity,
        send_task: Callable[..., object],
    ) -> SurfaceMeshOut:
        scene = self.owner_scene(slug, identity, lock=True)
        if scene.current_version_id != body.expectedCurrentVersion:
            raise ConflictError("当前版本已变化，请刷新后重试")
        parameters = self.source(scene)
        from workers.meshing.runtime import mesh_runtime

        try:
            mesh_runtime(parameters["algorithm"])
        except ValueError as exc:
            raise ServiceUnavailableError(str(exc)) from exc
        existing = self.db.scalar(
            select(Job)
            .where(
                Job.scene_id == scene.id,
                Job.kind == "BUILD_MESH",
                Job.status.in_([*ACTIVE, "SUCCEEDED"]),
                Job.task_parameters["sourceVersionId"].astext == str(scene.current_version_id),
            )
            .order_by(Job.created_at.desc())
            .limit(1)
        )
        if existing is None:
            job = Job(
                scene_id=scene.id,
                owner_id=scene.owner_id,
                kind="BUILD_MESH",
                status="QUEUED",
                progress=0,
                task_parameters=parameters,
            )
            self.db.add(job)
            self.db.commit()
            try:
                send_task("tasks.build_mesh", args=[str(job.id)])
            except Exception as exc:
                job.status, job.error_code = "FAILED", "TASK_DISPATCH_FAILED"
                job.error_message_safe = "网格任务暂不可用，请稍后重试"
                self.db.commit()
                raise ServiceUnavailableError(job.error_message_safe) from exc
        else:
            self.db.commit()
        return self.status(slug, identity)

    def owned_job(
        self, slug: str, job_id: uuid.UUID, identity: RequestIdentity
    ) -> tuple[Scene, Job]:
        scene = self.owner_scene(slug, identity)
        job = self.db.get(Job, job_id)
        if (
            not job
            or job.scene_id != scene.id
            or job.owner_id != identity.user_id
            or job.kind != "BUILD_MESH"
        ):
            raise NotFoundError("网格任务不存在")
        return scene, job

    def cancel(self, slug: str, job_id: uuid.UUID, identity: RequestIdentity) -> SurfaceMeshOut:
        _, job = self.owned_job(slug, job_id, identity)
        locked = self.db.scalar(select(Job).where(Job.id == job.id).with_for_update())
        if locked is None:
            raise NotFoundError("网格任务不存在")
        job = locked
        if job.status not in ACTIVE:
            raise ConflictError("任务已结束")
        if job.status == "QUEUED" or (
            job.lease_expires_at and job.lease_expires_at < datetime.now(UTC)
        ):
            job.status, job.finished_at = "CANCELLED", datetime.now(UTC)
        else:
            job.status = "CANCEL_REQUESTED"
        self.db.commit()
        return self.status(slug, identity)

    def download(self, slug: str, job_id: uuid.UUID, identity: RequestIdentity) -> Path:
        scene, job = self.owned_job(slug, job_id, identity)
        self.source(scene)  # Deleted/stale geometry must not expose an old mesh.
        if job.status != "SUCCEEDED" or job.task_parameters.get("sourceVersionId") != str(
            scene.current_version_id
        ):
            raise ConflictError("网格尚未完成或对应的几何版本已变化")
        root = Path(self.settings.storage_root).resolve() / "meshes"
        path = root / str(scene.id) / str(job.id) / "mesh.ply"
        if not path.resolve().is_relative_to(root) or not path.is_file():
            raise NotFoundError("网格文件不可用")
        return path
