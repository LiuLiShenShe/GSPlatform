"""Owner-only asynchronous surface mesh generation and downloads."""

from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from starlette.responses import FileResponse

from app.core.config import get_settings
from app.core.identity import RequestIdentity, get_current_user, require_csrf
from app.db.session import get_db_session
from app.schemas.surface_mesh import CreateSurfaceMeshRequest, SurfaceMeshOut
from app.services.surface_mesh import SurfaceMeshService

router = APIRouter()


def service(db: Session = Depends(get_db_session)) -> SurfaceMeshService:
    return SurfaceMeshService(db, get_settings())


@router.get("/{slug}/mesh", response_model=SurfaceMeshOut)
def mesh_status(
    slug: str,
    identity: RequestIdentity = Depends(get_current_user),
    svc: SurfaceMeshService = Depends(service),
) -> SurfaceMeshOut:
    return svc.status(slug, identity)


@router.post("/{slug}/mesh", response_model=SurfaceMeshOut, status_code=202)
def create_mesh(
    slug: str,
    body: CreateSurfaceMeshRequest,
    identity: RequestIdentity = Depends(require_csrf),
    svc: SurfaceMeshService = Depends(service),
) -> SurfaceMeshOut:
    from app.services.celery_client import send_task

    return svc.submit(slug, body, identity, send_task)


@router.post("/{slug}/mesh/{job_id}/cancel", response_model=SurfaceMeshOut)
def cancel_mesh(
    slug: str,
    job_id: UUID,
    identity: RequestIdentity = Depends(require_csrf),
    svc: SurfaceMeshService = Depends(service),
) -> SurfaceMeshOut:
    return svc.cancel(slug, job_id, identity)


@router.get("/{slug}/mesh/{job_id}/download")
def download_mesh(
    slug: str,
    job_id: UUID,
    identity: RequestIdentity = Depends(get_current_user),
    svc: SurfaceMeshService = Depends(service),
) -> FileResponse:
    path = svc.download(slug, job_id, identity)
    _, job = svc.owned_job(slug, job_id, identity)
    result = job.task_parameters.get("result", {})
    return FileResponse(
        path,
        media_type="application/octet-stream",
        filename=f"{slug}-mesh-{result.get('units', 'm')}.ply",
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )
