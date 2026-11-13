"""Job service — ownership-enforced job reads."""

from __future__ import annotations

import uuid

from sqlalchemy.orm import Session

from app.core.errors import NotFoundError
from app.db.models.job import Job
from app.repositories.jobs import JobRepository
from app.schemas.job import JobOut


class JobService:
    """Job use cases. Only the job owner may read a job."""

    def __init__(self, session: Session) -> None:
        self._repo = JobRepository(session)
        self._session = session

    def get_owned(self, job_id: uuid.UUID, owner_id: uuid.UUID) -> JobOut:
        job = self._repo.get_owned(job_id, owner_id)
        if job is None:
            raise NotFoundError("任务不存在或无权访问")
        result = self._to_out(job)
        if job.kind == "RECONSTRUCT":
            result.segmentation = (job.task_parameters or {}).get("segmentation", {"mode": "OFF"})
            if job.status == "SUCCEEDED":
                from app.core.config import get_settings
                from app.db.models.scene import Scene, SceneVersion
                from app.services.scene_asset import SceneAssetAccessScope, SceneAssetService

                scene = self._session.get(Scene, job.scene_id)
                version_id = (job.task_parameters or {}).get("resultVersionId")
                version = (
                    self._session.get(SceneVersion, uuid.UUID(version_id)) if version_id else None
                )
                if (
                    scene
                    and version
                    and version.scene_id == scene.id
                    and scene.current_version_id == version.id
                    and scene.status == "PUBLISHED"
                ):
                    assets = SceneAssetService(get_settings())
                    content = (
                        (version.manifest or {}).get("content")
                        or (version.manifest or {}).get("stream")
                        or {}
                    )
                    assets.resolve(
                        scene, content["entryUrl"], access_scope=SceneAssetAccessScope.OWNER
                    )
                    result.result = {
                        "sceneSlug": scene.slug,
                        "versionId": str(version.id),
                        "assetVersion": version.asset_version,
                        "editUrl": (
                            f"/model/edit/{scene.slug}?workspace=calibration&version={version.id}"
                        ),
                        "viewUrl": f"/scene/{scene.slug}",
                    }
        return result

    @staticmethod
    def _to_out(job: Job) -> JobOut:
        return JobOut(
            id=str(job.id),
            sceneId=str(job.scene_id),
            kind=job.kind,
            status=job.status,
            progress=job.progress,
            stage=job.stage,
            errorCode=job.error_code,
            errorMessage=job.error_message_safe,
            createdAt=job.created_at,
            updatedAt=job.updated_at,
        )
