"""My work endpoints — identity-gated owner views with real pagination.

Routes:
  GET  /me/scenes              — owner scenes with filter/search/sort
  GET  /me/scenes/{slug}/jobs  — jobs for a specific owned scene
  POST /jobs/{job_id}/cancel   — request cancel (owner-gated)
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.errors import NotFoundError
from app.core.identity import RequestIdentity, require_csrf
from app.db.session import get_db_session
from app.schemas.job import JobOut
from app.schemas.scene import SceneListPage
from app.services.jobs import JobService
from app.services.scenes import SceneService

router = APIRouter()


@router.get("/scenes", response_model=SceneListPage)
def my_scenes(
    limit: int = Query(20, ge=1, le=100),
    cursor: str | None = Query(None),
    status: str | None = Query(
        None, description="按状态筛选：DRAFT/PROCESSING/PUBLISHED/FAILED/ARCHIVED"
    ),
    search: str | None = Query(None, description="标题关键词搜索"),
    sort: str = Query(
        "updated", description="排序：updated/title/created"
    ),
    identity: RequestIdentity = Depends(require_csrf),
    db: Session = Depends(get_db_session),
) -> SceneListPage:
    """当前用户的作品列表（含所有状态和可见性）。"""
    return SceneService(db).list_owner(
        identity.user_id,
        limit=limit,
        cursor=cursor,
        status_filter=status,
        search=search,
        sort=sort,
    )


@router.get("/scenes/{scene_slug}/jobs", response_model=list[JobOut])
def my_scene_jobs(
    scene_slug: str,
    identity: RequestIdentity = Depends(require_csrf),
    db: Session = Depends(get_db_session),
) -> list[JobOut]:
    """List jobs for a scene owned by the current user."""
    from app.db.models.job import Job
    from app.db.models.scene import Scene

    scene = (
        db.query(Scene)
        .filter(Scene.slug == scene_slug, Scene.owner_id == identity.user_id)
        .first()
    )
    if scene is None:
        raise NotFoundError("场景不存在或不属于当前用户")

    jobs = (
        db.query(Job)
        .filter(Job.scene_id == scene.id)
        .order_by(Job.created_at.desc())
        .all()
    )
    return [JobService(db)._to_out(j) for j in jobs]
