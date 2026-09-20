"""Scene Presentation model — camera, transform, background, cover settings.

One-to-one with Scene; stores all authoring state for the scene viewer.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import DateTime, ForeignKey, String, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

if TYPE_CHECKING:
    pass


class ScenePresentation(Base):
    __tablename__ = "scene_presentations"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4
    )
    scene_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("scenes.id", ondelete="CASCADE"), unique=True, nullable=False
    )

    # World transform (does NOT modify the original SOG file)
    world_position: Mapped[dict[str, float] | None] = mapped_column(
        JSONB, nullable=True
    )
    world_rotation: Mapped[dict[str, float] | None] = mapped_column(
        JSONB, nullable=True
    )
    world_scale: Mapped[dict[str, float] | None] = mapped_column(
        JSONB, nullable=True
    )

    # Initial camera view
    initial_camera_position: Mapped[dict[str, float] | None] = mapped_column(
        JSONB, nullable=True
    )
    initial_camera_target: Mapped[dict[str, float] | None] = mapped_column(
        JSONB, nullable=True
    )
    initial_camera_fov: Mapped[float | None] = mapped_column(nullable=True)

    # Background
    background_type: Mapped[str] = mapped_column(
        String(20), nullable=False, default="color"
    )  # 'color' | 'equirectangular'
    background_color: Mapped[dict[str, float] | None] = mapped_column(
        JSONB, nullable=True
    )
    background_asset_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("assets.id", ondelete="SET NULL"), nullable=True
    )
    # Latitude/longitude metadata for panoramic backgrounds (API reserve)
    background_metadata: Mapped[dict[str, Any] | None] = mapped_column(
        JSONB, nullable=True
    )

    # Cover
    cover_asset_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("assets.id", ondelete="SET NULL"), nullable=True
    )

    # Background audio
    background_audio_asset_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("assets.id", ondelete="SET NULL"), nullable=True
    )
    background_audio_volume: Mapped[float] = mapped_column(
        nullable=False, default=0.5
    )
    background_audio_loop: Mapped[bool] = mapped_column(
        nullable=False, default=True
    )
    background_audio_enabled: Mapped[bool] = mapped_column(
        nullable=False, default=False
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<ScenePresentation scene={self.scene_id}>"
