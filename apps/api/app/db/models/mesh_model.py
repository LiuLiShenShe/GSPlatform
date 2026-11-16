"""Completed, version-bound mesh artifacts owned independently of live jobs."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKey, Index, String, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class MeshModel(Base):
    __tablename__ = "mesh_models"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id"), nullable=False)
    scene_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("scenes.id"), nullable=False)
    source_version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("scene_versions.id"), nullable=False
    )
    job_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("jobs.id"), unique=True)
    title: Mapped[str] = mapped_column(String(240), nullable=False)
    algorithm: Mapped[Literal["nksr", "2dgs-tsdf"]] = mapped_column(String(20), nullable=False)
    units: Mapped[Literal["m", "scene"]] = mapped_column(String(10), nullable=False)
    vertices: Mapped[int] = mapped_column(BigInteger, nullable=False)
    faces: Mapped[int] = mapped_column(BigInteger, nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(600), nullable=False, unique=True)
    provenance: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("algorithm IN ('nksr','2dgs-tsdf')", name="algorithm_valid"),
        CheckConstraint("units IN ('m','scene')", name="units_valid"),
        CheckConstraint("vertices > 0 AND faces > 0 AND size_bytes > 0", name="geometry_valid"),
        Index("ix_mesh_models_owner_created", "owner_id", "created_at", "id"),
    )
