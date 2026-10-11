"""Owner-scoped edit audit; content identity stays in immutable SceneVersion."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SceneEditSession(Base):
    __tablename__ = "scene_edit_sessions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    scene_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("scenes.id"), nullable=False)
    owner_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id"), nullable=False)
    source_version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("scene_versions.id"), nullable=False
    )
    source_asset_version: Mapped[str] = mapped_column(String(80), nullable=False)
    source_kind: Mapped[str] = mapped_column(String(30), nullable=False)
    source_entry: Mapped[str] = mapped_column(String(500), nullable=False)
    selected_lod: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source_counts: Mapped[list[int]] = mapped_column(JSONB, nullable=False)
    editor_upstream_commit: Mapped[str] = mapped_column(String(40), nullable=False)
    editor_build_identity: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="CREATED")
    upload_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("upload_sessions.id"), nullable=True, unique=True
    )
    job_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("jobs.id"), nullable=True)
    result_version_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("scene_versions.id"), nullable=True
    )
    result_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(60), nullable=True)
    provenance: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "status IN ('CREATED','OPENED','UPLOADING','UPLOADED','QUEUED','VALIDATING',"
            "'CONVERTING','VERIFYING','PUBLISHING','COMPLETED','FAILED','CANCELLED','EXPIRED')",
            name="status_valid",
        ),
        CheckConstraint(
            "source_kind IN ('FULL_RESOLUTION_SOURCE','SELECTED_STREAMED_LOD')",
            name="source_kind_valid",
        ),
        CheckConstraint("expires_at > created_at", name="expiry_valid"),
        CheckConstraint("selected_lod IS NULL OR selected_lod >= 0", name="lod_valid"),
        Index("ix_scene_edit_sessions_owner_scene", "owner_id", "scene_id", "created_at"),
    )
