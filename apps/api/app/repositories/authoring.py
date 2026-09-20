"""Scene presentation & viewpoint repository — pure SQLAlchemy queries."""

from __future__ import annotations

import uuid

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.db.models.scene_presentation import ScenePresentation
from app.db.models.scene_viewpoint import SceneViewpoint


class ScenePresentationRepository:
    """One-to-one presentation row per scene."""

    def __init__(self, session: Session) -> None:
        self._session = session

    def get_by_scene(self, scene_id: uuid.UUID) -> ScenePresentation | None:
        return self._session.execute(
            select(ScenePresentation).where(ScenePresentation.scene_id == scene_id)
        ).scalar_one_or_none()

    def get_by_scene_or_create(self, scene_id: uuid.UUID) -> ScenePresentation:
        row = self.get_by_scene(scene_id)
        if row is not None:
            return row
        row = ScenePresentation(scene_id=scene_id)
        self._session.add(row)
        self._session.flush()
        return row

    def delete_by_scene(self, scene_id: uuid.UUID) -> None:
        self._session.execute(
            update(ScenePresentation)
            .where(ScenePresentation.scene_id == scene_id)
            .values(background_asset_id=None, cover_asset_id=None)
        )


class SceneViewpointRepository:
    """Ordered viewpoints per scene."""

    def __init__(self, session: Session) -> None:
        self._session = session

    def list_by_scene(self, scene_id: uuid.UUID) -> list[SceneViewpoint]:
        return list(
            self._session.execute(
                select(SceneViewpoint)
                .where(SceneViewpoint.scene_id == scene_id)
                .order_by(SceneViewpoint.order_index.asc(), SceneViewpoint.created_at.asc())
            ).scalars()
        )

    def get(self, viewpoint_id: uuid.UUID) -> SceneViewpoint | None:
        return self._session.get(SceneViewpoint, viewpoint_id)

    def get_by_scene(self, scene_id: uuid.UUID, viewpoint_id: uuid.UUID) -> SceneViewpoint | None:
        return self._session.execute(
            select(SceneViewpoint).where(
                SceneViewpoint.scene_id == scene_id,
                SceneViewpoint.id == viewpoint_id,
            )
        ).scalar_one_or_none()

    def next_order_index(self, scene_id: uuid.UUID) -> int:
        row = self._session.execute(
            select(SceneViewpoint.order_index)
            .where(SceneViewpoint.scene_id == scene_id)
            .order_by(SceneViewpoint.order_index.desc())
            .limit(1)
        ).scalar_one_or_none()
        return (row or 0) + 1

    def add(self, viewpoint: SceneViewpoint) -> SceneViewpoint:
        self._session.add(viewpoint)
        self._session.flush()
        return viewpoint

    def delete(self, viewpoint: SceneViewpoint) -> None:
        self._session.delete(viewpoint)
        self._session.flush()
