"""Scene service — use cases, permission checks and DTO assembly.

Router → service → repository: the service owns domain conflicts and which
rows are visible to whom; repositories only query. No raw ORM objects are
returned to HTTP layers here.
"""

from __future__ import annotations

import uuid

from sqlalchemy.orm import Session

from app.core.errors import ForbiddenError, NotFoundError
from app.core.identity import RequestIdentity
from app.db.models.scene import Scene
from app.repositories.scenes import SceneRepository
from app.schemas.common import PageMeta
from app.schemas.scene import SceneAuthor, SceneDetailOut, SceneListPage, SceneSummaryOut

# Business URL prefix for scene assets, produced by the serving layer (Vite dev
# middleware or Nginx scenes-streaming.conf). Never a server filesystem path.
SCENE_ASSET_BASE = "/local-scenes/{slug}"


def _scene_asset_url(slug: str, rel: str) -> str:
    return f"{SCENE_ASSET_BASE.format(slug=slug)}/{rel.lstrip('/')}"


def _summary_from_scene(scene: Scene) -> SceneSummaryOut:
    """Assemble a public summary without touching ORM internals."""
    version = scene.current_version
    size_bytes = scene.size_bytes
    size_mb = round(size_bytes / (1024 * 1024), 1) if size_bytes else None
    manifest_url = (
        _scene_asset_url(scene.slug, "current/manifest.json")
        if version is not None or scene.status in ("READY", "PUBLISHED")
        else None
    )
    return SceneSummaryOut(
        id=scene.slug,
        title=scene.title,
        description=scene.description,
        author=SceneAuthor(id=scene.slug, name=scene.owner.display_name),
        category=scene.category,
        visibility=scene.visibility,
        status=scene.status,
        splatCount=scene.splat_count,
        sizeMB=size_mb,
        views=scene.views,
        likes=scene.likes,
        posterUrl=_scene_asset_url(scene.slug, "poster.webp"),
        manifestUrl=manifest_url,
        publishedAt=scene.published_at,
        updatedAt=scene.updated_at,
    )


def _detail_from_scene(scene: Scene) -> SceneDetailOut:
    summary = _summary_from_scene(scene)
    return SceneDetailOut(**summary.model_dump(by_alias=True, exclude_none=True),
        createdAt=scene.created_at,
        updatedAt=scene.updated_at,
    )


class SceneService:
    """Scene catalogue use cases."""

    def __init__(self, session: Session) -> None:
        self._repo = SceneRepository(session)

    def list_public(
        self,
        *,
        limit: int = 20,
        cursor: str | None = None,
        category: str | None = None,
        sort: str = "latest",
    ) -> SceneListPage:
        items, next_cursor = self._repo.list_public(
            limit=limit, cursor=cursor, category=category, sort=sort
        )
        return SceneListPage(
            items=[_summary_from_scene(s) for s in items],
            meta=PageMeta(limit=limit, nextCursor=next_cursor),
        )

    def get_public_detail(self, slug: str) -> SceneDetailOut:
        """Fetch a single visible, published scene by slug; else 404."""
        scene = self._repo.get_public_by_slug(slug)
        if scene is None:
            raise NotFoundError(f"场景 {slug} 不存在或不可见")
        return _detail_from_scene(scene)

    def resolve_detail(
        self, slug: str, identity: RequestIdentity | None
    ) -> SceneDetailOut:
        """Resolve scene detail with correct 404-vs-403 semantics.

        - Scene exists and is public+published → return detail.
        - Scene exists but is not public/published → 403 (exists, not visible).
        - Scene does not exist at all → 404.
        """
        scene = self._repo.get_public_by_slug(slug)
        if scene is not None:
            return _detail_from_scene(scene)

        # Does the scene exist at all (any status/visibility)?
        internal = self._repo.get_by_slug(slug)
        if internal is None:
            # Maybe slug is actually the internal UUID.
            try:
                scene_uuid = uuid.UUID(slug)
                internal = self._repo.get_by_id(scene_uuid)
            except ValueError:
                internal = None

        if internal is not None:
            if (
                identity is not None
                and identity.user_id == internal.owner_id
            ):
                return _detail_from_scene(internal)
            raise ForbiddenError("该场景不可见或未发布")

        raise NotFoundError(f"场景 {slug} 不存在")

    def list_owner(
        self,
        owner_id: uuid.UUID,
        *,
        limit: int = 20,
        cursor: str | None = None,
        status_filter: str | None = None,
    ) -> SceneListPage:
        items, next_cursor = self._repo.list_owner(
            owner_id, limit=limit, cursor=cursor, status_filter=status_filter
        )
        return SceneListPage(
            items=[_summary_from_scene(s) for s in items],
            meta=PageMeta(limit=limit, nextCursor=next_cursor),
        )
