"""Authorized processing policy, not a low-level CLI or verification API."""

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.identity import RequestIdentity, get_optional_current_user, require_csrf
from app.db.session import get_db_session
from app.schemas.scene_processing import SceneProcessingOut, SceneProcessingPatch
from app.services.scene_processing import SceneProcessingService

router = APIRouter()


@router.get("/{slug}/processing", response_model=SceneProcessingOut)
def get_processing(
    slug: str,
    request: Request,
    share: str | None = Query(default=None),
    identity: RequestIdentity | None = Depends(get_optional_current_user),
    session: Session = Depends(get_db_session),
) -> SceneProcessingOut:
    token = share or request.cookies.get(get_settings().share_cookie_name)
    return SceneProcessingService(session).get(slug, identity, token)


@router.patch("/{slug}/processing", response_model=SceneProcessingOut)
def patch_processing(
    slug: str,
    body: SceneProcessingPatch,
    identity: RequestIdentity = Depends(require_csrf),
    session: Session = Depends(get_db_session),
) -> SceneProcessingOut:
    return SceneProcessingService(session).patch(slug, identity, body)
