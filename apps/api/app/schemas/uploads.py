"""Upload session schemas (Phase 06)."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class CreateUploadRequest(BaseModel):
    """Client declaration of an upload before any bytes are transferred."""

    model_config = ConfigDict(extra="forbid")

    filename: str = Field(min_length=1, max_length=255)
    mime_type: str = Field(min_length=1, max_length=120)
    size: int = Field(gt=0)
    format: str = Field(min_length=1, max_length=20)
    # Optional client-computed SHA-256 of the whole file; verified at complete.
    sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")

    # Scene metadata captured before upload begins (Phase 06 wireframe).
    title: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    visibility: str = Field(default="PRIVATE", pattern=r"^(PRIVATE|UNLISTED|PUBLIC)$")
    category: str = Field(
        default="experiment",
        pattern=r"^(urban|architecture|interior|nature|portrait|experiment)$",
    )
    # Phase 07: PUBLISH (scene upload, legacy path) or RECONSTRUCT (3DGS input).
    purpose: str = Field(default="PUBLISH", pattern=r"^(PUBLISH|RECONSTRUCT)$")


class UploadSessionOut(BaseModel):
    """Created or inspected upload session (never exposes absolute paths)."""

    model_config = ConfigDict(extra="ignore")

    uploadId: UUID
    status: str
    offset: int
    totalSize: int
    chunkMaxBytes: int
    expiresAt: datetime
    format: str
    mimeType: str
    purpose: str = "PUBLISH"


class UploadStatusOut(UploadSessionOut):
    """HEAD /uploads/{id} — full status for a resumable client.

    FIX-UPLOAD-01 §15-§16 — minimal *read-only* processing surface for the
    UploadPage: scene identity + the separate Publish Job / Collision Job
    statuses, owner-authenticated. Never exposes storage keys / absolute paths.
    """

    ownerId: UUID
    sha256: str | None = None
    # Scene produced by this upload (null until the publish pipeline commits).
    sceneId: UUID | None = None
    sceneSlug: str | None = None
    # Publish job (kind=PUBLISH) for the scene.
    publishJobId: UUID | None = None
    publishStatus: str | None = None
    # Collision job (kind=BUILD_COLLISION) for the scene.
    collisionJobId: UUID | None = None
    collisionStatus: str | None = None


class UploadCompleteRequest(BaseModel):
    """Finalize an upload once every byte has been written."""

    model_config = ConfigDict(extra="forbid")

    sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    # Declared on create; kept here so a mis-matched client is rejected early.
    expected_size: int | None = Field(default=None, gt=0)


class UploadCompleteOut(BaseModel):
    """Response to complete: the upload is queued for validation/publishing.

    FIX-UPLOAD-01 §16 — the scene identity (id + slug) is returned so the
    UploadPage can navigate to the Viewer / Authoring / My Works without
    guessing. Never exposes storage keys / absolute paths.
    """

    uploadId: UUID
    status: str
    jobId: UUID | None = None
    sceneId: UUID | None = None
    sceneSlug: str | None = None


class CancelUploadOut(BaseModel):
    """Response to DELETE /uploads/{id}."""

    uploadId: UUID
    status: str
