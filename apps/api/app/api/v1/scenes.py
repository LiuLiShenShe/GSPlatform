"""Scene catalogue endpoints — public list, detail, owner mutations.

Routes:
  GET    ""            — public list (PUBLIC + PUBLISHED)
  GET    /{slug}       — detail (404 vs 403 semantics)
  PATCH  /{slug}       — owner edit (optimistic concurrency)
  POST   /{slug}/archive   — owner archive
  POST   /{slug}/restore   — owner restore from archive
  DELETE /{slug}       — owner soft-delete
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.identity import (
    RequestIdentity,
    get_optional_current_user,
    require_csrf,
)
from app.db.session import get_db_session
from app.schemas.scene import SceneDetailOut, SceneListPage
from app.services.scenes import SceneService

router = APIRouter()


class SceneRestoreOut(BaseModel):
    """恢复结果 —— 前端据此给出**准确**的提示（GS-NEXT-11 §2）。"""

    message: str
    status: str = Field(description="恢复后的场景状态")
    legacy: bool = Field(
        default=False,
        description="是否为存量归档数据（归档前状态不可考，已保守恢复到 READY）",
    )
    fromRecycleBin: bool = Field(default=False, description="本次是否从回收站恢复")
    stillArchived: bool = Field(
        default=False,
        description="恢复后是否仍处于已归档状态（需要再一次恢复才能解除归档）",
    )

    model_config = {"populate_by_name": True}


class SceneUpdateRequest(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    category: str | None = None
    visibility: str | None = None
    # Optimistic concurrency: client echoes the updatedAt it saw; mismatch → 409.
    expectedUpdatedAt: datetime | None = Field(default=None, alias="expectedUpdatedAt")

    model_config = {"populate_by_name": True}


class MessageOut(BaseModel):
    message: str


@router.get("", response_model=SceneListPage)
def list_public_scenes(
    limit: int = Query(20, ge=1, le=100, description="每页条数，最大 100"),
    cursor: str | None = Query(None, description="稳定游标分页"),
    category: str | None = Query(
        None,
        description="分类筛选：urban/architecture/interior/nature/portrait/experiment",
    ),
    sort: str = Query("latest", description="排序：latest（发布时间）或 popular（浏览量）"),
    identity: RequestIdentity | None = Depends(get_optional_current_user),
    db: Session = Depends(get_db_session),
) -> SceneListPage:
    """公开场景列表：仅 PUBLIC + PUBLISHED + 未删除。"""
    return SceneService(db).list_public(
        limit=limit,
        cursor=cursor,
        category=category,
        sort=sort,
        user_id=identity.user_id if identity is not None else None,
    )


@router.get("/{slug}", response_model=SceneDetailOut)
def get_scene_detail(
    slug: str,
    identity: RequestIdentity | None = Depends(get_optional_current_user),
    db: Session = Depends(get_db_session),
) -> SceneDetailOut:
    """场景详情：正确区分不存在(404)、无权限(403) 与可见(200)。"""
    return SceneService(db).resolve_detail(slug, identity)


@router.patch("/{slug}", response_model=SceneDetailOut)
def update_scene(
    slug: str,
    body: SceneUpdateRequest,
    identity: RequestIdentity = Depends(require_csrf),
    db: Session = Depends(get_db_session),
) -> SceneDetailOut:
    """Owner-only edit with optimistic concurrency (409 on stale update)."""
    SceneService(db).update_scene(
        owner_id=identity.user_id,
        slug=slug,
        title=body.title,
        description=body.description,
        category=body.category,
        visibility=body.visibility,
        expected_updated_at=body.expectedUpdatedAt,
    )
    return SceneService(db).resolve_detail(slug, identity)


@router.post("/{slug}/archive", response_model=MessageOut)
def archive_scene(
    slug: str,
    identity: RequestIdentity = Depends(require_csrf),
    db: Session = Depends(get_db_session),
) -> MessageOut:
    SceneService(db).archive_scene(owner_id=identity.user_id, slug=slug)
    return MessageOut(message="场景已归档")


@router.post("/{slug}/restore", response_model=SceneRestoreOut)
def restore_scene(
    slug: str,
    identity: RequestIdentity = Depends(require_csrf),
    db: Session = Depends(get_db_session),
) -> SceneRestoreOut:
    """恢复已归档 / 已软删除的场景。

    ``legacy=True`` 表示这是一条 GS-NEXT-10 之前归档的存量数据（没有记录归档
    前状态）：平台不会猜它是 PUBLISHED 还是 READY，而是保守恢复到 READY
    （仅自己可见），由所有者自行确认后再发布。``stillArchived=True`` 表示场景
    同时被软删除且已归档，本次只出回收站，还需要再点一次「恢复」解除归档。
    """
    result = SceneService(db).restore_scene(owner_id=identity.user_id, slug=slug)
    return SceneRestoreOut(
        message="场景已恢复",
        status=result.status,
        legacy=result.legacy,
        fromRecycleBin=result.from_recycle_bin,
        stillArchived=result.still_archived,
    )


@router.delete("/{slug}", response_model=MessageOut)
def delete_scene(
    slug: str,
    identity: RequestIdentity = Depends(require_csrf),
    db: Session = Depends(get_db_session),
) -> MessageOut:
    SceneService(db).soft_delete_scene(owner_id=identity.user_id, slug=slug)
    return MessageOut(message="场景已删除")
