"""Asset model — files attached to a scene/version.

``storage_key`` is a server-generated object key (never a user-supplied path)
and is not exposed through public DTOs.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, String, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4
    )
    scene_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("scenes.id"), nullable=False
    )
    version_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("scene_versions.id"), nullable=True
    )
    kind: Mapped[str] = mapped_column(String(30), nullable=False)

    # Server-generated storage key — never a client-provided filesystem path.
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(120), nullable=False)
    byte_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    metadata_: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        Index("ix_assets_scene_kind", "scene_id", "kind"),
        Index("ix_assets_version", "version_id"),
    )
