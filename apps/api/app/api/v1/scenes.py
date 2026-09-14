"""Scene catalogue endpoints — public list and detail."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.identity import RequestIdentity, get_optional_current_user
from app.db.session import get_db_session
from app.schemas.scene import SceneDetailOut, SceneListPage
from app.services.scenes import SceneService

router = APIRouter()


@router.get("", response_model=SceneListPage)
def list_public_scenes(
    limit: int = Query(20, ge=1, le=100, description="每页条数，最大 100"),
    cursor: str | None = Query(None, description="稳定游标分页"),
    category: str | None = Query(
        None,
        description="分类筛选：urban/architecture/interior/nature/portrait/experiment",
    ),
    sort: str = Query("latest", description="排序：latest（发布时间）或 popular（浏览量）"),
    db: Session = Depends(get_db_session),
) -> SceneListPage:
    """公开场景列表：仅 PUBLIC + PUBLISHED + 未删除。"""
    return SceneService(db).list_public(
        limit=limit, cursor=cursor, category=category, sort=sort
    )


@router.get("/{slug}", response_model=SceneDetailOut)
def get_scene_detail(
    slug: str,
    identity: RequestIdentity | None = Depends(get_optional_current_user),
    db: Session = Depends(get_db_session),
) -> SceneDetailOut:
    """场景详情：正确区分不存在(404)、无权限(403) 与可见(200)。"""
    return SceneService(db).resolve_detail(slug, identity)
