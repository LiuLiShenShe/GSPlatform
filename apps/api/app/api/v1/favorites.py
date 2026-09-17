"""Favorite endpoints — idempotent add/remove, list, status.

Routes:
  PUT    /favorites/{slug}    — add favorite (idempotent)
  DELETE /favorites/{slug}    — remove favorite (idempotent)
  GET    /favorites          — list my favorited scenes
  GET    /favorites/status?slugs=... — bulk favorite flags (for SceneCard sync)
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session as DBSession

from app.core.identity import CurrentUser, get_current_user, require_csrf
from app.db.session import get_db_session
from app.schemas.scene import SceneSummaryOut
from app.services.favorite_service import FavoriteService

router = APIRouter()


def _service(db: DBSession) -> FavoriteService:
    return FavoriteService(db)


@router.put("/{scene_slug}", response_model=dict[str, bool])
def add_favorite(
    scene_slug: str,
    identity: CurrentUser = Depends(require_csrf),
    db: DBSession = Depends(get_db_session),
) -> dict[str, bool]:
    svc = _service(db)
    added = svc.add_favorite(identity.user_id, scene_slug)
    return {"favorited": True, "changed": added}


@router.delete("/{scene_slug}", response_model=dict[str, bool])
def remove_favorite(
    scene_slug: str,
    identity: CurrentUser = Depends(require_csrf),
    db: DBSession = Depends(get_db_session),
) -> dict[str, bool]:
    svc = _service(db)
    removed = svc.remove_favorite(identity.user_id, scene_slug)
    return {"favorited": False, "changed": removed}


@router.get("", response_model=list[SceneSummaryOut])
def list_favorites(
    identity: CurrentUser = Depends(get_current_user),
    db: DBSession = Depends(get_db_session),
) -> list[SceneSummaryOut]:
    return _service(db).list_favorited(identity.user_id)


@router.get("/status", response_model=dict[str, bool])
def favorite_status(
    slugs: list[str] = Query(..., description="场景 slug 列表"),
    identity: CurrentUser = Depends(get_current_user),
    db: DBSession = Depends(get_db_session),
) -> dict[str, bool]:
    svc = _service(db)
    return {slug: svc.is_favorited(identity.user_id, slug) for slug in slugs}
