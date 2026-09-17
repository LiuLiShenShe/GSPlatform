"""Compute / reconstruction schemas — DTOs for the Phase 07 compute API."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

# ---- capabilities & profiles ------------------------------------------------ #

class ComputeCapabilitiesOut(BaseModel):
    """Machine capability snapshot for the compute layer."""

    model_config = ConfigDict(extra="forbid")

    ok: bool
    tools: dict[str, str | None]
    gpu: dict[str, object]
    problems: list[str]


class ComputeProfileOut(BaseModel):
    """Public profile summary (safe subset — no internal paths)."""

    model_config = ConfigDict(extra="forbid")

    name: str
    version: int
    maxInputBytes: int = Field(alias="maxInputBytes")
    maxImages: int = Field(alias="maxImages")
    maxVideoSeconds: int = Field(alias="maxVideoSeconds")
    iterations: int
    stages: list[str]


# ---- reconstruction job ---------------------------------------------------- #

class CreateReconstructionRequest(BaseModel):
    """Submit a new 3DGS reconstruction from already-uploaded media."""

    model_config = ConfigDict(extra="forbid")

    uploadIds: list[UUID] = Field(min_length=1, max_length=300, alias="uploadIds")
    profile: str = Field(default="draft", min_length=1, max_length=30)
    sceneTitle: str = Field(min_length=1, max_length=200, alias="sceneTitle")
    description: str | None = Field(default=None, max_length=5000)
    visibility: str = Field(default="PRIVATE", pattern=r"^(PRIVATE|UNLISTED|PUBLIC)$")


class ReconstructionJobOut(BaseModel):
    """Response to reconstruct request / cancel — thin job DTO."""

    model_config = ConfigDict(extra="forbid")

    jobId: UUID = Field(alias="jobId")
    status: str
    stage: str | None = None
    progress: int = Field(ge=0, le=100)
    errorCode: str | None = Field(default=None, alias="errorCode")
    errorMessage: str | None = Field(default=None, alias="errorMessage")
    createdAt: datetime = Field(alias="createdAt")
    updatedAt: datetime = Field(alias="updatedAt")
    sceneId: str | None = Field(default=None, alias="sceneId")
