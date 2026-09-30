"""Collision asset API routes (Phase 12; SSV-07 artifact serving).

Routes:
  POST   /{slug}/collision/build            — create & dispatch collision build
  GET    /{slug}/collision                  — get collision status
  GET    /{slug}/collision/mesh             — serve collision GLB (SSV-01 contract)
  GET    /{slug}/collision/collision.glb    — GLB under a .glb url (official mesh loader)
  GET    /{slug}/collision/collision.voxel.json — voxel metadata (official VoxelCollision)
  GET    /{slug}/collision/collision.voxel.bin  — voxel leaf octree binary
  PATCH  /{slug}/collision                  — update physics params
  POST   /{slug}/collision/rebuild          — rebuild collision
  DELETE /{slug}/collision                  — delete collision asset
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.core.identity import (
    RequestIdentity,
    get_optional_current_user,
    require_csrf,
)
from app.db.session import get_db_session
from app.schemas.collision import (
    CollisionAssetCreateRequest,
    CollisionAssetOut,
    CollisionAssetUpdateRequest,
    CollisionBuildResponse,
)
from app.services.celery_client import send_task
from app.services.collision import CollisionService
from app.services.scene_access import SceneAccessPolicy
from app.services.scene_asset import SceneAssetAccessScope, build_cache_control
from app.storage import LocalDiskStorage

router = APIRouter()


def _storage(settings: Settings = Depends(get_settings)) -> LocalDiskStorage:
    return LocalDiskStorage(settings.storage_root)


def _service(
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
) -> CollisionService:
    return CollisionService(db, _storage(settings), send_task=send_task)


def _readable_slug(
    db: Session,
    slug: str,
    request: Request,
    identity: RequestIdentity | None,
    share: str | None,
) -> str:
    """Authorize a collision READ (FIX-01 §3 — collision is a read surface).

    The unified policy decides: owner / PUBLIC+PUBLISHED / live share token →
    allowed; deleted or missing → 404; private for anonymous → 401; private
    for other user → 403.  Before FIX-01 these routes served bytes for any
    non-deleted slug with no identity at all.
    """
    token = share or request.cookies.get(get_settings().share_cookie_name) or None
    SceneAccessPolicy(db).resolve_readable_scene(slug, identity, share_token=token)
    return slug


def _readable_scope(
    db: Session,
    slug: str,
    request: Request,
    identity: RequestIdentity | None,
    share: str | None,
) -> SceneAssetAccessScope:
    """Cache scope for a readable collision asset (FIX-05 §10/§11).

    Collision bytes are served at a stable URL that is rebuilt in place — they
    are mutable and must never be ``immutable``, and a private/shared scene
    must never come back ``Cache-Control: public``.
    """
    token = share or request.cookies.get(get_settings().share_cookie_name) or None
    policy = SceneAccessPolicy(db)
    scene = policy.resolve_readable_scene(slug, identity, share_token=token)
    return policy.cache_scope(scene, token)


# ------------------------------------------------------------------ #
# Get collision status
# ------------------------------------------------------------------ #

@router.get("/{slug}/collision", response_model=CollisionAssetOut)
def get_collision(
    slug: str,
    request: Request,
    identity: RequestIdentity | None = Depends(get_optional_current_user),
    share: str | None = Query(default=None),
    db: Session = Depends(get_db_session),
    svc: CollisionService = Depends(_service),
) -> CollisionAssetOut:
    """Get collision asset status for a readable scene."""
    _readable_slug(db, slug, request, identity, share)
    return svc.get_collision(slug, identity.user_id if identity else None)


@router.get("/{slug}/collision/mesh")
def serve_collision_mesh(
    slug: str,
    request: Request,
    identity: RequestIdentity | None = Depends(get_optional_current_user),
    share: str | None = Query(default=None),
    db: Session = Depends(get_db_session),
    svc: CollisionService = Depends(_service),
) -> Response:
    """Serve the built collision GLB to a readable scene.

    Kept for the SSV-01 runtime contract. The runtime descriptor now emits the
    ``.glb``-suffixed url (``/collision/collision.glb``) because the official
    viewer selects mesh-vs-voxel by the url extension.
    """
    scope = _readable_scope(db, slug, request, identity, share)
    data, mime = svc.serve_collision_mesh(slug)
    return Response(
        content=data,
        media_type=mime,
        headers={"Cache-Control": build_cache_control(scope, "current/collision")},
    )


@router.get("/{slug}/collision/collision.glb")
def serve_collision_glb_url(
    slug: str,
    request: Request,
    identity: RequestIdentity | None = Depends(get_optional_current_user),
    share: str | None = Query(default=None),
    db: Session = Depends(get_db_session),
    svc: CollisionService = Depends(_service),
) -> Response:
    """Serve the collision GLB under a ``.glb`` url (official mesh loader)."""
    scope = _readable_scope(db, slug, request, identity, share)
    data, mime = svc.serve_collision_mesh(slug)
    return Response(
        content=data,
        media_type=mime,
        headers={"Cache-Control": build_cache_control(scope, "current/collision")},
    )


@router.get("/{slug}/collision/collision.voxel.json")
def serve_collision_voxel_json(
    slug: str,
    request: Request,
    identity: RequestIdentity | None = Depends(get_optional_current_user),
    share: str | None = Query(default=None),
    db: Session = Depends(get_db_session),
    svc: CollisionService = Depends(_service),
) -> Response:
    """Serve the voxel octree metadata (official ``VoxelCollision`` loader).

    The official viewer derives the binary url by replacing ``.voxel.json``
    with ``.voxel.bin``, taking it to ``/collision/collision.voxel.bin``.
    """
    scope = _readable_scope(db, slug, request, identity, share)
    data, mime = svc.serve_collision_voxel(slug, binary=False)
    return Response(
        content=data,
        media_type=mime,
        headers={"Cache-Control": build_cache_control(scope, "current/collision")},
    )


@router.get("/{slug}/collision/collision.voxel.bin")
def serve_collision_voxel_bin(
    slug: str,
    request: Request,
    identity: RequestIdentity | None = Depends(get_optional_current_user),
    share: str | None = Query(default=None),
    db: Session = Depends(get_db_session),
    svc: CollisionService = Depends(_service),
) -> Response:
    """Serve the voxel leaf octree binary."""
    scope = _readable_scope(db, slug, request, identity, share)
    data, mime = svc.serve_collision_voxel(slug, binary=True)
    return Response(
        content=data,
        media_type=mime,
        headers={"Cache-Control": build_cache_control(scope, "current/collision")},
    )


# ------------------------------------------------------------------ #
# Build collision
# ------------------------------------------------------------------ #

@router.post("/{slug}/collision/build", response_model=CollisionBuildResponse)
def build_collision(
    slug: str,
    body: CollisionAssetCreateRequest,
    identity: RequestIdentity = Depends(require_csrf),
    svc: CollisionService = Depends(_service),
) -> CollisionBuildResponse:
    """Create collision asset and dispatch build job."""
    return svc.create_and_build(slug, body, identity.user_id)


# ------------------------------------------------------------------ #
# Update physics params
# ------------------------------------------------------------------ #

@router.patch("/{slug}/collision", response_model=CollisionAssetOut)
def update_collision(
    slug: str,
    body: CollisionAssetUpdateRequest,
    identity: RequestIdentity = Depends(require_csrf),
    svc: CollisionService = Depends(_service),
) -> CollisionAssetOut:
    """Update collision physics parameters."""
    return svc.update_params(slug, body, identity.user_id)


# ------------------------------------------------------------------ #
# Rebuild
# ------------------------------------------------------------------ #

@router.post("/{slug}/collision/rebuild", response_model=CollisionBuildResponse)
def rebuild_collision(
    slug: str,
    identity: RequestIdentity = Depends(require_csrf),
    svc: CollisionService = Depends(_service),
) -> CollisionBuildResponse:
    """Rebuild collision asset."""
    return svc.rebuild(slug, identity.user_id)
