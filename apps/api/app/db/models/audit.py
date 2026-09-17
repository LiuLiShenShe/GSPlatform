"""Audit event model — persistent audit trail for sensitive actions.

Every login, logout, session revocation, sensitive mutation and rate-limit
rejection is recorded here.  Never store credentials, tokens, cookies or full
request bodies — only the action name and a safe, bounded reason string.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4
    )
    # nullable: anonymous/rejected actions have no authenticated actor
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id"), nullable=True, index=True
    )
    action: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    # point of origin (IP) only — no PII beyond the address, no tokens
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # bounded, safe summary (never credentials, tokens or bodies)
    detail: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    def __repr__(self) -> str:  # pragma: no cover - debug aid
        return f"<AuditEvent id={self.id} action={self.action!r}>"
