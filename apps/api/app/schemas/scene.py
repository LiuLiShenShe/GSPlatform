"""Scene DTOs — explicit fields only, no ORM leakage.

``id`` is the business slug used by the viewer route ``/scene/:slug``; the
internal UUID is intentionally not exposed in list/detail payloads (it is an
implementation detail — the stable public identifier is the slug).
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.common import Page


class SceneAuthor(BaseModel):
    """Public author info (no credentials, no internal ids)."""

    id: str = Field(description="作者外部标识（slug 派生，占位）")
    name: str


class SceneSummaryOut(BaseModel):
    """Scene row for lists — the stable public representation."""

    id: str = Field(description="业务 slug，用于 /scene/:slug 路由")
    title: str
    description: str | None = None
    author: SceneAuthor
    category: str = Field(
        description="ASCII 枚举：urban/architecture/interior/nature/portrait/experiment"
    )
    visibility: str
    status: str
    splatCount: int | None = Field(default=None, alias="splatCount")
    sizeMB: float | None = Field(default=None, alias="sizeMB")
    views: int
    likes: int
    posterUrl: str | None = Field(default=None, alias="posterUrl")
    manifestUrl: str | None = Field(default=None, alias="manifestUrl")
    publishedAt: datetime | None = Field(default=None, alias="publishedAt")

    model_config = {"populate_by_name": True}


class SceneListPage(Page[SceneSummaryOut]):
    """Public scene catalogue page."""


class SceneDetailOut(SceneSummaryOut):
    """Scene detail: summary fields plus catalog extras."""

    createdAt: datetime | None = Field(default=None, alias="createdAt")
    updatedAt: datetime | None = Field(default=None, alias="updatedAt")
