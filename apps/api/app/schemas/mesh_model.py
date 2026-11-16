"""Stable mesh library API, with private server paths deliberately excluded."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel


class MeshModelOut(BaseModel):
    id: UUID
    title: str
    sceneId: UUID
    sceneSlug: str
    sceneTitle: str
    sourceVersionId: UUID
    isCurrentSource: bool
    algorithm: Literal["nksr", "2dgs-tsdf"]
    units: Literal["cm", "m", "scene"]
    vertices: int
    faces: int
    sizeBytes: int
    sha256: str
    createdAt: datetime
    downloadUrl: str
    previewUrl: str
    jobId: UUID | None = None
    glbStatus: str = "NOT_GENERATED"


class MeshModelList(BaseModel):
    items: list[MeshModelOut]
    total: int
    page: int
    pageSize: int
