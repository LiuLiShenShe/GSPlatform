"""SceneVersion repository — 历史版本查询（纯查询，无 HTTP 概念）。

分页用 (created_at, id) 的 keyset 游标：即使在同一事务里创建的多个版本
共享同一时间戳，id 兜底也保证分页**稳定且无重复无遗漏**（与
``SceneRepository`` 的公开目录/作品列表同一种思路）。
"""

from __future__ import annotations

import base64
import json
import uuid
from datetime import datetime
from typing import Any, cast

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.db.models.scene import SceneVersion


def _encode_cursor(payload: dict[str, Any]) -> str:
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()


def _decode_cursor(raw: str) -> dict[str, Any]:
    try:
        return cast(dict[str, Any], json.loads(base64.urlsafe_b64decode(raw)))
    except Exception:
        raise ValueError("无效的分页游标") from None


class SceneVersionRepository:
    """SceneVersion 的只读查询。"""

    def __init__(self, session: Session) -> None:
        self._session = session

    def list_by_scene(
        self,
        scene_id: uuid.UUID,
        *,
        limit: int = 20,
        cursor: str | None = None,
    ) -> tuple[list[SceneVersion], str | None]:
        """Return the scene's versions, newest first, plus the next cursor."""
        q = select(SceneVersion).where(SceneVersion.scene_id == scene_id)

        if cursor is not None:
            c = _decode_cursor(cursor)
            cursor_time = datetime.fromisoformat(c["t"])
            cursor_id = uuid.UUID(c["id"])
            q = q.where(
                or_(
                    (SceneVersion.created_at < cursor_time),
                    and_(
                        SceneVersion.created_at == cursor_time,
                        SceneVersion.id < cursor_id,
                    ),
                )
            )

        q = q.order_by(
            SceneVersion.created_at.desc(), SceneVersion.id.desc()
        ).limit(limit + 1)

        rows = list(self._session.execute(q).scalars())
        has_more = len(rows) > limit
        items = rows[:limit]

        next_cursor: str | None = None
        if has_more and items:
            last = items[-1]
            next_cursor = _encode_cursor(
                {"t": last.created_at.isoformat(), "id": str(last.id)}
            )
        return items, next_cursor

    def get_by_id(self, version_id: uuid.UUID) -> SceneVersion | None:
        return self._session.get(SceneVersion, version_id)

    def count_by_scene(self, scene_id: uuid.UUID) -> int:
        return (
            self._session.query(SceneVersion)
            .filter(SceneVersion.scene_id == scene_id)
            .count()
        )
