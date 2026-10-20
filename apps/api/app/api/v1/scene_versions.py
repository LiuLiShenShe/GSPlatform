"""Scene version history endpoints (GS-NEXT-11).

Routes:
  GET  /scenes/{slug}/versions                      — owner-only history list
  POST /scenes/{slug}/versions/{version_id}/activate — rollback to an existing
                                                       immutable version

Both are strictly owner-scoped: another user's history is never readable
through them, and a version id belonging to a different scene is a 404 (never
a 403, which would confirm that the id exists).
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.identity import RequestIdentity, get_optional_current_user, require_csrf
from app.db.session import get_db_session
from app.schemas.scene_version import (
    SceneVersionActivateOut,
    SceneVersionActivateRequest,
    SceneVersionListOut,
)
from app.services.scene_versions import SceneVersionService

router = APIRouter()


@router.get("/{slug}/versions", response_model=SceneVersionListOut)
def list_scene_versions(
    slug: str,
    limit: int = Query(20, ge=1, le=100),
    cursor: str | None = Query(None, description="上一次返回的 meta.nextCursor"),
    identity: RequestIdentity | None = Depends(get_optional_current_user),
    db: Session = Depends(get_db_session),
) -> SceneVersionListOut:
    """历史版本列表（所有者）。新建在前，游标分页稳定。

    只返回真实存在的版本字段：版本 ID、创建时间、资产格式与大小、可用
    Gaussian 数量；**不**返回底层存储路径或未授权的资源地址。
    """
    if identity is None:
        # Same semantics as every other owner surface: anonymous callers on a
        # private scene get 401, owners are resolved from the session.
        from app.core.errors import UnauthorizedError

        raise UnauthorizedError("请先登录")
    return SceneVersionService(db).list_versions(
        slug, identity, limit=limit, cursor=cursor
    )


@router.post("/{slug}/versions/{version_id}/activate", response_model=SceneVersionActivateOut)
def activate_scene_version(
    slug: str,
    version_id: uuid.UUID,
    body: SceneVersionActivateRequest,
    identity: RequestIdentity = Depends(require_csrf),
    db: Session = Depends(get_db_session),
) -> SceneVersionActivateOut:
    """把当前版本切换（回滚）到某个已存在的不可变版本。

    回滚**只**重指向已存在版本：不重新生成 SOG、不改历史 manifest、不覆盖
    存储目录、不删除任何旧版本。``expectedCurrentVersionId`` 是乐观并发
    令牌，与库内当前版本不一致时返回 409。
    """
    return SceneVersionService(db).activate(
        slug,
        version_id,
        identity,
        expected_current_version_id=body.expectedCurrentVersionId,
    )
