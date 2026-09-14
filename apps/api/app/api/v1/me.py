"""My work endpoints — identity-gated owner views."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.identity import RequestIdentity, get_current_user
from app.db.session import get_db_session
from app.schemas.scene import SceneListPage
from app.services.scenes import SceneService

router = APIRouter()


@router.get("/scenes", response_model=SceneListPage)
def my_scenes(
    limit: int = Query(20, ge=1, le=100),
    cursor: str | None = Query(None),
    status: str | None = Query(None, description="按状态筛选"),
    identity: RequestIdentity = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> SceneListPage:
    """当前用户的作品列表（含所有状态和可见性）。"""
    return SceneService(db).list_owner(
        identity.user_id,
        limit=limit,
        cursor=cursor,
        status_filter=status,
    )
