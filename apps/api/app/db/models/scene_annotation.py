"""Scene Annotation model — 3D hotspots anchored to Gaussian surface positions.

Each annotation stores a world-space anchor (x/y/z) picked from the Gaussian
point cloud, a display style, content type, optional media reference, and
rendering parameters (color, size, FOV).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SceneAnnotation(Base):
    __tablename__ = "scene_annotations"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4
    )
    scene_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("scenes.id", ondelete="CASCADE"), nullable=False
    )

    # Content
    title: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    description: Mapped[str] = mapped_column(String(5000), nullable=False, default="")

    # Anchor — world-space position on the Gaussian surface
    anchor_x: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    anchor_y: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    anchor_z: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)

    # Style: LEADER_TEXT | NUMBER_POPUP | HIDDEN
    style: Mapped[str] = mapped_column(
        String(30), nullable=False, default="LEADER_TEXT"
    )

    # Content type: TEXT | IMAGE | VIDEO | AUDIO | PANORAMA
    content_type: Mapped[str] = mapped_column(
        String(20), nullable=False, default="TEXT"
    )

    # Text content (for TEXT type or description overlay)
    text_content: Mapped[str] = mapped_column(String(10000), nullable=False, default="")

    # Media asset reference (for IMAGE / VIDEO / AUDIO / PANORAMA)
    media_asset_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("assets.id", ondelete="SET NULL"), nullable=True
    )

    # Rendering params
    text_color: Mapped[str] = mapped_column(
        String(20), nullable=False, default="#FFFFFF"
    )
    text_size: Mapped[int] = mapped_column(Integer, nullable=False, default=14)
    fov: Mapped[float] = mapped_column(Float, nullable=False, default=60.0)

    # Ordering & visibility
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
        Index("ix_scene_annotations_scene_order", "scene_id", "order_index"),
        Index("ix_scene_annotations_scene_id", "scene_id"),
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<SceneAnnotation id={self.id} scene={self.scene_id} style={self.style!r}>"
