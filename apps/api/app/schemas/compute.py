"""Compute / reconstruction schemas — DTOs for the Phase 07 compute API."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.core.config import get_settings

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


class SegmentationSettings(BaseModel):
    """The prompt names every matching instance to keep, never objects to erase."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    mode: Literal["OFF", "KEEP_PROMPTED_OBJECT"] = "OFF"
    prompt: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def validate_prompt(self) -> SegmentationSettings:
        if self.mode == "KEEP_PROMPTED_OBJECT" and not self.prompt:
            raise ValueError("请输入要保留并重建的目标提示词")
        if self.mode == "KEEP_PROMPTED_OBJECT":
            concepts = [part.strip() for part in re.split(r"[;\n]", self.prompt or "")]
            if not all(concepts) or len(concepts) > 8:
                raise ValueError("多个目标请用分号分隔，最多 8 个且不可为空")
        if self.mode == "OFF" and self.prompt:
            raise ValueError("完整场景模式不接受分割提示词")
        return self


class CreateReconstructionRequest(BaseModel):
    """Submit a reconstruction using the explicitly selected Gaussian backend."""

    model_config = ConfigDict(extra="forbid")

    uploadIds: list[UUID] = Field(min_length=1, max_length=300, alias="uploadIds")
    profile: str = Field(default="draft", min_length=1, max_length=30)
    algorithm: Literal["gsplat", "2dgs"] = "gsplat"
    sceneTitle: str = Field(min_length=1, max_length=200, alias="sceneTitle")
    description: str | None = Field(default=None, max_length=5000)
    segmentation: SegmentationSettings = Field(default_factory=SegmentationSettings)
    visibility: str = Field(
        default_factory=lambda: get_settings().default_upload_visibility,
        pattern=r"^(PRIVATE|UNLISTED|PUBLIC)$",
    )


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
