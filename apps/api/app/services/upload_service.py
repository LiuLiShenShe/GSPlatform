"""Upload service — session lifecycle: create, chunk-append, complete, cancel."""

from __future__ import annotations

import hashlib
import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.errors import ConflictError, NotFoundError
from app.core.identity import RequestIdentity
from app.db.models.enums import SceneStatus, UploadSessionStatus
from app.db.models.scene import Scene
from app.repositories.uploads import UploadRepository
from app.schemas.uploads import (
    CreateUploadRequest,
    UploadCompleteOut,
    UploadSessionOut,
    UploadStatusOut,
)
from app.storage.base import Storage

logger = logging.getLogger("gsplatform.api.upload")

PUBLISH_TASK = "tasks.publish_scene"


class UploadService:
    """Owns the upload/resume/complete/cancel use cases."""

    def __init__(
        self,
        session: Session,
        storage: Storage,
        settings: Settings,
        send_task: object | None = None,
    ) -> None:
        self._session = session
        self._storage = storage
        self._settings = settings
        self._repo = UploadRepository(session)
        self._send_task = send_task

    # ------------------------------------------------------------------ #
    # helpers
    # ------------------------------------------------------------------ #
    def _staging_key(self, upload_id: uuid.UUID) -> str:
        return f"staging/{upload_id}/upload.bin"

    def _quarantine_key(self, upload_id: uuid.UUID) -> str:
        return f"quarantine/{upload_id}"

    def _check_limits(self, req: CreateUploadRequest, owner_id: uuid.UUID) -> None:
        if req.purpose == "RECONSTRUCT":
            allowed_fmt = self._settings.reconstruct_upload_formats
            allowed_mime = self._settings.reconstruct_upload_mime_types
        else:
            allowed_fmt = self._settings.allowed_upload_formats
            allowed_mime = self._settings.allowed_upload_mime_types
        if req.format not in allowed_fmt:
            raise ConflictError(f"不支持的格式: {req.format}")
        if req.mime_type not in allowed_mime:
            raise ConflictError(f"不支持的 MIME 类型: {req.mime_type}")
        if req.size > self._settings.upload_max_bytes:
            raise ConflictError("文件超过大小上限")
        active = self._repo.count_active_for_user(owner_id)
        if active >= self._settings.max_concurrent_uploads_per_user:
            raise ConflictError("同时上传的会话数量已达上限")

    def _generate_slug(self, owner_id: uuid.UUID, upload_id: uuid.UUID) -> str:
        raw = f"{owner_id}-{upload_id}"
        digest = hashlib.sha256(raw.encode()).hexdigest()[:12]
        return f"u-{digest}"

    # ------------------------------------------------------------------ #
    # public use cases
    # ------------------------------------------------------------------ #
    def create_session(
        self, req: CreateUploadRequest, identity: RequestIdentity
    ) -> UploadSessionOut:
        self._check_limits(req, identity.user_id)
        upload_id = uuid.uuid4()
        storage_key = self._staging_key(upload_id)
        expiry = datetime.now(UTC) + timedelta(
            hours=self._settings.upload_expiry_hours
        )
        us = self._repo.create(
            id=upload_id,
            owner_id=identity.user_id,
            storage_key=storage_key,
            mime_type=req.mime_type,
            upload_format=req.format,
            total_size=req.size,
            expires_at=expiry,
            status=UploadSessionStatus.CREATED,
            title=req.title,
            description=req.description,
            visibility=req.visibility,
            category=req.category,
            declared_sha256=req.sha256,
            purpose=req.purpose,
        )
        self._storage.mkdir(f"staging/{upload_id}")
        self._session.commit()
        return self._to_out(us)

    def get_status(self, upload_id: uuid.UUID, identity: RequestIdentity) -> UploadStatusOut:
        us = self._owned_or_raise(upload_id, identity)
        return self._to_status(us)

    def append_chunk(
        self,
        upload_id: uuid.UUID,
        identity: RequestIdentity,
        data: bytes,
        *,
        declared_offset: int,
    ) -> UploadSessionOut:
        us = self._owned_or_raise(upload_id, identity)
        st_key = us.storage_key
        real_offset = self._storage.size(st_key)

        if declared_offset != real_offset:
            raise ConflictError(
                f"offset 不匹配 (server={real_offset}, client={declared_offset})",
                details={"offset": real_offset},
            )
        if len(data) > self._settings.upload_chunk_max_bytes:
            raise ConflictError("分块超过大小上限")
        if real_offset + len(data) > us.total_size:
            raise ConflictError("写入超过声明大小")

        self._storage.append(st_key, data)
        new_offset = real_offset + len(data)
        self._repo.update_offset(upload_id, new_offset)
        if new_offset >= us.total_size:
            self._repo.update_status(upload_id, UploadSessionStatus.UPLOADED)
        elif us.status == UploadSessionStatus.CREATED.value:
            self._repo.update_status(upload_id, UploadSessionStatus.UPLOADING)
        self._session.commit()
        # Re-read so caller sees the fresh offset.
        us = self._repo.get_by_id(upload_id) or us
        return self._to_out(us)

    def complete(
        self,
        upload_id: uuid.UUID,
        identity: RequestIdentity,
        *,
        expected_size: int | None,
        client_sha256: str | None,
    ) -> UploadCompleteOut:
        us = self._owned_or_raise(upload_id, identity)
        real_offset = self._storage.size(us.storage_key)
        if real_offset != us.total_size:
            raise ConflictError(
                f"上传不完整 (server={real_offset}, declared={us.total_size})",
                details={"offset": real_offset},
            )
        if expected_size is not None and expected_size != us.total_size:
            raise ConflictError(
                f"声明的文件大小不符 (server={us.total_size}, client={expected_size})"
            )
        real_sha = self._storage.sha256(us.storage_key)
        if client_sha256 and client_sha256.lower() != real_sha:
            raise ConflictError("SHA-256 校验失败", details={"sha256": real_sha})

        # Phase 07: RECONSTRUCT sessions never publish here — the reconstruction
        # submit step (POST /compute/reconstruct) owns the publish side. Just
        # mark the bytes as uploaded so the compute flow can reference them.
        if us.purpose == "RECONSTRUCT":
            self._repo.update_status(upload_id, UploadSessionStatus.UPLOADED)
            self._session.commit()
            return UploadCompleteOut(uploadId=us.id, status=us.status)

        scene = self._create_draft_scene(us, identity, size=real_offset, sha256=real_sha)
        # Link session to the newly created scene.
        self._repo.update_scene_id(us.id, scene.id)
        job = self._repo.create_publish_job(
            scene_id=scene.id, owner_id=identity.user_id
        )
        if self._send_task is None:
            self._session.rollback()
            raise RuntimeError("Celery queue is not configured")
        self._repo.update_status(upload_id, UploadSessionStatus.QUEUED)
        # Commit BEFORE dispatching: the worker must see the committed job row
        # when it picks up the task (otherwise a fast worker hits job_not_found).
        self._session.commit()
        self._send_task(
            PUBLISH_TASK,
            args=[str(us.id), str(scene.id), str(job.id)],
        )
        return UploadCompleteOut(uploadId=us.id, status=us.status, jobId=job.id)

    def cancel(self, upload_id: uuid.UUID, identity: RequestIdentity) -> UploadSessionOut:
        us = self._owned_or_raise(upload_id, identity)
        self._repo.update_status(upload_id, UploadSessionStatus.CANCELLED)
        self._storage.delete(self._quarantine_key(upload_id))
        self._storage.delete(us.storage_key)
        self._session.commit()
        return self._to_out(us)

    def expire_stale(self) -> int:
        max_age = timedelta(hours=self._settings.upload_expiry_hours)
        expired = self._repo.expire_stale(max_age)
        if expired:
            self._session.commit()
            logger.info("Marked %d stale upload session(s) as EXPIRED", expired)
        return expired

    # ------------------------------------------------------------------ #
    # internals
    # ------------------------------------------------------------------ #
    def _owned_or_raise(self, upload_id: uuid.UUID, identity: RequestIdentity):
        us = self._repo.get_owned(upload_id, identity.user_id)
        if us is None:
            raise NotFoundError("上传会话不存在或不属于当前用户")
        return us

    def _create_draft_scene(
        self,
        us,
        identity: RequestIdentity,
        *,
        size: int,
        sha256: str,
    ) -> Scene:
        slug = self._generate_slug(identity.user_id, us.id)
        scene = Scene(
            owner_id=identity.user_id,
            slug=slug,
            title=us.title,
            description=us.description,
            category=us.category,
            visibility=us.visibility,
            status=SceneStatus.PROCESSING.value,
            size_bytes=size,
        )
        self._session.add(scene)
        self._session.flush()
        return scene

    def _to_out(self, us) -> UploadSessionOut:
        return UploadSessionOut(
            uploadId=us.id,
            status=us.status,
            offset=us.offset,
            totalSize=us.total_size,
            chunkMaxBytes=self._settings.upload_chunk_max_bytes,
            expiresAt=us.expires_at,
            format=us.upload_format,
            mimeType=us.mime_type,
            purpose=us.purpose,
        )

    def _to_status(self, us) -> UploadStatusOut:
        out = self._to_out(us)
        return UploadStatusOut(**out.model_dump(), ownerId=us.owner_id, sha256=us.declared_sha256)
