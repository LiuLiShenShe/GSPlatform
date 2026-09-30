"""FIX-05 §10-§12 — Cache-Control matrix (public/private/share × current/versioned).

Unit-level: :func:`build_cache_control` over the full access-scope × path
matrix.  Endpoint-level: at least one REAL asset endpoint response header
(public current → no-cache; public versioned → immutable) — P1-2/P1-3 forbid
``public, max-age=31536000, immutable`` on any ``current/*`` path and forbid
``public`` on private/share scopes.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.main import app
from app.services.scene_asset import (
    SceneAssetAccessScope,
    build_cache_control,
)
from tests.conftest_scenes import create_scene
from tests.test_scene_assets import _write_origin

client = TestClient(app)


@pytest.fixture
def anon_client():
    from app.core.identity import get_optional_current_user

    app.dependency_overrides[get_optional_current_user] = lambda: None
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_optional_current_user, None)


@pytest.fixture
def origin(tmp_path_factory, monkeypatch):
    """A scene-origin tree + settings pointing at it (dev FileResponse mode)."""
    root = tmp_path_factory.mktemp("scene-cache-origin")
    monkeypatch.setattr(settings, "scene_origin_root", str(root))
    return root

PUBLIC_IMMUTABLE = "public, max-age=31536000, immutable"
PUBLIC_NO_CACHE = "public, no-cache"
PRIVATE_IMMUTABLE = "private, max-age=31536000, immutable"
PRIVATE_NO_CACHE = "private, no-cache"
MANIFEST_PUBLIC = "public, max-age=60"
MANIFEST_PRIVATE = "private, no-cache"


# ── unit: build_cache_control matrix (§10/§12) ─────────────────────────────
class TestBuildCacheControl:
    @pytest.mark.parametrize(
        ("scope", "rel", "expected"),
        [
            # public current → no-cache (current 可重指向，禁止 immutable — P1-2)
            (SceneAssetAccessScope.PUBLIC, "current/lod-meta.json", PUBLIC_NO_CACHE),
            (SceneAssetAccessScope.PUBLIC, "current/scene.sog", PUBLIC_NO_CACHE),
            # public versioned → immutable
            (SceneAssetAccessScope.PUBLIC, "versions/abc/lod-meta.json", PUBLIC_IMMUTABLE),
            (SceneAssetAccessScope.PUBLIC, "versions/abc/scene.sog", PUBLIC_IMMUTABLE),
            # private owner → 绝不 public（P1-3）
            (SceneAssetAccessScope.OWNER, "current/lod-meta.json", PRIVATE_NO_CACHE),
            (SceneAssetAccessScope.OWNER, "versions/abc/lod-meta.json", PRIVATE_IMMUTABLE),
            # share → 永不 public，且不长缓存（token 可吊销）
            (SceneAssetAccessScope.SHARE, "current/lod-meta.json", PRIVATE_NO_CACHE),
            (SceneAssetAccessScope.SHARE, "versions/abc/lod-meta.json", PRIVATE_NO_CACHE),
            # manifest / poster 特例仍按 scope 区分
            (SceneAssetAccessScope.PUBLIC, "versions/abc/manifest.json", MANIFEST_PUBLIC),
            (SceneAssetAccessScope.OWNER, "manifest.json", MANIFEST_PRIVATE),
        ],
    )
    def test_matrix(self, scope, rel, expected):
        assert build_cache_control(scope, rel) == expected

    def test_private_never_public_even_immutable_paths(self):
        for rel in ("current/x.sog", "versions/abc/x.sog", "poster.webp", "manifest.json"):
            for scope in (SceneAssetAccessScope.OWNER, SceneAssetAccessScope.SHARE):
                header = build_cache_control(scope, rel)
                assert "public" not in header, (scope, rel, header)


# ── endpoint: real asset response headers (§12) ────────────────────────────
class TestRealEndpointCacheHeaders:
    def test_public_current_no_cache_and_versioned_immutable(self, db, origin, anon_client):
        scene = create_scene(
            session=db,
            visibility="PUBLIC",
            status="PUBLISHED",
            slug=f"cache-{uuid.uuid4().hex[:8]}",
        )
        _write_origin(origin, scene.slug)

        current = anon_client.get(
            f"/api/v1/scenes/{scene.slug}/assets/current/lod-meta.json"
        )
        assert current.status_code == 200
        assert "public, no-cache" == current.headers.get("cache-control"), (
            current.headers.get("cache-control"),
        )
        # 绝不 immutable
        assert "immutable" not in (current.headers.get("cache-control") or "")

        versioned = anon_client.get(
            f"/api/v1/scenes/{scene.slug}/assets/versions/v1/lod-meta.json"
        )
        assert versioned.status_code == 200
        assert "public, max-age=31536000, immutable" == versioned.headers.get(
            "cache-control"
        )

    def test_owner_private_scene_never_public_cache(self, db, origin):
        from app.core.identity import _resolve_dev_user_id

        owner_id = _resolve_dev_user_id(settings)
        scene = create_scene(
            session=db,
            visibility="PRIVATE",
            status="PUBLISHED",
            slug=f"pcache-{uuid.uuid4().hex[:8]}",
            owner_id=owner_id,
        )
        _write_origin(origin, scene.slug)
        resp = client.get(f"/api/v1/scenes/{scene.slug}/assets/current/lod-meta.json")
        assert resp.status_code == 200
        header = resp.headers.get("cache-control") or ""
        assert "public" not in header, header
        assert "private, no-cache" == header
