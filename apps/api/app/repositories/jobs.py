"""Job repository — SQLAlchemy queries for async pipeline state."""

from __future__ import annotations

import uuid

from sqlalchemy.orm import Session

from app.db.models.job import Job


class JobRepository:
    """Job queries; ownership enforcement lives in the service layer."""

    def __init__(self, session: Session) -> None:
        self._session = session

    def get_by_id(self, job_id: uuid.UUID) -> Job | None:
        return (
            self._session.query(Job)
            .filter(Job.id == job_id)
            .first()
        )

    def get_owned(
        self, job_id: uuid.UUID, owner_id: uuid.UUID
    ) -> Job | None:
        """Return a job only if the caller owns it (else None)."""
        return (
            self._session.query(Job)
            .filter(Job.id == job_id, Job.owner_id == owner_id)
            .first()
        )
