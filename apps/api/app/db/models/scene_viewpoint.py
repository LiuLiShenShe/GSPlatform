"""Scene Viewpoint model — saved camera positions for scene navigation.

Each viewpoint is an independent named camera pose, separate from the initial view.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SceneViewpoint(Base):
    __tablename__ = "scene_viewpoints"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4
    )
    scene_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("scenes.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    position: Mapped[dict[str, float]] = mapped_column(JSONB, nullable=False)
    target: Mapped[dict[str, float]] = mapped_column(JSONB, nullable=False)
    fov: Mapped[float] = mapped_column(nullable=False)
    order_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    __table_args__ = (
        Index("ix_scene_viewpoints_scene_order", "scene_id", "order_index"),
        Index("ix_scene_viewpoints_scene_id", "scene_id"),
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<SceneViewpoint id={self.id} scene={self.scene_id} name={self.name!r}>"
