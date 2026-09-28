"""Scene runtime descriptor endpoint (SSV-01).

Routes:
  GET /{scene_id}/runtime — unified runtime scene contract (SceneRuntimeDescriptorV1)
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.identity import RequestIdentity, get_optional_current_user
from app.db.session import get_db_session
from app.schemas.scene_runtime import SceneRuntimeDescriptorV1
from app.services.scene_runtime import SceneRuntimeService

router = APIRouter()


def _service(db: Session = Depends(get_db_session)) -> SceneRuntimeService:
    return SceneRuntimeService(db)


@router.get("/{scene_id}/runtime", response_model=SceneRuntimeDescriptorV1)
def get_scene_runtime(
    scene_id: str,
    identity: RequestIdentity | None = Depends(get_optional_current_user),
    svc: SceneRuntimeService = Depends(_service),
) -> SceneRuntimeDescriptorV1:
    """Unified runtime descriptor for a scene.

    Reuses the scene read access rules: owner or PUBLIC+PUBLISHED/READY → 200;
    private scene for anonymous → 401; private scene for other user → 403;
    missing scene → 404. This is the single contract every Viewer runtime
    (Desktop / XR / Share) must consume — no per-surface scene assembly.
    """
    return svc.get_descriptor(scene_id, identity)
