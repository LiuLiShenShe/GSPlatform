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

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.core.identity import RequestIdentity, require_csrf
from app.db.session import get_db_session
from app.schemas.collision import (
    CollisionAssetCreateRequest,
    CollisionAssetOut,
    CollisionAssetUpdateRequest,
    CollisionBuildResponse,
)
from app.services.celery_client import send_task
from app.services.collision import CollisionService
from app.storage import LocalDiskStorage

router = APIRouter()


def _storage(settings: Settings = Depends(get_settings)) -> LocalDiskStorage:
    return LocalDiskStorage(settings.storage_root)


def _service(
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
) -> CollisionService:
    return CollisionService(db, _storage(settings), send_task=send_task)


# ------------------------------------------------------------------ #
# Get collision status
# ------------------------------------------------------------------ #

@router.get("/{slug}/collision", response_model=CollisionAssetOut)
def get_collision(
    slug: str,
    identity: RequestIdentity | None = None,
    svc: CollisionService = Depends(_service),
) -> CollisionAssetOut:
    """Get collision asset status for a scene."""
    return svc.get_collision(slug, identity.user_id if identity else None)


@router.get("/{slug}/collision/mesh")
def serve_collision_mesh(
    slug: str,
    svc: CollisionService = Depends(_service),
) -> Response:
    """Serve the built collision GLB. Public (viewer fetches it directly).

    Kept for the SSV-01 runtime contract. The runtime descriptor now emits the
    ``.glb``-suffixed url (``/collision/collision.glb``) because the official
    viewer selects mesh-vs-voxel by the url extension.
    """
    data, mime = svc.serve_collision_mesh(slug)
    return Response(
        content=data,
        media_type=mime,
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.get("/{slug}/collision/collision.glb")
def serve_collision_glb_url(
    slug: str,
    svc: CollisionService = Depends(_service),
) -> Response:
    """Serve the collision GLB under a ``.glb`` url (official mesh loader)."""
    data, mime = svc.serve_collision_mesh(slug)
    return Response(
        content=data,
        media_type=mime,
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.get("/{slug}/collision/collision.voxel.json")
def serve_collision_voxel_json(
    slug: str,
    svc: CollisionService = Depends(_service),
) -> Response:
    """Serve the voxel octree metadata (official ``VoxelCollision`` loader).

    The official viewer derives the binary url by replacing ``.voxel.json``
    with ``.voxel.bin``, taking it to ``/collision/collision.voxel.bin``.
    """
    data, mime = svc.serve_collision_voxel(slug, binary=False)
    return Response(
        content=data,
        media_type=mime,
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.get("/{slug}/collision/collision.voxel.bin")
def serve_collision_voxel_bin(
    slug: str,
    svc: CollisionService = Depends(_service),
) -> Response:
    """Serve the voxel leaf octree binary."""
    data, mime = svc.serve_collision_voxel(slug, binary=True)
    return Response(
        content=data,
        media_type=mime,
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
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
