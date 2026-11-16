"""Immutable successful GLB derivations, with retryable fenced CPU executions."""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Uuid,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class MeshAssetVariant(Base):
    __tablename__ = "mesh_asset_variants"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    mesh_model_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("mesh_models.id"), nullable=False, index=True
    )
    recipe_key: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    source_ply_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    format: Mapped[str] = mapped_column(String(10), default="glb", nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="QUEUED", nullable=False)
    rotation: Mapped[list] = mapped_column(JSONB, nullable=False)
    orientation_evidence: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    converter_version: Mapped[str] = mapped_column(String(100), nullable=False)
    transform_version: Mapped[str] = mapped_column(String(100), nullable=False)
    storage_key: Mapped[str | None] = mapped_column(String(700), unique=True)
    sha256: Mapped[str | None] = mapped_column(String(64))
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    result: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    error_code: Mapped[str | None] = mapped_column(String(50))
    generation: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        CheckConstraint("status IN ('QUEUED','RUNNING','READY','FAILED')", name="status_valid"),
        CheckConstraint("format = 'glb'", name="format_valid"),
    )
