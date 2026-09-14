"""Job endpoints — owner-gated reads."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.identity import RequestIdentity, get_current_user
from app.db.session import get_db_session
from app.schemas.job import JobOut
from app.services.jobs import JobService

router = APIRouter()


@router.get("/{job_id}", response_model=JobOut)
def get_job(
    job_id: str,
    identity: RequestIdentity = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> JobOut:
    """查询任务详情，仅任务所有者可访问。"""
    return JobService(db).get_owned(uuid.UUID(job_id), identity.user_id)
