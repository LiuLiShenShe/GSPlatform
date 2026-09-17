"""ShareLink model — revocable, expiring shares of non-public scenes.

Only ``token_hash`` is stored; the raw share token is returned exactly once
at creation and never written to logs.  ``expires_at`` / ``revoked_at`` are
enforced at resolution time (API + asset access layer).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ShareLink(Base):
    __tablename__ = "share_links"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4
    )
    scene_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("scenes.id"), nullable=False, index=True
    )
    owner_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id"), nullable=False
    )
    # sha256 of the raw share token (never stored, never logged).
    token_hash: Mapped[str] = mapped_column(
        String(64), unique=True, index=True, nullable=False
    )
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        # Fast owner listing ("manage my shares for this scene").
        Index("ix_share_links_scene_created", "scene_id", "created_at"),
    )

    def __repr__(self) -> str:  # pragma: no cover - debug aid
        return f"<ShareLink id={self.id} scene={self.scene_id}>"
