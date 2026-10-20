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

# Business URL prefix for scene assets. FIX-01: private assets are NO LONGER a
# public static path (/local-scenes was an unauthenticated Nginx alias). All
# scene bytes go through the authorized API endpoint, which in production
# hands the file to Nginx via X-Accel-Redirect. Never a server filesystem path.
SCENE_ASSET_BASE = "/api/v1/scenes/{slug}/assets"


def _scene_asset_url(slug: str, rel: str) -> str:
    return f"{SCENE_ASSET_BASE.format(slug=slug)}/{rel.lstrip('/')}"


def resolve_poster_url(session: Session, scene: Scene, version: object | None) -> str | None:
    """场景封面的**真实可服务 URL**，没有封面则 ``None``。

    与 ``SceneRuntimeService._resolve_poster_url`` 同一份实现（作品列表与运行时
    描述符必须给出同一个答案，否则同一个场景在列表里是裂图、在看详情页时又能显示）。

    优先级：
      1. 作者上传的封面（``presentations.cover_asset_id``，存储在
         ``presentation/<scene>/cover``）→ ``/{slug}/presentation/cover``；
      2. 当前版本的发布清单自带 poster（Asset kind=POSTER）→ ``assets/poster.webp``；
      3. 都没有 → ``None``。

    历史行为是无条件发出 ``assets/poster.webp``：该路径对**任何**场景都不存在
    （封面在 ``presentation/<scene>/cover``），于是全站封面恒为 404。
    """
    from app.db.models.asset import Asset
    from app.db.models.enums import AssetKind
    from app.db.models.scene_presentation import ScenePresentation

    cover_asset_id = (
        session.query(ScenePresentation.cover_asset_id)
        .filter(ScenePresentation.scene_id == scene.id)
        .scalar()
    )
    if cover_asset_id is not None:
        return f"/api/v1/scenes/{scene.slug}/presentation/cover"
    if version is None:
        return None
    has_poster = (
        session.query(Asset.id)
        .filter(
            Asset.scene_id == scene.id,
            Asset.version_id == version.id,  # type: ignore[attr-defined]
            Asset.kind == AssetKind.POSTER.value,
        )
        .first()
    )
    if has_poster is None:
        return None
    return _scene_asset_url(scene.slug, "poster.webp")


def _summary_from_scene(
    session: Session,
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
        posterUrl=resolve_poster_url(session, scene, version),
        manifestUrl=manifest_url,
        publishedAt=scene.published_at,
        updatedAt=scene.updated_at,
        # GS-NEXT-10: the owner works list needs to tell a soft-deleted scene
        # (recoverable from the recycle bin) from a missing one.
        isDeleted=scene.deleted_at is not None,
        isFavorited=is_favorited,
        favoriteCount=favorite_count,
        shareCount=share_count,
    )


def _detail_from_scene(
    session: Session,
    scene: Scene,
    *,
    is_favorited: bool = False,
    favorite_count: int | None = None,
    share_count: int | None = None,
) -> SceneDetailOut:
    summary = _summary_from_scene(
        session,
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
        # Kept for the unified access policy (FIX-01); the repository is the
        # only query surface, but the policy needs the session for share-token
        # validation.
        self._session = session
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
                _summary_from_scene(self._session, s, is_favorited=s.id in fav_ids)
                for s in items
            ],
            meta=PageMeta(limit=limit, nextCursor=next_cursor),
        )

    def get_public_detail(self, slug: str) -> SceneDetailOut:
        """Fetch a single visible, published scene by slug; else 404."""
        scene = self._repo.get_public_by_slug(slug)
        if scene is None:
            raise NotFoundError(f"场景 {slug} 不存在或不可见")
        return _detail_from_scene(self._session, scene)

    def resolve_detail(
        self, slug: str, identity: RequestIdentity | None
    ) -> SceneDetailOut:
        """Resolve scene detail through the unified access policy (FIX-01).

        - PUBLIC + PUBLISHED + not deleted → detail for everyone.
        - Otherwise the single policy decides: owner (any non-deleted own
          scene) → detail; a live share token → detail; exists but private →
          401 (anonymous) / 403 (other user); deleted or missing → 404.

        A deleted scene is invisible to its owner too — before FIX-01 the bare
        ``get_by_slug`` fallback still returned detail for a soft-deleted
        scene to whoever owned it (P1-2).
        """
        from app.services.scene_access import SceneAccessPolicy

        public = self._repo.get_public_by_slug(slug)
        if public is not None:
            fav = (
                identity is not None
                and self._repo.is_favorited(identity.user_id, public.id)
            )
            return _detail_from_scene(self._session, public, is_favorited=fav)

        user_id = identity.user_id if identity is not None else None
        scene = SceneAccessPolicy(self._session).resolve_readable_for_user(
            slug, user_id
        )
        fav = identity is not None and self._repo.is_favorited(identity.user_id, scene.id)
        return _detail_from_scene(self._session, scene, is_favorited=fav)

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
        include_deleted: bool = False,
    ) -> SceneListPage:
        items, next_cursor = self._repo.list_owner(
            owner_id,
            limit=limit,
            cursor=cursor,
            status_filter=status_filter,
            search=search,
            sort=sort,
            include_deleted=include_deleted,
        )
        return SceneListPage(
            items=[_summary_from_scene(self._session, s) for s in items],
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
        if scene.deleted_at is not None:
            raise ConflictError("场景已删除，无法归档")
        if scene.status not in ("PUBLISHED", "READY"):
            raise ConflictError(f"状态 {scene.status} 不允许归档")
        # GS-NEXT-10: remember the exact pre-archive status so restore can put
        # the scene back where it was instead of forcing PUBLISHED.
        scene.archived_from_status = scene.status
        scene.status = SceneStatus.ARCHIVED.value
        # GS-NEXT-10: commit before returning. The request-scoped session commits
        # in its dependency teardown, which runs *after* the response is sent —
        # a client that immediately issues the next call (archive → restore)
        # would otherwise still read the pre-archive row and get a bogus 409.
        self._repo.commit()

    def restore_scene(self, *, owner_id: uuid.UUID, slug: str) -> None:
        """Restore an archived **or** soft-deleted scene (GS-NEXT-10).

        - soft-deleted (``deleted_at`` set) → clear the marker; the row keeps
          whatever status it had, so a deleted PUBLISHED scene comes back
          PUBLISHED;
        - archived → return to ``archived_from_status`` (PUBLISHED/READY), never
          a blanket PUBLISHED.

        Both paths are owner-gated; a scene that is neither archived nor
        deleted is still a 409, so the endpoint stays idempotent-safe.
        """
        scene = self._repo.get_by_slug(slug)
        if scene is None:
            raise NotFoundError(f"场景 {slug} 不存在")
        if scene.owner_id != owner_id:
            raise ForbiddenError("只有场景所有者可以恢复")

        if scene.deleted_at is not None:
            scene.deleted_at = None
            self._repo.commit()
            return

        if scene.status != SceneStatus.ARCHIVED.value:
            raise ConflictError("场景不在已归档或已删除状态，无法恢复")

        scene.status = scene.archived_from_status or SceneStatus.PUBLISHED.value
        scene.archived_from_status = None
        self._repo.commit()

    def soft_delete_scene(self, *, owner_id: uuid.UUID, slug: str) -> None:
        """Soft-delete a scene.  Refuses if active jobs exist.

        Only the ``deleted_at`` marker is written: the row, its SceneVersions
        and every published asset stay exactly where they are (GS-NEXT-10 —
        recovery depends on nothing having been destroyed).
        """
        scene = self._repo.get_by_slug(slug)
        if scene is None:
            raise NotFoundError(f"场景 {slug} 不存在")
        if scene.owner_id != owner_id:
            raise ForbiddenError("只有场景所有者可以删除")
        if scene.deleted_at is not None:
            # Already in the recycle bin — treat as success, do not touch jobs.
            self._repo.commit()
            return
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
        self._repo.commit()
