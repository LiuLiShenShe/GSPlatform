"""Owner-only official Editor launch and version-pinned private source transfer."""

import uuid

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session
from starlette.responses import FileResponse

from app.core.config import get_settings
from app.core.errors import NotFoundError
from app.core.identity import RequestIdentity, get_current_user, require_csrf
from app.db.session import get_db_session
from app.schemas.editor_session import (
    CreateEditSessionRequest,
    EditExportRequest,
    EditSessionOut,
    EditSourceOut,
)
from app.schemas.uploads import UploadCompleteOut, UploadCompleteRequest, UploadSessionOut
from app.services.editor_session import EditorSessionService

router = APIRouter()


def service(db: Session = Depends(get_db_session)) -> EditorSessionService:
    return EditorSessionService(db, get_settings())


@router.post("/{slug}/edit-sessions", response_model=EditSessionOut, status_code=201)
def create_session(
    slug: str, body: CreateEditSessionRequest,
    identity: RequestIdentity = Depends(require_csrf),
    svc: EditorSessionService = Depends(service),
) -> EditSessionOut:
    return svc.create(slug, body, identity)


@router.get("/{slug}/edit-source", response_model=EditSourceOut)
def get_source_info(
    slug: str, identity: RequestIdentity = Depends(get_current_user),
    svc: EditorSessionService = Depends(service),
) -> EditSourceOut:
    return svc.source_info(slug, identity)


@router.get("/{slug}/edit-sessions/{session_id}", response_model=EditSessionOut)
def get_session(
    slug: str, session_id: uuid.UUID, identity: RequestIdentity = Depends(get_current_user),
    svc: EditorSessionService = Depends(service),
) -> EditSessionOut:
    return svc.get(slug, session_id, identity)


@router.post("/{slug}/edit-sessions/{session_id}/cancel", response_model=EditSessionOut)
def cancel_session(
    slug: str, session_id: uuid.UUID, identity: RequestIdentity = Depends(require_csrf),
    svc: EditorSessionService = Depends(service),
) -> EditSessionOut:
    return svc.cancel(slug, session_id, identity)


@router.post("/{slug}/edit-sessions/{session_id}/uploads", response_model=UploadSessionOut)
def create_export_upload(
    slug: str, session_id: uuid.UUID, body: EditExportRequest,
    identity: RequestIdentity = Depends(require_csrf),
    svc: EditorSessionService = Depends(service),
) -> UploadSessionOut:
    return svc.create_upload(slug, session_id, body, identity)


@router.post("/{slug}/edit-sessions/{session_id}/complete", response_model=UploadCompleteOut)
def complete_export(
    slug: str, session_id: uuid.UUID, body: UploadCompleteRequest,
    identity: RequestIdentity = Depends(require_csrf),
    svc: EditorSessionService = Depends(service),
) -> UploadCompleteOut:
    from app.services.celery_client import send_task
    from app.services.upload_service import UploadService
    from app.storage import LocalDiskStorage

    _, edit = svc.owned(slug, session_id, identity)
    if edit.upload_id is None:
        raise NotFoundError("编辑导出尚未上传")
    return UploadService(svc.session, LocalDiskStorage(svc.settings.storage_root),
                         svc.settings, send_task=send_task).complete(
        edit.upload_id, identity, expected_size=body.expected_size, client_sha256=body.sha256,
    )


@router.get("/{slug}/edit-sessions/{session_id}/source/versions/{asset_version}/{resource:path}")
def get_source(
    slug: str, session_id: uuid.UUID, asset_version: str, resource: str,
    identity: RequestIdentity = Depends(get_current_user),
    svc: EditorSessionService = Depends(service),
) -> Response:
    resolved = svc.source(slug, session_id, asset_version, resource, identity)
    headers = {"Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer",
               "X-Content-Type-Options": "nosniff"}
    if resolved.x_accel_path:
        return Response(headers={**headers, "X-Accel-Redirect": resolved.x_accel_path,
                                 "Content-Type": resolved.media_type})
    if resolved.absolute_path is None:
        raise NotFoundError("编辑资源不存在")
    return FileResponse(resolved.absolute_path, media_type=resolved.media_type, headers=headers)
