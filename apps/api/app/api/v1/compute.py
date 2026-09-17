"""Compute API — 3DGS reconstruction pipeline endpoints (Phase 07).

  GET  /api/v1/compute/capabilities     — tool / GPU availability
  GET  /api/v1/compute/profiles          — available quality profiles
  POST /api/v1/compute/reconstruct       — submit a reconstruction job
  POST /api/v1/compute/jobs/{id}/cancel  — request cancellation
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.core.identity import RequestIdentity, get_current_user
from app.db.session import get_db_session
from app.schemas.compute import (
    ComputeCapabilitiesOut,
    ComputeProfileOut,
    CreateReconstructionRequest,
    ReconstructionJobOut,
)
from app.services.celery_client import send_task
from app.services.reconstruction_service import ReconstructionService

router = APIRouter()


def _service(
    db: Session = Depends(get_db_session),
) -> ReconstructionService:
    from app.core.config import get_settings

    return ReconstructionService(db, get_settings())


# ------------------------------------------------------------------ #
# GET /compute/capabilities
# ------------------------------------------------------------------ #
@router.get("/capabilities", response_model=ComputeCapabilitiesOut)
def get_capabilities() -> ComputeCapabilitiesOut:
    """Worker host capability probe (ffmpeg, colmap, gsplat, GPU)."""
    return ReconstructionService.get_capabilities()


# ------------------------------------------------------------------ #
# GET /compute/profiles
# ------------------------------------------------------------------ #
@router.get("/profiles", response_model=list[ComputeProfileOut])
def list_profiles() -> list[ComputeProfileOut]:
    """Public reconstruction quality profiles."""
    return ReconstructionService.list_profiles()


# ------------------------------------------------------------------ #
# POST /compute/reconstruct
# ------------------------------------------------------------------ #
@router.post(
    "/reconstruct",
    response_model=ReconstructionJobOut,
    status_code=status.HTTP_202_ACCEPTED,
)
def submit_reconstruction(
    body: CreateReconstructionRequest,
    identity: RequestIdentity = Depends(get_current_user),
    svc: ReconstructionService = Depends(_service),
) -> ReconstructionJobOut:
    """Submit a 3DGS reconstruction from previously-uploaded media."""
    return svc.submit_reconstruction(body, identity, send_task=send_task)


# ------------------------------------------------------------------ #
# POST /compute/jobs/{job_id}/cancel
# ------------------------------------------------------------------ #
@router.post(
    "/jobs/{job_id}/cancel",
    response_model=ReconstructionJobOut,
)
def cancel_reconstruction_job(
    job_id: str,
    identity: RequestIdentity = Depends(get_current_user),
    svc: ReconstructionService = Depends(_service),
) -> ReconstructionJobOut:
    """Request cancellation of a reconstruction job (owner-gated)."""
    return svc.cancel_job(uuid.UUID(job_id), identity)
