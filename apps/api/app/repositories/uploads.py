"""Upload session repository — data access for upload sessions and their Jobs."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import update
from sqlalchemy.orm import Session

from app.db.models.enums import JobKind, JobStatus, UploadSessionStatus
from app.db.models.job import Job
from app.db.models.upload_session import UploadSession


class UploadRepository:
    """Upload session data access. Business logic lives in the service layer."""

    def __init__(self, session: Session) -> None:
        self._session = session

    # ---- upload sessions ---------------------------------------------------
    def create(
        self,
        *,
        id: uuid.UUID,
        owner_id: uuid.UUID,
        storage_key: str,
        mime_type: str,
        upload_format: str,
        total_size: int,
        expires_at: datetime,
        status: UploadSessionStatus = UploadSessionStatus.CREATED,
        title: str,
        description: str | None,
        visibility: str,
        category: str,
        declared_sha256: str | None,
        purpose: str = "PUBLISH",
    ) -> UploadSession:
        us = UploadSession(
            id=id,
            owner_id=owner_id,
            status=status.value,
            storage_key=storage_key,
            mime_type=mime_type,
            upload_format=upload_format,
            total_size=total_size,
            expires_at=expires_at,
            title=title,
            description=description,
            visibility=visibility,
            category=category,
            declared_sha256=declared_sha256,
            purpose=purpose,
        )
        self._session.add(us)
        self._session.flush()
        return us

    def get_by_id(self, session_id: uuid.UUID) -> UploadSession | None:
        return (
            self._session.query(UploadSession)
            .filter(UploadSession.id == session_id)
            .first()
        )

    def get_owned(self, session_id: uuid.UUID, owner_id: uuid.UUID) -> UploadSession | None:
        return (
            self._session.query(UploadSession)
            .filter(
                UploadSession.id == session_id,
                UploadSession.owner_id == owner_id,
                UploadSession.status != UploadSessionStatus.EXPIRED.value,
                UploadSession.status != UploadSessionStatus.CANCELLED.value,
            )
            .first()
        )

    def count_active_for_user(self, owner_id: uuid.UUID) -> int:
        # Only *in-flight* sessions hold a concurrent-upload slot. Completed
        # sessions (UPLOADED/QUEUED/…) are referenced by later jobs and must
        # not block larger RECONSTRUCT photo sequences (uploaded one file at a
        # time through separate sessions).
        active_states = [
            UploadSessionStatus.CREATED.value,
            UploadSessionStatus.UPLOADING.value,
        ]
        return (
            self._session.query(UploadSession)
            .filter(
                UploadSession.owner_id == owner_id,
                UploadSession.status.in_(active_states),
            )
            .count()
        )

    def update_status(self, session_id: uuid.UUID, status: UploadSessionStatus) -> None:
        stmt = (
            update(UploadSession)
            .where(UploadSession.id == session_id)
            .values(status=status.value)
        )
        self._session.execute(stmt)
        self._session.flush()

    def update_scene_id(self, session_id: uuid.UUID, scene_id: uuid.UUID) -> None:
        stmt = (
            update(UploadSession)
            .where(UploadSession.id == session_id)
            .values(scene_id=scene_id)
        )
        self._session.execute(stmt)
        self._session.flush()

    def update_offset(self, session_id: uuid.UUID, offset: int) -> None:
        stmt = (
            update(UploadSession)
            .where(UploadSession.id == session_id)
            .values(offset=offset)
        )
        self._session.execute(stmt)
        self._session.flush()

    def delete(self, session_id: uuid.UUID) -> None:
        us = self.get_by_id(session_id)
        if us is not None:
            self._session.delete(us)
            self._session.flush()

    # ---- jobs (associated publish jobs) ------------------------------------
    def create_publish_job(
        self,
        *,
        scene_id: uuid.UUID,
        owner_id: uuid.UUID,
    ) -> Job:
        job = Job(
            scene_id=scene_id,
            owner_id=owner_id,
            kind=JobKind.PUBLISH.value,
            status=JobStatus.QUEUED.value,
        )
        self._session.add(job)
        self._session.flush()
        return job

    def expire_stale(self, max_age: timedelta) -> int:
        cutoff = datetime.now(UTC) - max_age
        stmt = (
            update(UploadSession)
            .where(
                UploadSession.status.in_([
                    UploadSessionStatus.CREATED.value,
                    UploadSessionStatus.UPLOADING.value,
                ]),
                UploadSession.expires_at < cutoff,
            )
            .values(status=UploadSessionStatus.EXPIRED.value)
        )
        result = self._session.execute(stmt)
        self._session.flush()
        return result.rowcount
