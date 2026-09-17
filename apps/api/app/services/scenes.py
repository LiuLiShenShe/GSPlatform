"""Scene service — use cases, permission checks and DTO assembly.

Router → service → repository: the service owns domain conflicts and which
rows are visible to whom; repositories only query. No raw ORM objects are
returned to HTTP layers here.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.core.errors import ConflictError, ForbiddenError, NotFoundError
from app.core.identity import RequestIdentity
from app.db.models.enums import SceneCategory, SceneStatus, Visibility
from app.db.models.scene import Scene
from app.repositories.scenes import SceneRepository
from app.schemas.common import PageMeta
from app.schemas.scene import SceneAuthor, SceneDetailOut, SceneListPage, SceneSummaryOut

# Business URL prefix for scene assets, produced by the serving layer (Vite dev
# middleware or Nginx scenes-streaming.conf). Never a server filesystem path.
SCENE_ASSET_BASE = "/local-scenes/{slug}"


def _scene_asset_url(slug: str, rel: str) -> str:
    return f"{SCENE_ASSET_BASE.format(slug=slug)}/{rel.lstrip('/')}"


def _summary_from_scene(
    scene: Scene,
    *,
    is_favorited: bool = False,
    favorite_count: int | None = None,
    share_count: int | None = None,
) -> SceneSummaryOut:
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
        isFavorited=is_favorited,
        favoriteCount=favorite_count,
        shareCount=share_count,
    )


def _detail_from_scene(
    scene: Scene,
    *,
    is_favorited: bool = False,
    favorite_count: int | None = None,
    share_count: int | None = None,
) -> SceneDetailOut:
    summary = _summary_from_scene(
        scene,
        is_favorited=is_favorited,
        favorite_count=favorite_count,
        share_count=share_count,
    )
    return SceneDetailOut(
        **summary.model_dump(by_alias=True, exclude_none=True),
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
        user_id: uuid.UUID | None = None,
    ) -> SceneListPage:
        items, next_cursor = self._repo.list_public(
            limit=limit, cursor=cursor, category=category, sort=sort
        )
        if user_id is not None and items:
            fav_ids = self._repo.favorite_ids(user_id, [s.id for s in items])
        else:
            fav_ids = set()
        return SceneListPage(
            items=[
                _summary_from_scene(s, is_favorited=s.id in fav_ids)
                for s in items
            ],
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
            fav = False
            if identity is not None:
                fav = self._repo.is_favorited(identity.user_id, scene.id)
            return _detail_from_scene(scene, is_favorited=fav)

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
            if identity is not None and identity.user_id == internal.owner_id:
                fav = self._repo.is_favorited(identity.user_id, internal.id)
                return _detail_from_scene(internal, is_favorited=fav)
            raise ForbiddenError("该场景不可见或未发布")

        raise NotFoundError(f"场景 {slug} 不存在")

    def increment_views(self, slug: str) -> None:
        """Increment view counter (best-effort, not called for owners)."""
        scene = self._repo.get_public_by_slug(slug)
        if scene is not None:
            scene.views = (scene.views or 0) + 1
            self._repo.flush()

    def list_owner(
        self,
        owner_id: uuid.UUID,
        *,
        limit: int = 20,
        cursor: str | None = None,
        status_filter: str | None = None,
        search: str | None = None,
        sort: str = "updated",
    ) -> SceneListPage:
        items, next_cursor = self._repo.list_owner(
            owner_id,
            limit=limit,
            cursor=cursor,
            status_filter=status_filter,
            search=search,
            sort=sort,
        )
        return SceneListPage(
            items=[_summary_from_scene(s) for s in items],
            meta=PageMeta(limit=limit, nextCursor=next_cursor),
        )

    # ------------------------------------------------------------------
    # owner mutations
    # ------------------------------------------------------------------
    def update_scene(
        self,
        *,
        owner_id: uuid.UUID,
        slug: str,
        title: str | None = None,
        description: str | None = None,
        category: str | None = None,
        visibility: str | None = None,
        expected_updated_at: datetime | None = None,
    ) -> Scene:
        """Edit a scene.  Optimistic concurrency via expected_updated_at."""
        scene = self._repo.get_by_slug(slug)
        if scene is None:
            raise NotFoundError(f"场景 {slug} 不存在")
        if scene.owner_id != owner_id:
            raise ForbiddenError("只有场景所有者可以编辑")

        # Optimistic concurrency check (409 if stale).
        if expected_updated_at is not None and scene.updated_at is not None:
            if scene.updated_at.replace(tzinfo=None) != expected_updated_at.replace(tzinfo=None):
                raise ConflictError("场景已被其他标签页修改，请刷新后重试")

        if title is not None:
            if len(title.strip()) > 200 or not title.strip():
                raise ConflictError("标题长度必须在 1-200 之间")
            scene.title = title.strip()
        if description is not None:
            scene.description = description.strip()[:2000] if description.strip() else None
        if category is not None:
            if category not in {c.value for c in SceneCategory}:
                raise ConflictError(f"无效分类: {category}")
            scene.category = category
        if visibility is not None:
            if visibility not in {v.value for v in Visibility}:
                raise ConflictError(f"无效可见性: {visibility}")
            scene.visibility = visibility

        self._repo.flush()
        return scene

    def archive_scene(self, *, owner_id: uuid.UUID, slug: str) -> None:
        scene = self._repo.get_by_slug(slug)
        if scene is None:
            raise NotFoundError(f"场景 {slug} 不存在")
        if scene.owner_id != owner_id:
            raise ForbiddenError("只有场景所有者可以归档")
        if scene.status not in ("PUBLISHED", "READY"):
            raise ConflictError(f"状态 {scene.status} 不允许归档")
        scene.status = SceneStatus.ARCHIVED.value
        self._repo.flush()

    def restore_scene(self, *, owner_id: uuid.UUID, slug: str) -> None:
        scene = self._repo.get_by_slug(slug)
        if scene is None:
            raise NotFoundError(f"场景 {slug} 不存在")
        if scene.owner_id != owner_id:
            raise ForbiddenError("只有场景所有者可以恢复")
        if scene.status != SceneStatus.ARCHIVED.value:
            raise ConflictError("场景不在已归档状态，无法恢复")
        scene.status = SceneStatus.PUBLISHED.value
        self._repo.flush()

    def soft_delete_scene(self, *, owner_id: uuid.UUID, slug: str) -> None:
        """Soft-delete a scene.  Refuses if active jobs exist."""
        scene = self._repo.get_by_slug(slug)
        if scene is None:
            raise NotFoundError(f"场景 {slug} 不存在")
        if scene.owner_id != owner_id:
            raise ForbiddenError("只有场景所有者可以删除")
        from sqlalchemy import select

        from app.db.models.job import Job

        active = self._repo.session.execute(
            select(Job.id).where(
                Job.scene_id == scene.id,
                Job.status.in_(["QUEUED", "RUNNING", "CANCEL_REQUESTED"]),
            )
        ).scalars().first()
        if active is not None:
            raise ConflictError("场景仍有正在运行的任务，无法删除")

        scene.deleted_at = datetime.now(UTC)
        self._repo.flush()
