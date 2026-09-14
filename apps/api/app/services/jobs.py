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

    def get_owned(self, job_id: uuid.UUID, owner_id: uuid.UUID) -> JobOut:
        job = self._repo.get_owned(job_id, owner_id)
        if job is None:
            raise NotFoundError("任务不存在或无权访问")
        return self._to_out(job)

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
