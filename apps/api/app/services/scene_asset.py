"""Authorized scene asset delivery (FIX-01).

Every Gaussian / poster / manifest / LOD byte a browser needs is served
through ONE authorized endpoint::

    GET /api/v1/scenes/{scene_id}/assets/{asset_path}

Before FIX-01 the Runtime Descriptor pointed at ``/local-scenes/<slug>/...``
and production Nginx ``alias``'ed that prefix straight onto the scene-origin
tree with no authentication at all, so a private scene's gaussian bytes were
one guess away from the public internet (FIX-01 P0-1).  Now the origin tree
is never a public path: authorization happens here, in FastAPI, through the
unified :class:`~app.services.scene_access.SceneAccessPolicy`.

Production never streams the file through Python.  After the containment
check the request is handed to Nginx with an ``X-Accel-Redirect`` into an
``internal`` location, so Range/206/416, ``Content-Length`` and cache headers
stay Nginx's job — FastAPI must not pull hundreds of MB into the ASGI
process (FIX-01 §7).  ``internal`` also means only this API can reach the
tree: a client asking for ``/_scene-origin/...`` gets 404.

Path safety (FIX-01 §9): ``asset_path`` is fully caller-controlled.  It is
validated segment by segment (no ``..``, no absolute path, no NUL, no
backslash) and then re-checked with ``Path.resolve()`` against the real
scene root — never with a bare ``startswith``, which would also accept
``/scenes/foo-bar-evil`` for a root of ``/scenes/foo-bar``.
"""

from __future__ import annotations

import mimetypes
import re
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from app.core.config import Settings, get_settings
from app.core.errors import NotFoundError
from app.core.paths import get_repo_root, get_scene_storage_root
from app.db.models.scene import Scene

# Slug grammar mirrors the API's scene-slug rules: it is the only part of the
# URL that the *filesystem* consumes, so it must not be able to carry a
# separator, a parent reference or a percent escape.
SCENE_SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")

# Production Nginx internal location (deploy/nginx/gsplatform.conf):
#     location /_scene-origin/ { internal; alias <scene_origin_root>/; }
# FastAPI emits `/_scene-origin/<slug>/<rel>`; the API's
# ``GS_SCENE_ORIGIN_ROOT`` and that alias must point at the same tree.
X_ACCEL_BASE = "/_scene-origin/"

# Cache policy (FIX-05): computed from BOTH the access scope and the asset's
# mutability — never from the relative path alone, so a private / share-
# controlled scene can never come back ``Cache-Control: public`` (P1-3), and
# a repointed ``current`` can never be ``immutable`` (P0/P1-2).
#
#   PUBLIC  versioned → public, max-age=31536000, immutable
#   PUBLIC  current   → public, no-cache
#   OWNER   versioned → private, max-age=31536000, immutable
#   OWNER   current   → private, no-cache
#   SHARE   anything   → private, no-cache        (share tokens can be revoked)
#   manifest/poster    → scope-aware short caches (per-path special cases)
_MANIFEST_CACHE_PUBLIC = "public, max-age=60"
_MANIFEST_CACHE_PRIVATE = "private, no-cache"
_POSTER_CACHE_PUBLIC = "public, max-age=86400"
_POSTER_CACHE_PRIVATE = "private, max-age=86400"
_PUBLIC_IMMUTABLE_CACHE = "public, max-age=31536000, immutable"
_PUBLIC_NO_CACHE = "public, no-cache"
_PRIVATE_IMMUTABLE_CACHE = "private, max-age=31536000, immutable"
_PRIVATE_NO_CACHE = "private, no-cache"

# A versioned path starts with ``versions/<version-id>/`` — content-addressed
# immutable bytes whose URL never changes.
_VERSIONED_SEGMENT_RE = re.compile(r"^versions/[^/]+/")


class SceneAssetAccessScope(StrEnum):
    """Who was allowed to read this asset (FIX-05 P1-3 / §11).

    The asset service needs this to pick a cache scope: only PUBLIC assets
    may be cached by shared caches/CDNs; OWNER and SHARE must stay private.
    The policy (``SceneAccessPolicy.cache_scope``) is the single source for
    the value — call sites never re-derive it.
    """

    PUBLIC = "public"
    OWNER = "owner"
    SHARE = "share"

    @property
    def is_public(self) -> bool:
        return self is SceneAssetAccessScope.PUBLIC


_EXTRA_MIME_TYPES = {
    ".sog": "application/octet-stream",
    ".ply": "application/octet-stream",
    ".splat": "application/octet-stream",
    ".spz": "application/octet-stream",
    ".bin": "application/octet-stream",
    ".webp": "image/webp",
    ".glb": "model/gltf-binary",
    ".wasm": "application/wasm",
}


def build_cache_control(scope: SceneAssetAccessScope, rel_path: str) -> str:
    """Cache-Control for one scene asset given its access scope + path.

    ``rel_path`` is the scene-relative asset path (``current/...`` or
    ``versions/<ver>/...`` or a named file like ``manifest.json`` /
    ``poster.webp``).  Versioned (content-addressed immutable) URLs may be
    cached long-term; everything mutable is ``no-cache``; non-public scopes
    never produce a ``public`` directive (P1-3).
    """
    name = rel_path.rsplit("/", 1)[-1]
    if name == "manifest.json":
        return _MANIFEST_CACHE_PUBLIC if scope.is_public else _MANIFEST_CACHE_PRIVATE
    if name == "poster.webp":
        return _POSTER_CACHE_PUBLIC if scope.is_public else _POSTER_CACHE_PRIVATE
    if scope is SceneAssetAccessScope.SHARE:
        # Share tokens can be revoked — keep shared bytes out of any long
        # cache (even the browser's), matching "share → private" (§10/§12).
        return _PRIVATE_NO_CACHE
    if _VERSIONED_SEGMENT_RE.match(rel_path):
        return _PUBLIC_IMMUTABLE_CACHE if scope.is_public else _PRIVATE_IMMUTABLE_CACHE
    return _PUBLIC_NO_CACHE if scope.is_public else _PRIVATE_NO_CACHE


class AssetPathError(NotFoundError):
    """A syntactically impossible asset path (traversal, NUL, absolute)."""


@dataclass(frozen=True)
class ResolvedSceneAsset:
    """A scene asset that already passed authorization + containment.

    ``x_accel_path`` is set when Nginx should serve the bytes (production);
    ``absolute_path`` is set when this process should serve them (dev/test,
    where there is no Nginx and no production origin tree).
    """

    absolute_path: Path | None
    x_accel_path: str | None
    media_type: str
    cache_control: str


def _is_within(child: Path, parent: Path) -> bool:
    """True when *child* is *parent* or lives underneath it.

    ``Path.is_relative_to`` compares whole path components, so unlike a
    ``startswith`` string test it cannot be fooled by a sibling whose name
    merely begins with the root's name.
    """
    return child == parent or parent in child.parents


def _validate_rel(asset_path: str) -> str:
    """Reject any asset path that is not a plain relative POSIX path."""
    if not asset_path or "\x00" in asset_path:
        raise AssetPathError("非法的资源路径")
    if "\\" in asset_path or asset_path.startswith("/"):
        raise AssetPathError("非法的资源路径")
    segments = asset_path.split("/")
    for segment in segments:
        # `.`/`..`/empty would let the path climb out of the scene directory;
        # a bare ``~`` or a second percent escape is never legitimate here.
        if segment in ("", ".", "..") or "%" in segment:
            raise AssetPathError("非法的资源路径")
    return "/".join(segments)


def _media_type_for(rel: str) -> str:
    ext = Path(rel).suffix.lower()
    if ext in _EXTRA_MIME_TYPES:
        return _EXTRA_MIME_TYPES[ext]
    guessed, _ = mimetypes.guess_type(rel)
    return guessed or "application/octet-stream"


class SceneAssetService:
    """Resolves a scene-relative asset path to something servable."""

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()

    # ------------------------------------------------------------------ #
    # roots
    # ------------------------------------------------------------------ #
    def uses_x_accel(self) -> bool:
        """Production hands the bytes to Nginx; dev/test serve them here."""
        return self._settings.env == "production"

    def origin_root(self) -> Path:
        """Root of the scene-origin tree that mirrors the URL space."""
        if self._settings.scene_origin_root:
            return Path(self._settings.scene_origin_root)
        return get_repo_root() / "scenes"

    def _published_root_for(self, scene: Scene) -> Path:
        """Scene-specific published root: ``<storage>/published/<scene.id>``.

        FIX-05 P1-6/§13-14: trusting the *whole* ``published/`` directory
        would let one scene's symlink resolve into another scene's published
        tree.  The publish bridge writes exactly
        ``<storage>/published/<str(scene.id)>/versions/<ver>`` (publish_service
        ``_bridge_dev_scene_view``), so only that scene's own subdirectory is
        a legitimate escape target.
        """
        return get_scene_storage_root(self._settings.storage_root) / "published" / str(scene.id)

    def _trusted_roots(self, scene: Scene, scene_root: Path) -> list[Path]:
        """Real directories a scene asset may physically live under.

        A published version is reached through
        ``<origin>/<slug>/versions/<ver> -> <storage>/published/<scene.id>/...``,
        so following that symlink *legitimately* leaves the origin tree.  Only
        the scene's OWN published subdirectory is trusted — a symlink planted
        at ``published/<another-scene-id>/`` or anywhere else is rejected.
        """
        roots = [scene_root]
        published = self._published_root_for(scene)
        try:
            roots.append(published.resolve())
        except OSError:  # pragma: no cover - storage root may not exist yet
            pass
        return roots

    # ------------------------------------------------------------------ #
    # resolution
    # ------------------------------------------------------------------ #
    def resolve(
        self,
        scene: Scene,
        asset_path: str,
        access_scope: SceneAssetAccessScope = SceneAssetAccessScope.PUBLIC,
    ) -> ResolvedSceneAsset:
        """Return the servable form of ``<origin>/<slug>/<asset_path>``.

        ``access_scope`` comes from the unified policy and drives the
        Cache-Control scope (FIX-05 §11): never a bare relative-path guess.
        Raises ``NotFoundError`` when the path is malformed, escapes the
        scene, or simply does not exist.
        """
        if not SCENE_SLUG_RE.match(scene.slug):
            # A slug that could not have been created by the API must never
            # reach the filesystem join.
            raise NotFoundError("场景资源不存在")

        rel = _validate_rel(asset_path)

        origin = self.origin_root().resolve()
        scene_root = (origin / scene.slug).resolve()
        if not _is_within(scene_root, origin):
            raise NotFoundError("场景资源不存在")

        candidate = scene_root / rel
        try:
            real = candidate.resolve()
        except OSError:  # pragma: no cover - resolve is non-strict
            raise NotFoundError("场景资源不存在") from None

        if not any(_is_within(real, trusted) for trusted in self._trusted_roots(scene, scene_root)):
            # A symlink pointing outside the scene origin / its own published
            # storage (e.g. into a sibling scene's published tree).
            raise NotFoundError("场景资源不存在")
        if not real.is_file():
            raise NotFoundError("场景资源不存在")

        media_type = _media_type_for(rel)
        cache_control = build_cache_control(access_scope, rel)
        if self.uses_x_accel():
            # The logical (validated) path is what Nginx must resolve; the
            # realpath above only proved that it is safe to serve.
            return ResolvedSceneAsset(
                absolute_path=None,
                x_accel_path=f"{X_ACCEL_BASE}{scene.slug}/{rel}",
                media_type=media_type,
                cache_control=cache_control,
            )
        return ResolvedSceneAsset(
            absolute_path=real,
            x_accel_path=None,
            media_type=media_type,
            cache_control=cache_control,
        )
