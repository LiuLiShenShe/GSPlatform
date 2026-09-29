"""Unified scene access policy (FIX-01).

One policy decides readability for **every** read surface:

- works hall (scene detail / summary / list),
- Runtime Descriptor (``GET /api/v1/scenes/{id}/runtime``),
- Asset delivery (``GET /api/v1/scenes/{id}/assets/{path}``),
- presentation / annotation media / collision serving,
- share resolution.

Before FIX-01 every surface re-derived its own rule, and they disagreed with
the platform's own public rule (``PUBLIC + PUBLISHED``).  The runtime and
authoring read paths additionally accepted ``PUBLIC + READY`` and never
checked ``deleted_at``, so a soft-deleted scene kept answering for its
owner.  Call sites must no longer encode visibility: they ask this policy.

Rules (FIXED — do not re-derive them anywhere else)
--------------------------------------------------

``OWNER``
    Any non-deleted scene owned by the caller is readable whatever its
    status/visibility — the owner must be able to preview a draft.

``ANONYMOUS``
    Only ``visibility == PUBLIC AND status == PUBLISHED AND deleted_at IS
    NULL``.  ``PUBLIC + READY`` is **not** anonymously readable through the
    runtime/asset paths: it is still an owner's preview state.  This matches
    ``SceneRepository.get_public_by_slug`` — the platform's official public
    rule — so the runtime can no longer be more permissive than the works
    hall.

``SHARE``
    A live (non-revoked, non-expired) share token for the scene grants read
    access.  This reuses the existing ``ShareLink`` mechanism rather than
    inventing a preview mode; like ``ShareService.resolve_share`` the scene
    must still be ``PUBLISHED`` for a token to mean anything.

``DELETED``
    A soft-deleted scene is invisible on every surface — 404 for the owner,
    for anonymous callers and for share tokens alike.

Error semantics (project norm): missing or deleted → 404; exists but not
readable + anonymous → 401; exists but not readable + authenticated → 403.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.errors import ForbiddenError, NotFoundError, UnauthorizedError
from app.core.identity import RequestIdentity
from app.core.security import sha256_hex
from app.db.models.enums import SceneStatus, Visibility
from app.db.models.scene import Scene
from app.db.models.share_link import ShareLink
from app.repositories.scenes import SceneRepository


def is_publicly_visible(scene: Scene) -> bool:
    """True when *scene* is readable by anyone without logging in.

    Single definition of "public" for the whole platform: PUBLIC +
    PUBLISHED + not deleted.  ``READY`` is deliberately excluded.
    """
    return (
        scene.deleted_at is None
        and scene.visibility == Visibility.PUBLIC.value
        and scene.status == SceneStatus.PUBLISHED.value
    )


class SceneAccessPolicy:
    """The one place that answers "may this caller read this scene?"."""

    def __init__(self, session: Session) -> None:
        self._session = session
        self._scenes = SceneRepository(session)

    # ------------------------------------------------------------------ #
    # lookup
    # ------------------------------------------------------------------ #
    def find_scene(self, slug_or_id: str) -> Scene | None:
        """Bare lookup by slug, falling back to the internal UUID.

        Deleted rows are returned too — deciding whether a scene is visible
        is the policy's job, not the lookup's.
        """
        scene = self._scenes.get_by_slug(slug_or_id)
        if scene is None:
            try:
                scene = self._scenes.get_by_id(uuid.UUID(slug_or_id))
            except ValueError:
                scene = None
        return scene

    def is_owner(self, scene: Scene, user_id: uuid.UUID | None) -> bool:
        """True when *user_id* owns *scene*."""
        return user_id is not None and scene.owner_id == user_id

    # ------------------------------------------------------------------ #
    # read access
    # ------------------------------------------------------------------ #
    def resolve_readable_scene(
        self,
        slug_or_id: str,
        identity: RequestIdentity | None,
        *,
        share_token: str | None = None,
    ) -> Scene:
        """Return the scene when the caller may read it, else raise.

        Raises ``NotFoundError`` (missing/deleted), ``UnauthorizedError``
        (anonymous, exists but private) or ``ForbiddenError`` (authenticated
        but not the owner and not public).
        """
        user_id = identity.user_id if identity is not None else None
        return self._resolve(slug_or_id, user_id, share_token=share_token)

    def resolve_readable_for_user(
        self,
        slug_or_id: str,
        user_id: uuid.UUID | None,
        *,
        share_token: str | None = None,
    ) -> Scene:
        """Same policy, for call sites that only carry a bare user id."""
        return self._resolve(slug_or_id, user_id, share_token=share_token)

    def _resolve(
        self,
        slug_or_id: str,
        user_id: uuid.UUID | None,
        *,
        share_token: str | None,
    ) -> Scene:
        scene = self.find_scene(slug_or_id)
        if scene is None or scene.deleted_at is not None:
            # A deleted scene is indistinguishable from a missing one on
            # every surface, for everyone (FIX-01 P1-2).
            raise NotFoundError(f"场景 {slug_or_id} 不存在")

        if self.is_owner(scene, user_id):
            return scene
        if is_publicly_visible(scene):
            return scene
        if share_token and self._share_token_grants(scene, share_token):
            return scene

        # The scene exists but is not readable by this caller.
        if user_id is None:
            raise UnauthorizedError("该场景需要登录后访问")
        raise ForbiddenError("该场景不可见或未发布")

    # ------------------------------------------------------------------ #
    # share grants
    # ------------------------------------------------------------------ #
    def _share_token_grants(self, scene: Scene, raw_token: str) -> bool:
        """True when *raw_token* is a live share token for *scene*.

        Mirrors ``ShareService.resolve_share``: the link must exist, must not
        be revoked, must not be expired, and the scene must still be
        PUBLISHED (a share link is created for published scenes only).
        """
        if scene.status != SceneStatus.PUBLISHED.value:
            return False
        now = datetime.now(UTC)
        link = self._session.execute(
            select(ShareLink).where(
                ShareLink.scene_id == scene.id,
                ShareLink.token_hash == sha256_hex(raw_token),
                ShareLink.revoked_at.is_(None),
                or_(ShareLink.expires_at.is_(None), ShareLink.expires_at > now),
            )
        ).scalar_one_or_none()
        return link is not None
