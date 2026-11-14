"""Owner-facing surface mesh state, without local filesystem paths."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from app.schemas.job import JobOut


class CreateSurfaceMeshRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expectedCurrentVersion: UUID


class SurfaceMeshOut(BaseModel):
    currentVersionId: UUID | None = None
    available: bool
    reason: str | None = None
    algorithm: Literal["2dgs-tsdf", "nksr"] | None = None
    job: JobOut | None = None
