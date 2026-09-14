"""Shared Pydantic v2 DTOs — pagination, error body, generic page wrapper."""

from __future__ import annotations

from typing import Generic, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


class ErrorResponse(BaseModel):
    """Stable error body: ``{code, message, requestId}``."""

    code: str
    message: str
    requestId: str


class PageMeta(BaseModel):
    """Pagination metadata attached to list responses."""

    limit: int = Field(..., ge=1, le=100, description="本次返回的最大条数")
    nextCursor: str | None = Field(
        default=None, description="下一页游标；null 表示没有更多"
    )
    total: int | None = Field(default=None, description="可选的匹配总数")


class Page(BaseModel, Generic[T]):
    """Generic page envelope: items + meta."""

    items: list[T]
    meta: PageMeta
