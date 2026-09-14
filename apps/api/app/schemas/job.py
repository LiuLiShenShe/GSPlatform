"""Job DTOs — safe subset, never raw error internals or Celery ids."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class JobOut(BaseModel):
    """Job state visible to its owner (and only its owner)."""

    id: str
    sceneId: str = Field(alias="sceneId")
    kind: str
    status: str
    progress: int = Field(ge=0, le=100)
    stage: str | None = None
    errorCode: str | None = Field(default=None, alias="errorCode")
    errorMessage: str | None = Field(default=None, alias="errorMessage")
    createdAt: datetime = Field(alias="createdAt")
    updatedAt: datetime = Field(alias="updatedAt")

    model_config = {"populate_by_name": True}
