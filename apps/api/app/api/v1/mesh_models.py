"""Owner-scoped mesh library API for the website and later integrations."""

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from starlette.responses import FileResponse

from app.core.config import get_settings
from app.core.identity import RequestIdentity, get_current_user
from app.db.session import get_db_session
from app.schemas.mesh_model import MeshModelList, MeshModelOut
from app.services.mesh_models import MeshModelService

router = APIRouter()


def service(db: Session = Depends(get_db_session)) -> MeshModelService:
    return MeshModelService(db, get_settings())


@router.get("", response_model=MeshModelList)
def list_models(
    identity: RequestIdentity = Depends(get_current_user),
    svc: MeshModelService = Depends(service),
    q: str = Query("", max_length=200),
    algorithm: Literal["nksr", "2dgs-tsdf"] | None = None,
    sort: Literal["created", "title"] = "created",
    page: int = Query(1, ge=1),
    pageSize: int = Query(24, ge=1, le=100),
) -> MeshModelList:
    return svc.list(identity, q=q, algorithm=algorithm, sort=sort, page=page, page_size=pageSize)


@router.get("/{model_id}", response_model=MeshModelOut)
def detail(
    model_id: UUID,
    identity: RequestIdentity = Depends(get_current_user),
    svc: MeshModelService = Depends(service),
) -> MeshModelOut:
    return svc.output(*svc.owned(model_id, identity))


@router.get("/{model_id}/file")
def model_file(
    model_id: UUID,
    identity: RequestIdentity = Depends(get_current_user),
    svc: MeshModelService = Depends(service),
) -> FileResponse:
    path, model = svc.file(model_id, identity)
    suffix = "meters" if model.units == "m" else "scene-units"
    return FileResponse(
        path,
        media_type="application/octet-stream",
        filename=f"mesh-{model.id}-{suffix}.ply",
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )
