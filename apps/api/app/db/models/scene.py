"""Scene and SceneVersion models.

Core catalog entity plus immutable asset versions. A scene has exactly one
``current_version_id`` at any time; versions themselves are never mutated.
Soft delete via ``deleted_at`` hides rows from default public queries.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    Uuid,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.models.enums import SceneCategory, SceneStatus, Visibility

if TYPE_CHECKING:
    from app.db.models.user import User


class Scene(Base):
    __tablename__ = "scenes"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4
    )
    owner_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id"), nullable=False
    )
    slug: Mapped[str] = mapped_column(
        String(120), unique=True, index=True, nullable=False
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    category: Mapped[str] = mapped_column(String(40), nullable=False)
    visibility: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    current_version_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("scene_versions.id"), nullable=True
    )

    # Presentation/catalog stats (denormalized counters, mutable).
    splat_count: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    views: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    likes: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
    published_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    owner: Mapped[User] = relationship(foreign_keys=[owner_id], lazy="joined")
    current_version: Mapped[SceneVersion | None] = relationship(
        foreign_keys=[current_version_id], lazy="joined"
    )
    versions: Mapped[list[SceneVersion]] = relationship(
        back_populates="scene",
        foreign_keys="SceneVersion.scene_id",
        lazy="selectin",
    )

    __table_args__ = (
        CheckConstraint(
            "category IN ('urban', 'architecture', 'interior', 'nature', "
            "'portrait', 'experiment')",
            name="category_valid",
        ),
        CheckConstraint(
            "visibility IN ('PRIVATE', 'UNLISTED', 'PUBLIC')",
            name="visibility_valid",
        ),
        CheckConstraint(
            "status IN ('DRAFT', 'VALIDATING', 'PROCESSING', 'READY', "
            "'PUBLISHED', 'FAILED', 'ARCHIVED')",
            name="status_valid",
        ),
        # Fast public listing: visible + published, newest first.
        Index(
            "ix_scenes_public_list",
            "visibility",
            "status",
            "published_at",
            "id",
        ),
        # Owner listing.
        Index("ix_scenes_owner_status", "owner_id", "status", "updated_at"),
    )

    @property
    def category_enum(self) -> SceneCategory:
        return SceneCategory(self.category)

    @property
    def visibility_enum(self) -> Visibility:
        return Visibility(self.visibility)

    @property
    def status_enum(self) -> SceneStatus:
        return SceneStatus(self.status)

    def __repr__(self) -> str:  # pragma: no cover - debug aid
        return f"<Scene id={self.id} slug={self.slug!r} status={self.status}>"


class SceneVersion(Base):
    __tablename__ = "scene_versions"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4
    )
    scene_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("scenes.id"), nullable=False
    )
    # Content-addressed, immutable version id (e.g. SOG asset sha256 prefix).
    asset_version: Mapped[str] = mapped_column(String(80), nullable=False)
    format: Mapped[str] = mapped_column(String(20), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    manifest: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    scene: Mapped[Scene] = relationship(
        back_populates="versions", foreign_keys=[scene_id]
    )

    __table_args__ = (
        CheckConstraint(
            "format IN ('sog', 'ply', 'splat', 'streamed-sog')",
            name="version_format_valid",
        ),
        # Immutable version: one asset_version per scene.
        CheckConstraint(
            "length(asset_version) BETWEEN 8 AND 80",
            name="asset_version_length_valid",
        ),
        Index(
            "uq_scene_versions_scene_asset",
            "scene_id",
            "asset_version",
            unique=True,
        ),
    )

    def __repr__(self) -> str:  # pragma: no cover - debug aid
        return f"<SceneVersion scene={self.scene_id} asset={self.asset_version}>"
