"""UploadSession model — resumable, size-bounded upload state.

Never stores a client-provided absolute filesystem path; ``storage_key`` is
server-generated. Expiry is enforced by the service layer; the DB constraint
only bounds sizes to sane ranges.
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
    status: Mapped[str] = mapped_column(String(30), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(120), nullable=False)
    offset: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    total_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
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
            "status IN ('INITIATED', 'UPLOADING', 'VALIDATING', 'READY', "
            "'EXPIRED', 'CANCELLED')",
            name="status_valid",
        ),
        CheckConstraint('"offset" >= 0', name="offset_non_negative"),
        CheckConstraint("total_size > 0", name="total_size_positive"),
        CheckConstraint(
            '"offset" <= total_size', name="offset_within_total"
        ),
        Index("ix_upload_sessions_owner", "owner_id", "created_at"),
    )
