"""Session DTOs contain controlled same-origin URLs, never access credentials."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class CreateEditSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expectedCurrentVersion: UUID
    selectedLod: int | None = Field(default=None, ge=0)
    acknowledgeLodSource: bool = False
    acknowledgeBrowserMemory: bool = False


class EditSessionOut(BaseModel):
    id: UUID
    sceneId: UUID
    sceneSlug: str
    sceneTitle: str
    sourceVersionId: UUID
    sourceAssetVersion: str
    sourceKind: str
    sourceCounts: list[int]
    selectedLod: int | None
    editorUpstreamCommit: str
    editorBuildIdentity: str
    status: str
    createdAt: datetime
    expiresAt: datetime
    editorUrl: str
    sourceUrl: str
    uploadId: UUID | None = None
    resultVersionId: UUID | None = None
    resultCounts: list[int] | None = None
    errorCode: str | None = None
    progress: int = 0
    stage: str | None = None


class EditExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    filename: str = Field(min_length=1, max_length=255)
    format: str = Field(pattern=r"^(ply|sog)$")
    mime_type: str = "application/octet-stream"
    size: int = Field(gt=0)
    sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    selectedLod: int | None = Field(default=None, ge=0)
    acknowledgeSelectedLod: bool = False


class EditSourceOut(BaseModel):
    sceneId: UUID
    sceneTitle: str
    currentVersionId: UUID | None
    assetVersion: str | None
    format: str | None
    counts: list[int]
    editorEnabled: bool
    maxGaussians: int
    spatialState: str | None
