"""Scene test helpers — create scenes/versions directly in the test DB.

The dev-identity bypass (see conftest) makes the acting user the deterministic
dev user.  Scenes are created straight through the ORM to exercise the
API/permission layers, not the upload pipeline.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from app.core.config import settings
from app.core.identity import _resolve_dev_user_id
from app.db.models.scene import Scene, SceneVersion

if TYPE_CHECKING:
    from sqlalchemy.orm import Session


def create_scene(
    *,
    session: Session,
    owner_id: uuid.UUID | None = None,
    title: str = "测试场景",
    status: str = "PUBLISHED",
    visibility: str = "PUBLIC",
    category: str = "experiment",
    slug: str | None = None,
    with_version: bool = True,
) -> Scene:
    """Create a scene row (and optionally a current version) and commit."""
    owner = owner_id or _resolve_dev_user_id(settings)
    scene = Scene(
        owner_id=owner,
        slug=slug or f"scene-{uuid.uuid4().hex[:8]}",
        title=title,
        description="简介",
        category=category,
        visibility=visibility,
        status=status,
        views=0,
        likes=0,
    )
    session.add(scene)
    session.flush()

    if with_version:
        version = SceneVersion(
            scene_id=scene.id,
            asset_version=uuid.uuid4().hex[:40],
            format="streamed-sog",
            size_bytes=1024 * 1024,
            manifest={"stream": {"counts": [1, 2, 3]}},
        )
        session.add(version)
        session.flush()
        scene.current_version_id = version.id

    session.commit()
    session.refresh(scene)
    return scene
