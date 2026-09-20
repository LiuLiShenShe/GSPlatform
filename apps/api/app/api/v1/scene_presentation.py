"""Scene Presentation, Viewpoints & Annotations endpoints (Phase 10 + 11).

Routes:
  GET    /{slug}/presentation                — read presentation settings
  PATCH  /{slug}/presentation                — update presentation settings (partial)
  POST   /{slug}/presentation/cover          — upload cover image (multipart)
  GET    /{slug}/presentation/cover          — serve cover image
  POST   /{slug}/presentation/background     — upload background image (multipart)
  GET    /{slug}/presentation/background     — serve background image
  GET    /{slug}/presentation/background-audio — serve background audio
  PATCH  /{slug}/presentation/background-audio — update background audio settings
  GET    /{slug}/viewpoints                  — list viewpoints
  POST   /{slug}/viewpoints                  — create viewpoint
  PATCH  /{slug}/viewpoints/reorder          — reorder viewpoints
  PATCH  /{slug}/viewpoints/{id}             — update viewpoint
  DELETE /{slug}/viewpoints/{id}             — delete viewpoint
  GET    /{slug}/annotations                 — list annotations
  POST   /{slug}/annotations                 — create annotation
  PATCH  /{slug}/annotations/reorder         — reorder annotations
  PATCH  /{slug}/annotations/{id}            — update annotation
  DELETE /{slug}/annotations/{id}            — delete annotation
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, File, Form, Response, UploadFile
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.core.identity import (
    RequestIdentity,
    get_optional_current_user,
    require_csrf,
)
from app.db.session import get_db_session
from app.schemas.scene_annotation import (
    SceneAnnotationCreateRequest,
    SceneAnnotationOut,
    SceneAnnotationReorderRequest,
    SceneAnnotationUpdateRequest,
)
from app.schemas.scene_presentation import (
    BackgroundAudioUpdateRequest,
    ScenePresentationOut,
    ScenePresentationUpdateRequest,
    SceneViewpointCreateRequest,
    SceneViewpointOut,
    SceneViewpointReorderRequest,
    SceneViewpointUpdateRequest,
)
from app.services.authoring import AuthoringService
from app.storage import LocalDiskStorage

router = APIRouter()

# Allowed cover / background MIME types.
_COVER_MIME = {"image/jpeg", "image/png", "image/webp"}
_COVER_MAX_BYTES = 10 * 1024 * 1024  # 10 MB


def _storage(settings: Settings = Depends(get_settings)) -> LocalDiskStorage:
    return LocalDiskStorage(settings.storage_root)


def _service(
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
) -> AuthoringService:
    return AuthoringService(db, _storage(settings))


# ------------------------------------------------------------------ #
# Presentation settings
# ------------------------------------------------------------------ #


@router.get("/{slug}/presentation", response_model=ScenePresentationOut)
def get_presentation(
    slug: str,
    identity: RequestIdentity | None = Depends(get_optional_current_user),
    svc: AuthoringService = Depends(_service),
) -> ScenePresentationOut:
    """Read scene presentation settings. Visible to owner; public published scenes readable."""
    return svc.get_presentation(slug, identity.user_id if identity else None)


@router.patch("/{slug}/presentation", response_model=ScenePresentationOut)
def update_presentation(
    slug: str,
    body: ScenePresentationUpdateRequest,
    identity: RequestIdentity = Depends(require_csrf),
    svc: AuthoringService = Depends(_service),
) -> ScenePresentationOut:
    """Owner partial update for scene presentation settings."""
    return svc.update_presentation(slug, identity.user_id, body)


# ------------------------------------------------------------------ #
# Cover asset
# ------------------------------------------------------------------ #

_VALIDATION_ERR = (
    '{"code":"VALIDATION_ERROR","message":"%s"}'
)


@router.post("/{slug}/presentation/cover", response_model=ScenePresentationOut)
async def upload_cover(
    slug: str,
    identity: RequestIdentity = Depends(require_csrf),
    svc: AuthoringService = Depends(_service),
    file: UploadFile = File(...),
) -> ScenePresentationOut:
    """Upload JPG/PNG/WebP cover image."""
    if file.content_type not in _COVER_MIME:
        msg = _VALIDATION_ERR % "仅支持 JPG/PNG/WebP 封面"
        return Response(status_code=422, content=msg.encode())
    data = await file.read()
    if len(data) > _COVER_MAX_BYTES:
        msg = _VALIDATION_ERR % "封面文件不能超过 10MB"
        return Response(status_code=422, content=msg.encode())
    return svc.set_cover_upload(
        slug, identity.user_id, data, file.content_type or "image/jpeg"
    )


@router.get("/{slug}/presentation/cover")
def serve_cover(
    slug: str,
    svc: AuthoringService = Depends(_service),
) -> Response:
    """Serve cover image. No auth required (public)."""
    data, mime = svc.serve_cover(slug)
    return Response(
        content=data,
        media_type=mime,
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


# ------------------------------------------------------------------ #
# Background asset
# ------------------------------------------------------------------ #


@router.post(
    "/{slug}/presentation/background",
    response_model=ScenePresentationOut,
)
async def upload_background(
    slug: str,
    identity: RequestIdentity = Depends(require_csrf),
    svc: AuthoringService = Depends(_service),
    file: UploadFile = File(...),
    latitude: float | None = Form(
        default=None,
        description="Optional latitude for panorama metadata",
    ),
    longitude: float | None = Form(
        default=None,
        description="Optional longitude for panorama metadata",
    ),
) -> ScenePresentationOut:
    """Upload equirectangular panorama background image."""
    if file.content_type not in _COVER_MIME:
        msg = _VALIDATION_ERR % "仅支持 JPG/PNG/WebP 全景背景"
        return Response(status_code=422, content=msg.encode())
    data = await file.read()
    if len(data) > _COVER_MAX_BYTES:
        msg = _VALIDATION_ERR % "背景文件不能超过 10MB"
        return Response(status_code=422, content=msg.encode())
    return svc.set_background_upload(
        slug,
        identity.user_id,
        data,
        file.content_type or "image/jpeg",
        lat=latitude,
        lon=longitude,
    )


@router.get("/{slug}/presentation/background")
def serve_background(
    slug: str,
    svc: AuthoringService = Depends(_service),
) -> Response:
    """Serve background image. No auth required (public)."""
    data, mime = svc.serve_background(slug)
    return Response(
        content=data,
        media_type=mime,
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


# ------------------------------------------------------------------ #
# Viewpoints
# ------------------------------------------------------------------ #


@router.get("/{slug}/viewpoints", response_model=list[SceneViewpointOut])
def list_viewpoints(
    slug: str,
    identity: RequestIdentity | None = Depends(get_optional_current_user),
    svc: AuthoringService = Depends(_service),
) -> list[SceneViewpointOut]:
    """List all viewpoints for a scene. Visible to owner; public published scenes readable."""
    return svc.list_viewpoints(slug, identity.user_id if identity else None)


@router.post(
    "/{slug}/viewpoints",
    response_model=SceneViewpointOut,
    status_code=201,
)
def create_viewpoint(
    slug: str,
    body: SceneViewpointCreateRequest,
    identity: RequestIdentity = Depends(require_csrf),
    svc: AuthoringService = Depends(_service),
) -> SceneViewpointOut:
    """Create a new viewpoint from the given camera pose."""
    return svc.create_viewpoint(slug, identity.user_id, body)


@router.patch(
    "/{slug}/viewpoints/reorder",
    response_model=list[SceneViewpointOut],
)
def reorder_viewpoints(
    slug: str,
    body: SceneViewpointReorderRequest,
    identity: RequestIdentity = Depends(require_csrf),
    svc: AuthoringService = Depends(_service),
) -> list[SceneViewpointOut]:
    """Reorder viewpoints by providing ordered list of viewpoint IDs."""
    return svc.reorder_viewpoints(slug, identity.user_id, body)


@router.patch(
    "/{slug}/viewpoints/{viewpoint_id}",
    response_model=SceneViewpointOut,
)
def update_viewpoint(
    slug: str,
    viewpoint_id: uuid.UUID,
    body: SceneViewpointUpdateRequest,
    identity: RequestIdentity = Depends(require_csrf),
    svc: AuthoringService = Depends(_service),
) -> SceneViewpointOut:
    """Update viewpoint properties (name, pose, FOV, order, enabled)."""
    return svc.update_viewpoint(slug, identity.user_id, str(viewpoint_id), body)


@router.delete("/{slug}/viewpoints/{viewpoint_id}")
def delete_viewpoint(
    slug: str,
    viewpoint_id: uuid.UUID,
    identity: RequestIdentity = Depends(require_csrf),
    svc: AuthoringService = Depends(_service),
) -> dict[str, str]:
    """Delete a viewpoint."""
    svc.delete_viewpoint(slug, identity.user_id, str(viewpoint_id))
    return {"message": "视角已删除"}


# ------------------------------------------------------------------ #
# Background audio
# ------------------------------------------------------------------ #


@router.patch("/{slug}/presentation/background-audio", response_model=ScenePresentationOut)
def update_background_audio(
    slug: str,
    body: BackgroundAudioUpdateRequest,
    identity: RequestIdentity = Depends(require_csrf),
    svc: AuthoringService = Depends(_service),
) -> ScenePresentationOut:
    """Update background audio settings (assetId, volume, loop, enabled)."""
    return svc.update_background_audio(
        slug,
        identity.user_id,
        asset_id=body.assetId,
        volume=body.volume,
        loop=body.loop,
        enabled=body.enabled,
    )


@router.get("/{slug}/presentation/background-audio")
def serve_background_audio(
    slug: str,
    svc: AuthoringService = Depends(_service),
) -> Response:
    """Serve background audio. No auth required (public)."""
    data, mime = svc.serve_background_audio(slug)
    return Response(
        content=data,
        media_type=mime,
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


# ------------------------------------------------------------------ #
# Annotations
# ------------------------------------------------------------------ #


@router.get("/{slug}/annotations", response_model=list[SceneAnnotationOut])
def list_annotations(
    slug: str,
    identity: RequestIdentity | None = Depends(get_optional_current_user),
    svc: AuthoringService = Depends(_service),
) -> list[SceneAnnotationOut]:
    """List all annotations for a scene."""
    return svc.list_annotations(slug, identity.user_id if identity else None)


@router.post(
    "/{slug}/annotations",
    response_model=SceneAnnotationOut,
    status_code=201,
)
def create_annotation(
    slug: str,
    body: SceneAnnotationCreateRequest,
    identity: RequestIdentity = Depends(require_csrf),
    svc: AuthoringService = Depends(_service),
) -> SceneAnnotationOut:
    """Create a new annotation at a Gaussian-picked world position."""
    return svc.create_annotation(slug, identity.user_id, body)


@router.patch(
    "/{slug}/annotations/reorder",
    response_model=list[SceneAnnotationOut],
)
def reorder_annotations(
    slug: str,
    body: SceneAnnotationReorderRequest,
    identity: RequestIdentity = Depends(require_csrf),
    svc: AuthoringService = Depends(_service),
) -> list[SceneAnnotationOut]:
    """Reorder annotations by providing ordered list of annotation IDs."""
    return svc.reorder_annotations(slug, identity.user_id, body)


@router.patch(
    "/{slug}/annotations/{annotation_id}",
    response_model=SceneAnnotationOut,
)
def update_annotation(
    slug: str,
    annotation_id: uuid.UUID,
    body: SceneAnnotationUpdateRequest,
    identity: RequestIdentity = Depends(require_csrf),
    svc: AuthoringService = Depends(_service),
) -> SceneAnnotationOut:
    """Update annotation properties (title, anchor, style, content, etc.)."""
    return svc.update_annotation(slug, identity.user_id, str(annotation_id), body)


@router.delete("/{slug}/annotations/{annotation_id}")
def delete_annotation(
    slug: str,
    annotation_id: uuid.UUID,
    identity: RequestIdentity = Depends(require_csrf),
    svc: AuthoringService = Depends(_service),
) -> dict[str, str]:
    """Delete an annotation."""
    svc.delete_annotation(slug, identity.user_id, str(annotation_id))
    return {"message": "注解已删除"}
