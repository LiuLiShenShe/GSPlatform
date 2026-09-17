"""UploadSession model — resumable, size-bounded upload state.

Stores scene-declared metadata (title/visibility/category/description) so the
complete step can create a Scene without trusting client state. Never stores a
client-provided absolute filesystem path; ``storage_key`` is server-generated.
Expiry is enforced by the service layer; the DB constraint only bounds sizes.
"""

from __future__ import annotations

import uuid
from datetime import datetime

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
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class UploadSession(Base):
    __tablename__ = "upload_sessions"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4
    )
    owner_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id"), nullable=False
    )
    # Populated in the complete step; null while the session is being filled.
    scene_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("scenes.id"), nullable=True, index=True
    )
    status: Mapped[str] = mapped_column(String(30), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(120), nullable=False)
    upload_format: Mapped[str] = mapped_column(String(20), nullable=False)
    offset: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    total_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    declared_sha256: Mapped[str | None] = mapped_column(
        String(64), nullable=True
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )

    # Scene declaration captured at session creation (Phase 06).
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    visibility: Mapped[str] = mapped_column(String(20), nullable=False)
    category: Mapped[str] = mapped_column(String(40), nullable=False)

    # Phase 07: PUBLISH (legacy) or RECONSTRUCT (3DGS pipeline).
    purpose: Mapped[str] = mapped_column(
        String(20), nullable=False, default="PUBLISH", server_default="PUBLISH"
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
            "status IN ('CREATED', 'UPLOADING', 'UPLOADED', 'QUEUED', 'VALIDATING', "
            "'CONVERTING', 'VERIFYING', 'PUBLISHING', 'SUCCEEDED', 'FAILED', "
            "'EXPIRED', 'CANCELLED')",
            name="status_valid",
        ),
        CheckConstraint(
            "purpose IN ('PUBLISH', 'RECONSTRUCT')",
            name="purpose_valid",
        ),
        CheckConstraint('"offset" >= 0', name="offset_non_negative"),
        CheckConstraint("total_size > 0", name="total_size_positive"),
        CheckConstraint(
            '"offset" <= total_size', name="offset_within_total"
        ),
        Index("ix_upload_sessions_owner", "owner_id", "created_at"),
    )
