"""Job model — async pipeline task state machine (Celery-facing)."""

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


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4
    )
    scene_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("scenes.id"), nullable=False
    )
    owner_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    status: Mapped[str] = mapped_column(String(30), nullable=False)
    progress: Mapped[int] = mapped_column(
        BigInteger, default=0, nullable=False
    )
    stage: Mapped[str | None] = mapped_column(String(120), nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(60), nullable=True)
    error_message_safe: Mapped[str | None] = mapped_column(
        String(1000), nullable=True
    )
    attempt: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    celery_task_id: Mapped[str | None] = mapped_column(
        String(120), nullable=True, index=True
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
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        CheckConstraint(
            "kind IN ('VALIDATE_UPLOAD', 'BUILD_STREAMED_SOG', 'RECONSTRUCT', "
            "'PUBLISH', 'DELETE_ASSETS', 'BUILD_COLLISION')",
            name="kind_valid",
        ),
        CheckConstraint(
            "status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', "
            "'CANCEL_REQUESTED', 'CANCELLED')",
            name="status_valid",
        ),
        CheckConstraint("progress BETWEEN 0 AND 100", name="progress_range"),
        CheckConstraint("attempt >= 0", name="attempt_non_negative"),
        Index("ix_jobs_owner_status", "owner_id", "status", "created_at"),
        Index("ix_jobs_scene_status", "scene_id", "status"),
    )
