"""Share endpoints — create, list, revoke, resolve.

Routes:
  POST   /shares/scenes/{slug}        — owner creates a share link
  GET    /shares/scenes/{slug}        — owner lists active shares
  DELETE /shares/{share_id}/scenes/{slug} — owner revokes a share
  GET    /shares/resolve/{token}      — visitor opens a share URL
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session as DBSession

from app.core.config import get_settings
from app.core.errors import RateLimitError
from app.core.identity import CurrentUser, get_current_user, require_csrf
from app.core.rate_limit import check_rate_limit
from app.db.session import get_db_session
from app.schemas.share import (
    CreateShareOut,
    CreateShareRequest,
    ShareLinkOut,
    ShareListPage,
    ShareResolutionOut,
)
from app.services.share_service import ShareService

router = APIRouter()


def _service(db: DBSession) -> ShareService:
    return ShareService(db)


@router.post("/scenes/{scene_slug}", response_model=CreateShareOut)
def create_share(
    scene_slug: str,
    request: Request,
    body: CreateShareRequest | None = None,
    identity: CurrentUser = Depends(require_csrf),
    db: DBSession = Depends(get_db_session),
) -> CreateShareOut:
    settings = get_settings()
    rl = check_rate_limit(
        "share",
        str(identity.user_id),
        limit=settings.rate_limit_share_per_hour,
        window_seconds=3600,
    )
    if not rl.allowed:
        raise RateLimitError(rl.reason)
    result = _service(db).create_share(
        owner_id=identity.user_id,
        scene_slug=scene_slug,
        hours=body.hours if body is not None else None,
    )
    return CreateShareOut(**result)


@router.get("/scenes/{scene_slug}", response_model=ShareListPage)
def list_shares(
    scene_slug: str,
    identity: CurrentUser = Depends(get_current_user),
    db: DBSession = Depends(get_db_session),
) -> ShareListPage:
    rows = _service(db).list_shares(owner_id=identity.user_id, scene_slug=scene_slug)
    return ShareListPage(items=[ShareLinkOut(**r) for r in rows])


@router.delete("/{share_id}/scenes/{scene_slug}", response_model=dict[str, bool])
def revoke_share(
    share_id: str,
    scene_slug: str,
    identity: CurrentUser = Depends(require_csrf),
    db: DBSession = Depends(get_db_session),
) -> dict[str, bool]:
    _service(db).revoke_share(
        owner_id=identity.user_id,
        scene_slug=scene_slug,
        share_id=uuid.UUID(share_id),
    )
    return {"revoked": True}


@router.get("/resolve/{token}", response_model=ShareResolutionOut)
def resolve_share(
    token: str,
    db: DBSession = Depends(get_db_session),
) -> ShareResolutionOut:
    scene, link = _service(db).resolve_share(token)
    return ShareResolutionOut(
        scene=scene,
        shareId=str(link.id),
        expiresAt=link.expires_at,
    )
