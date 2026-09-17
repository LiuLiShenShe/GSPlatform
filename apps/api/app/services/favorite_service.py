"""Favorite service — idempotent add/remove, visibility-checked reads."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import NotFoundError
from app.db.models.favorite import Favorite
from app.db.models.scene import Scene
from app.schemas.scene import SceneSummaryOut
from app.services.scenes import _summary_from_scene


class FavoriteService:
    def __init__(self, db: Session) -> None:
        self._db = db

    # ------------------------------------------------------------------
    def add_favorite(self, user_id: uuid.UUID, scene_slug: str) -> bool:
        """Add a favorite.  Idempotent: returns True if newly added, False if
        already favorited.  Raises NotFoundError if the scene is not visible
        or does not exist."""
        scene = self._get_visible_scene(scene_slug, user_id)

        if scene is None:
            raise NotFoundError(f"场景 {scene_slug} 不存在或不可收藏")

        existing = self._db.execute(
            select(Favorite).where(
                Favorite.user_id == user_id, Favorite.scene_id == scene.id
            )
        ).scalar_one_or_none()
        if existing is not None:
            return False  # idempotent no-op

        self._db.add(Favorite(user_id=user_id, scene_id=scene.id))
        self._db.flush()
        return True

    def remove_favorite(self, user_id: uuid.UUID, scene_slug: str) -> bool:
        """Remove a favorite.  Idempotent: returns True if removed, False if
        not currently favorited."""
        scene = self._get_visible_scene(scene_slug, user_id)
        if scene is None:
            return False
        existing = self._db.execute(
            select(Favorite).where(
                Favorite.user_id == user_id, Favorite.scene_id == scene.id
            )
        ).scalar_one_or_none()
        if existing is None:
            return False  # idempotent no-op

        self._db.delete(existing)
        self._db.flush()
        return True

    def is_favorited(self, user_id: uuid.UUID, scene_slug: str) -> bool:
        scene = self._get_visible_scene(scene_slug, user_id)
        if scene is None:
            return False
        return self._is_relation(user_id, scene.id)

    def _is_relation(self, user_id: uuid.UUID, scene_id: uuid.UUID) -> bool:
        return self._db.execute(
            select(Favorite).where(
                Favorite.user_id == user_id, Favorite.scene_id == scene_id
            )
        ).scalar_one_or_none() is not None

    def list_favorited(self, user_id: uuid.UUID) -> list[SceneSummaryOut]:
        """List favorited scenes the user can still see (privatized/deleted
        scenes are excluded — no leak through the favorites list)."""
        rows = self._db.execute(
            select(Scene, Favorite.created_at)
            .join(Favorite, Favorite.scene_id == Scene.id)
            .where(
                Favorite.user_id == user_id,
                Scene.deleted_at.is_(None),
            )
            .order_by(Favorite.created_at.desc())
        ).all()
        return [_summary_from_scene(scene) for scene, _ in rows]

    # ------------------------------------------------------------------
    def favorite_ids(self, user_id: uuid.UUID, scene_ids: list[uuid.UUID]) -> set[uuid.UUID]:
        """Return the subset of *scene_ids* that are favorited by the user."""
        if not scene_ids:
            return set()
        rows = self._db.execute(
            select(Favorite.scene_id).where(
                Favorite.user_id == user_id,
                Favorite.scene_id.in_(scene_ids),
            )
        ).scalars().all()
        return set(rows)

    def _get_visible_scene(
        self, slug: str, user_id: uuid.UUID
    ) -> Scene | None:
        """Visible scene for favoriting: public+published, or own scene."""
        scene = self._db.execute(
            select(Scene).where(Scene.slug == slug).limit(1)
        ).scalar_one_or_none()
        if scene is None:
            raise NotFoundError(f"场景 {slug} 不存在")
        if scene.status == "PUBLISHED" and (
            scene.visibility == "PUBLIC" or scene.owner_id == user_id
        ):
            return scene
        raise NotFoundError(f"场景 {slug} 不存在或不可收藏")
