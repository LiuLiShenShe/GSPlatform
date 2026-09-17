"""Share service — revocable, expiring share links for non-public scenes.

Raw tokens are never stored nor logged; only their SHA-256 hash lives in the
``share_links`` table.  Resolution re-validates scene status and asset-version
on every access, so revoking/expiring a link immediately gates the scene image
AND its assets (the API is the only way to obtain version URLs for shared
scenes).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.errors import ConflictError, ForbiddenError, NotFoundError
from app.core.security import generate_share_token, sha256_hex
from app.db.models.scene import Scene
from app.db.models.share_link import ShareLink
from app.schemas.scene import SceneDetailOut
from app.services.scenes import _detail_from_scene


class ShareService:
    def __init__(self, db: Session) -> None:
        self._db = db
        self._settings = get_settings()

    # ------------------------------------------------------------------
    # create
    # ------------------------------------------------------------------
    def create_share(
        self,
        *,
        owner_id: uuid.UUID,
        scene_slug: str,
        hours: int | None = None,
    ) -> dict[str, object]:
        """Create a share link for a scene the caller owns.

        Only scenes that are NOT fully public need (and may) receive a share
        link; public scenes are already addressable via their platform URL.
        Returns the raw token (exactly once) plus the share URL.
        """
        scene = self._db.execute(
            select(Scene).where(Scene.slug == scene_slug)
        ).scalar_one_or_none()
        if scene is None or scene.deleted_at is not None:
            raise NotFoundError(f"场景 {scene_slug} 不存在")
        if scene.owner_id != owner_id:
            raise ForbiddenError("只有场景所有者可以创建分享链接")
        if scene.status != "PUBLISHED":
            raise ConflictError("只有已发布场景可以分享")

        if scene.visibility == "PUBLIC":
            # Public scenes are already shared via their platform URL.  For
            # uniformity we still return a public-scene share URL tied to the
            # canonical route (no token needed).
            return {
                "token": None,
                "shareUrl": f"/scene/{scene.slug}",
                "expiresAt": None,
                "revoked": False,
            }

        raw_token = generate_share_token()
        expires_at = None
        if hours is not None and hours > 0:
            expires_at = datetime.now(UTC) + timedelta(hours=hours)

        link = ShareLink(
            scene_id=scene.id,
            owner_id=owner_id,
            token_hash=sha256_hex(raw_token),
            expires_at=expires_at,
        )
        self._db.add(link)
        self._db.flush()

        return {
            "token": raw_token,
            "shareUrl": f"/s/{raw_token}",
            "expiresAt": expires_at,
            "revoked": False,
        }

    # ------------------------------------------------------------------
    # resolve (visitor access)
    # ------------------------------------------------------------------
    def resolve_share(self, raw_token: str) -> tuple[SceneDetailOut, ShareLink]:
        """Resolve a share token to a scene detail.

        Raises 403/404 when revoked, expired, or the scene is no longer
        in a shareable state.
        """
        token_hash = sha256_hex(raw_token)
        link = self._db.execute(
            select(ShareLink).where(ShareLink.token_hash == token_hash)
        ).scalar_one_or_none()
        if link is None:
            raise NotFoundError("分享链接无效或已被撤销")

        if link.revoked_at is not None:
            raise ForbiddenError("该分享链接已被撤销")
        if link.expires_at is not None and link.expires_at < datetime.now(UTC):
            raise ForbiddenError("该分享链接已过期")

        scene = self._db.execute(
            select(Scene).where(Scene.id == link.scene_id)
        ).scalar_one_or_none()
        if scene is None or scene.deleted_at is not None:
            raise NotFoundError("被分享的场景已删除")
        if scene.status != "PUBLISHED" or scene.current_version_id is None:
            raise ForbiddenError("被分享的场景当前不可见")

        return _detail_from_scene(scene), link

    # ------------------------------------------------------------------
    # revoke
    # ------------------------------------------------------------------
    def revoke_share(
        self,
        *,
        owner_id: uuid.UUID,
        scene_slug: str,
        share_id: uuid.UUID,
    ) -> None:
        """Revoke a share.  Must be the scene owner."""
        scene = self._db.execute(
            select(Scene).where(Scene.slug == scene_slug)
        ).scalar_one_or_none()
        if scene is None or scene.deleted_at is not None:
            raise NotFoundError(f"场景 {scene_slug} 不存在")
        if scene.owner_id != owner_id:
            raise ForbiddenError("只有场景所有者可以撤销分享")

        link = self._db.execute(
            select(ShareLink).where(
                ShareLink.id == share_id,
                ShareLink.scene_id == scene.id,
            )
        ).scalar_one_or_none()
        if link is None:
            raise NotFoundError("分享链接不存在")

        if link.revoked_at is None:
            link.revoked_at = datetime.now(UTC)
            self._db.flush()

    # ------------------------------------------------------------------
    # list (owner management)
    # ------------------------------------------------------------------
    def list_shares(
        self,
        *,
        owner_id: uuid.UUID,
        scene_slug: str,
    ) -> list[dict[str, object]]:
        """Return non-revoked share meta for the scene (owner only)."""
        scene = self._db.execute(
            select(Scene).where(Scene.slug == scene_slug)
        ).scalar_one_or_none()
        if scene is None or scene.deleted_at is not None:
            raise NotFoundError(f"场景 {scene_slug} 不存在")
        if scene.owner_id != owner_id:
            raise ForbiddenError("只有场景所有者可以查看分享")

        links = self._db.execute(
            select(ShareLink)
            .where(
                ShareLink.scene_id == scene.id,
                ShareLink.revoked_at.is_(None),
            )
            .order_by(ShareLink.created_at.desc())
        ).scalars().all()

        return [
            {
                "id": str(link.id),
                "sceneSlug": scene.slug,
                "createdAt": link.created_at,
                "expiresAt": link.expires_at,
                "revoked": False,
            }
            for link in links
        ]
