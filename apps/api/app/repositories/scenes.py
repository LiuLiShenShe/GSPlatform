"""Scene repository — pure SQLAlchemy queries, no HTTP concepts."""

from __future__ import annotations

import base64
import json
import uuid
from datetime import datetime
from typing import Any, cast

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session, joinedload

from app.db.models.scene import Scene, SceneVersion

# ---------------------------------------------------------------------------
# Opaque cursor codec (base64 encoded JSON of sort-key + id)
# ---------------------------------------------------------------------------

def _encode_cursor(payload: dict[str, Any]) -> str:
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()


def _decode_cursor(raw: str) -> dict[str, Any]:
    try:
        return cast(dict[str, Any], json.loads(base64.urlsafe_b64decode(raw)))
    except Exception:
        raise ValueError("无效的分页游标") from None


def encode_id(obj_id: uuid.UUID) -> str:
    return base64.urlsafe_b64encode(obj_id.bytes).decode()


def decode_id(raw: str) -> uuid.UUID:
    try:
        return uuid.UUID(bytes=base64.urlsafe_b64decode(raw))
    except Exception:
        raise ValueError("无效的 ID") from None


class SceneRepository:
    """Read-only scene queries for public catalogue and owner views."""

    def __init__(self, session: Session) -> None:
        self._session = session

    def list_public(
        self,
        *,
        limit: int = 20,
        cursor: str | None = None,
        category: str | None = None,
        sort: str = "latest",
    ) -> tuple[list[Scene], str | None]:
        """Return newest published, visible, non-deleted scenes plus next cursor.

        Uses a stable (sort-column, id) keyset to guarantee consistent pages
        even as rows are inserted or published_at timestamps are backfilled.
        """
        conditions = [
            Scene.visibility == "PUBLIC",
            Scene.status == "PUBLISHED",
            Scene.deleted_at.is_(None),
        ]
        if category is not None:
            conditions.append(Scene.category == category)

        base_filter = and_(*conditions)

        if sort == "popular":
            sort_col: Any = Scene.views
        else:
            sort_col = Scene.published_at

        q = (
            select(Scene)
            .where(base_filter)
            .options(joinedload(Scene.owner))
        )

        if cursor is not None:
            c = _decode_cursor(cursor)
            cursor_value = c["v"]
            cursor_id = uuid.UUID(c["id"])
            if sort == "popular":
                # compare integer views
                q = q.where(
                    or_(
                        (Scene.views < int(cursor_value)),
                        and_(Scene.views == int(cursor_value), Scene.id < cursor_id),
                    )
                )
            else:
                cursor_time = datetime.fromisoformat(cursor_value)
                q = q.where(
                    or_(
                        (Scene.published_at < cursor_time),
                        and_(
                            Scene.published_at == cursor_time,
                            Scene.id < cursor_id,
                        ),
                    )
                )

        # Order by sort_col DESC, then id DESC for stability.
        q = q.order_by(
            sort_col.desc().nulls_last(), Scene.id.desc()
        ).limit(limit + 1)

        rows = list(self._session.execute(q).unique().scalars())
        has_more = len(rows) > limit
        items = rows[:limit]

        next_cursor = None
        if has_more and items:
            last = items[-1]
            val = (
                last.views
                if sort == "popular"
                else (last.published_at or datetime.min.replace(tzinfo=None))
            )
            next_cursor = _encode_cursor({"v": val, "id": str(last.id)})

        return items, next_cursor

    def get_public_by_slug(self, slug: str) -> Scene | None:
        """Return a single visible, published, non-deleted scene (or None)."""
        return (
            self._session.query(Scene)
            .options(joinedload(Scene.owner))
            .filter(
                Scene.slug == slug,
                Scene.visibility == "PUBLIC",
                Scene.status == "PUBLISHED",
                Scene.deleted_at.is_(None),
            )
            .first()
        )

    def get_by_slug_for_owner(
        self, slug: str, owner_id: uuid.UUID
    ) -> Scene | None:
        """Return a scene owned by *owner_id* regardless of status/visibility."""
        return (
            self._session.query(Scene)
            .options(joinedload(Scene.owner))
            .filter(
                Scene.slug == slug,
                Scene.owner_id == owner_id,
                Scene.deleted_at.is_(None),
            )
            .first()
        )

    def list_owner(
        self,
        owner_id: uuid.UUID,
        *,
        limit: int = 20,
        cursor: str | None = None,
        status_filter: str | None = None,
    ) -> tuple[list[Scene], str | None]:
        """Return owner's scenes ordered by updated_at DESC + keyset cursor."""
        conditions = [
            Scene.owner_id == owner_id,
            Scene.deleted_at.is_(None),
        ]
        if status_filter:
            conditions.append(Scene.status == status_filter)

        q = (
            select(Scene)
            .where(and_(*conditions))
            .options(joinedload(Scene.owner))
        )

        if cursor is not None:
            c = _decode_cursor(cursor)
            cursor_time = datetime.fromisoformat(c["t"])
            cursor_id = uuid.UUID(c["id"])
            q = q.where(
                or_(
                    (Scene.updated_at < cursor_time),
                    and_(
                        Scene.updated_at == cursor_time,
                        Scene.id < cursor_id,
                    ),
                )
            )

        q = q.order_by(Scene.updated_at.desc(), Scene.id.desc()).limit(
            limit + 1
        )
        rows = list(self._session.execute(q).unique().scalars())
        has_more = len(rows) > limit
        items = rows[:limit]

        next_cursor = None
        if has_more and items:
            last = items[-1]
            next_cursor = _encode_cursor(
                {"t": last.updated_at.isoformat(), "id": str(last.id)}
            )

        return items, next_cursor

    # ---- write helpers (used only by seed / service) ----

    def get_by_slug(self, slug: str) -> Scene | None:
        return (
            self._session.query(Scene)
            .filter(Scene.slug == slug)
            .first()
        )

    def get_by_id(self, scene_id: uuid.UUID) -> Scene | None:
        return (
            self._session.query(Scene)
            .filter(Scene.id == scene_id)
            .first()
        )

    def get_latest_version(self, scene_id: uuid.UUID) -> SceneVersion | None:
        return (
            self._session.query(SceneVersion)
            .filter(SceneVersion.scene_id == scene_id)
            .order_by(SceneVersion.created_at.desc())
            .first()
        )
