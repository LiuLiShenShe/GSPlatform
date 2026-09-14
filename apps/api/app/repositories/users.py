"""User repository — identity bootstrap helpers.

Phase 05 keeps this minimal: the dev identity bypass needs a deterministic
user to attach owned rows to. No credential material is stored here.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models.user import User


def find_or_create_dev_user(
    session: Session, *, email: str, display_name: str
) -> uuid.UUID:
    """Return the id of the dev user, creating it on first use (idempotent)."""
    existing = session.execute(
        select(User).where(User.email == email)
    ).scalar_one_or_none()
    if existing is not None:
        return existing.id

    user = User(email=email, display_name=display_name)
    session.add(user)
    session.commit()
    session.refresh(user)
    return user.id
