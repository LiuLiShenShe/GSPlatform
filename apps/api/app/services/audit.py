"""Audit event writer — append-only, never raises, never stores secrets."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

from app.core.config import get_settings

logger = logging.getLogger("gsplatform.audit")


def log_audit(
    db: Session,
    *,
    action: str,
    user_id: object | None = None,
    ip_address: str | None = None,
    detail: str | None = None,
) -> None:
    """Append an audit row and forget.  Never raises."""
    settings = get_settings()
    if not settings.audit_enabled:
        return

    # Sanitize: truncate detail, never store tokens or passwords.
    safe_detail: str | None = None
    if detail is not None:
        safe_detail = detail[:500]
        # Strip any token-like fragments.
        for token_fragment in ["token=", "password=", "secret=", "Authorization:"]:
            lower = safe_detail.lower()
            if token_fragment.lower() in lower:
                safe_detail = safe_detail[:60] + " [...REDACTED...]"
                break

    try:
        from app.db.models.audit import AuditEvent

        event = AuditEvent(
            user_id=user_id if user_id is not None else None,
            action=action,
            ip_address=(ip_address or "")[:64] if ip_address else None,
            detail=safe_detail,
        )
        db.add(event)
        db.flush()
    except Exception:
        logger.warning(
            "audit write failed for action=%s: %s",
            action,
            exc_info=True,
        )
