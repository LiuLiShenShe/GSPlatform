"""Scene runtime descriptor endpoint (SSV-01) — FIX-01 hardened.

Routes:
  GET /{scene_id}/runtime            — unified runtime contract
  GET /{scene_id}/assets/{path}      — authorized asset bytes (gaussian, LOD,
                                       poster, manifest) via unified policy +
                                       production X-Accel-Redirect

The share token may arrive as ``?share=`` on either route or as the
``gs_share`` cookie set by share resolution — so a shared private scene's
descriptor fetch AND the viewer's chunk fetches carry the grant.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.orm import Session
from starlette.responses import FileResponse

from app.core.config import get_settings
from app.core.errors import NotFoundError
from app.core.identity import RequestIdentity, get_optional_current_user
from app.db.session import get_db_session
from app.schemas.scene_runtime import SceneRuntimeDescriptorV1
from app.services.scene_access import SceneAccessPolicy
from app.services.scene_asset import SceneAssetService
from app.services.scene_runtime import SceneRuntimeService

router = APIRouter()


def _service(db: Session = Depends(get_db_session)) -> SceneRuntimeService:
    return SceneRuntimeService(db)


def _share_grant(request: Request, share: str | None) -> str | None:
    """Share grant from the ``?share=`` query or the ``gs_share`` cookie.

    The cookie is set when a visitor resolves ``/shares/resolve/{token}`` so
    that the descriptor fetch *and* every subsequent viewer chunk request
    keep the grant without the token leaking into asset URLs.
    """
    if share:
        return share
    return request.cookies.get(get_settings().share_cookie_name) or None


@router.get("/{scene_id}/runtime", response_model=SceneRuntimeDescriptorV1)
def get_scene_runtime(
    scene_id: str,
    request: Request,
    identity: RequestIdentity | None = Depends(get_optional_current_user),
    share: str | None = Query(default=None),
    svc: SceneRuntimeService = Depends(_service),
) -> SceneRuntimeDescriptorV1:
    """Unified runtime descriptor for a scene.

    Access is the single unified policy (FIX-01): owner or PUBLIC+PUBLISHED
    → 200; a live share token → 200; private scene for anonymous → 401;
    private scene for other user → 403; missing/deleted → 404.
    """
    return svc.get_descriptor(
        scene_id, identity, share_token=_share_grant(request, share)
    )


@router.get("/{scene_id}/assets/{asset_path:path}")
def get_scene_asset(
    scene_id: str,
    asset_path: str,
    request: Request,
    identity: RequestIdentity | None = Depends(get_optional_current_user),
    share: str | None = Query(default=None),
    db: Session = Depends(get_db_session),
) -> Response:
    """Serve one scene asset, authorized by the unified policy.

    Private assets are never reachable through a public static path
    (FIX-01 P0-1): the scene must be readable (owner / public published /
    share token), then the path is containment-checked.  Production hands
    the bytes to Nginx via ``X-Accel-Redirect`` (Range/206/416 untouched);
    dev/test serve a ``FileResponse`` (Starlette's native Range support).
    """
    token = _share_grant(request, share)
    scene = SceneAccessPolicy(db).resolve_readable_scene(
        scene_id, identity, share_token=token
    )
    resolved = SceneAssetService().resolve(scene, asset_path)

    if resolved.x_accel_path is not None:
        # Nginx internal redirect: FastAPI never reads the file body.
        return Response(
            status_code=200,
            headers={
                "X-Accel-Redirect": resolved.x_accel_path,
                "Content-Type": resolved.media_type,
                "Cache-Control": resolved.cache_control,
            },
        )

    absolute = resolved.absolute_path
    if absolute is None:  # pragma: no cover - non-xaccel mode always sets it
        raise NotFoundError("场景资源不存在")
    # FileResponse streams from disk with Starlette's native Range support
    # (206 + Content-Range, 416 when unsatisfiable) — it never buffers the
    # whole gaussian in memory.
    return FileResponse(
        path=absolute,
        media_type=resolved.media_type,
        headers={"Cache-Control": resolved.cache_control},
    )
