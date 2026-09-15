"""Upload session API endpoints (Phase 06).

Protocol:
  POST   /api/v1/uploads          — create upload session
  HEAD   /api/v1/uploads/{id}     — query real offset / status
  PATCH  /api/v1/uploads/{id}     — write a chunk (binary body + Upload-Offset header)
  POST   /api/v1/uploads/{id}/complete — finalize & enqueue
  DELETE /api/v1/uploads/{id}     — cancel & clean up
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Header, Request, Response
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.core.errors import ConflictError
from app.core.identity import RequestIdentity, get_current_user
from app.db.session import get_db_session
from app.schemas.uploads import (
    CancelUploadOut,
    CreateUploadRequest,
    UploadCompleteOut,
    UploadCompleteRequest,
    UploadSessionOut,
    UploadStatusOut,
)
from app.services.celery_client import send_task
from app.services.upload_service import UploadService
from app.storage import LocalDiskStorage

router = APIRouter()


def _storage(settings: Settings = Depends(get_settings)) -> LocalDiskStorage:
    return LocalDiskStorage(settings.storage_root)


def _service(
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
) -> UploadService:
    return UploadService(db, _storage(settings), settings, send_task=send_task)


# ------------------------------------------------------------------
# POST /uploads — create upload session
# ------------------------------------------------------------------
@router.post("", response_model=UploadSessionOut, status_code=201)
def create_upload(
    body: CreateUploadRequest,
    identity: RequestIdentity = Depends(get_current_user),
    svc: UploadService = Depends(_service),
) -> UploadSessionOut:
    return svc.create_session(body, identity)


# ------------------------------------------------------------------
# HEAD /uploads/{id} — query real offset / status (same semantics as tus HEAD)
# ------------------------------------------------------------------
@router.head("/{upload_id}", response_class=Response)
def head_upload(
    upload_id: uuid.UUID,
    identity: RequestIdentity = Depends(get_current_user),
    svc: UploadService = Depends(_service),
) -> Response:
    out: UploadStatusOut = svc.get_status(upload_id, identity)
    return Response(
        status_code=200,
        headers={
            "Upload-Length": str(out.totalSize),
            "Upload-Offset": str(out.offset),
            "Upload-Status": out.status,
        },
    )


# ------------------------------------------------------------------
# PATCH /uploads/{id} — write a chunk
# ------------------------------------------------------------------
@router.patch("/{upload_id}", response_model=UploadSessionOut)
async def patch_upload(
    upload_id: uuid.UUID,
    request: Request,
    upload_offset: int = Header(alias="Upload-Offset"),
    upload_length: int | None = Header(default=None, alias="Upload-Length"),
    identity: RequestIdentity = Depends(get_current_user),
    svc: UploadService = Depends(_service),
) -> UploadSessionOut:
    body = await request.body()
    if not body:
        raise ConflictError("请求体不能为空")
    if len(body) > svc._settings.upload_chunk_max_bytes:
        raise ConflictError("分块超过大小上限")
    return svc.append_chunk(
        upload_id, identity, body, declared_offset=upload_offset
    )


# ------------------------------------------------------------------
# POST /uploads/{id}/complete — finalize upload & enqueue publish task
# ------------------------------------------------------------------
@router.post("/{upload_id}/complete", response_model=UploadCompleteOut)
def complete_upload(
    upload_id: uuid.UUID,
    body: UploadCompleteRequest = UploadCompleteRequest(),
    identity: RequestIdentity = Depends(get_current_user),
    svc: UploadService = Depends(_service),
) -> UploadCompleteOut:
    return svc.complete(
        upload_id,
        identity,
        expected_size=body.expected_size,
        client_sha256=body.sha256,
    )


# ------------------------------------------------------------------
# DELETE /uploads/{id} — cancel upload & clean up
# ------------------------------------------------------------------
@router.delete("/{upload_id}", response_model=CancelUploadOut)
def cancel_upload(
    upload_id: uuid.UUID,
    identity: RequestIdentity = Depends(get_current_user),
    svc: UploadService = Depends(_service),
) -> CancelUploadOut:
    out = svc.cancel(upload_id, identity)
    return CancelUploadOut(uploadId=out.uploadId, status=out.status)
