"""CollisionAsset model — collision proxy mesh for walkable scenes (Phase 12).

Stores collision GLB metadata per scene. Two modes: INDOOR / OUTDOOR.
The collision mesh itself is stored as an Asset of kind COLLISION_GLB.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    String,
    Uuid,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

if TYPE_CHECKING:
    pass


class CollisionAsset(Base):
    __tablename__ = "collision_assets"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4
    )
    scene_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("scenes.id", ondelete="CASCADE"), nullable=False
    )
    mode: Mapped[str] = mapped_column(
        String(20), nullable=False
    )  # INDOOR | OUTDOOR

    # Asset reference to the collision GLB
    asset_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("assets.id", ondelete="SET NULL"), nullable=True
    )

    # Job reference
    job_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("jobs.id", ondelete="SET NULL"), nullable=True
    )

    # Build status
    status: Mapped[str] = mapped_column(
        String(30), nullable=False, default="NONE"
    )  # NONE | QUEUED | RUNNING | SUCCEEDED | FAILED

    # Physics parameters
    gravity: Mapped[float] = mapped_column(Float, nullable=False, default=9.81)
    slope_limit_degrees: Mapped[float] = mapped_column(Float, nullable=False, default=45.0)
    step_offset: Mapped[float] = mapped_column(Float, nullable=False, default=0.3)
    player_height: Mapped[float] = mapped_column(Float, nullable=False, default=1.8)

    # Build parameters (JSON)
    build_params: Mapped[dict[str, Any] | None] = mapped_column(
        JSONB, nullable=True
    )

    # Error tracking
    error_message: Mapped[str | None] = mapped_column(
        String(1000), nullable=True
    )

    # Rebuild tracking
    attempt: Mapped[int] = mapped_column(
        Float, nullable=False, default=0
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

    __table_args__ = (
        CheckConstraint(
            "mode IN ('INDOOR', 'OUTDOOR')",
            name="collision_mode_valid",
        ),
        CheckConstraint(
            "status IN ('NONE', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')",
            name="collision_status_valid",
        ),
        CheckConstraint(
            "gravity >= 0",
            name="collision_gravity_non_negative",
        ),
        CheckConstraint(
            "slope_limit_degrees BETWEEN 0 AND 90",
            name="collision_slope_range",
        ),
        CheckConstraint(
            "step_offset >= 0",
            name="collision_step_non_negative",
        ),
        CheckConstraint(
            "player_height > 0",
            name="collision_height_positive",
        ),
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<CollisionAsset scene={self.scene_id} mode={self.mode!r} status={self.status!r}>"
