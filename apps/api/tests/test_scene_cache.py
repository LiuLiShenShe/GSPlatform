"""FIX-05 §10-§12 / FIX-05C — Cache-Control matrix (public/private/share ×
current/versioned × manifest/poster).

Unit-level: :func:`build_cache_control` over the full access-scope × path
matrix.  Endpoint-level: real asset endpoint response headers (public current
→ no-cache; public versioned → immutable; SHARE → never long-cached).

FIX-05C precedence: SHARE → current/* → versions/* → top-level manifest /
poster → default.  The manifest/poster filename special-cases MUST NOT
override a scope or path rule — ``current/manifest.json`` is no-cache,
``versions/v1/manifest.json`` is immutable, and any SHARE asset is
``private, no-cache``.  The five historical bugs are locked by explicit
regression tests (TestCachePriorityRegression).
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
POSTER_PUBLIC = "public, max-age=86400"
POSTER_PRIVATE = "private, max-age=86400"


# ── unit: build_cache_control matrix（FIX-05C 优先级）─────────────────────────
class TestBuildCacheControl:
    @pytest.mark.parametrize(
        ("scope", "rel", "expected"),
        [
            # ── PUBLIC ──────────────────────────────────────────────────────
            # current/* → no-cache，文件名特例不得覆盖（current 可重指向 — P1-2）
            (SceneAssetAccessScope.PUBLIC, "current/manifest.json", PUBLIC_NO_CACHE),
            (SceneAssetAccessScope.PUBLIC, "current/poster.webp", PUBLIC_NO_CACHE),
            (SceneAssetAccessScope.PUBLIC, "current/model.sog", PUBLIC_NO_CACHE),
            (SceneAssetAccessScope.PUBLIC, "current/chunks/0000.webp", PUBLIC_NO_CACHE),
            # versions/<ver>/* → immutable，含 manifest/poster（内容寻址）
            (SceneAssetAccessScope.PUBLIC, "versions/v1/manifest.json", PUBLIC_IMMUTABLE),
            (SceneAssetAccessScope.PUBLIC, "versions/v1/poster.webp", PUBLIC_IMMUTABLE),
            (SceneAssetAccessScope.PUBLIC, "versions/v1/model.sog", PUBLIC_IMMUTABLE),
            (SceneAssetAccessScope.PUBLIC, "versions/v1/0_0/chunk.webp", PUBLIC_IMMUTABLE),
            # 顶层 manifest / poster 特例（非 current/versions）
            (SceneAssetAccessScope.PUBLIC, "manifest.json", MANIFEST_PUBLIC),
            (SceneAssetAccessScope.PUBLIC, "poster.webp", POSTER_PUBLIC),
            # ── OWNER ───────────────────────────────────────────────────────
            (SceneAssetAccessScope.OWNER, "current/manifest.json", PRIVATE_NO_CACHE),
            (SceneAssetAccessScope.OWNER, "current/poster.webp", PRIVATE_NO_CACHE),
            (SceneAssetAccessScope.OWNER, "current/model.sog", PRIVATE_NO_CACHE),
            (SceneAssetAccessScope.OWNER, "versions/v1/manifest.json", PRIVATE_IMMUTABLE),
            (SceneAssetAccessScope.OWNER, "versions/v1/poster.webp", PRIVATE_IMMUTABLE),
            (SceneAssetAccessScope.OWNER, "versions/v1/model.sog", PRIVATE_IMMUTABLE),
            (SceneAssetAccessScope.OWNER, "manifest.json", MANIFEST_PRIVATE),
            (SceneAssetAccessScope.OWNER, "poster.webp", POSTER_PRIVATE),
            # ── SHARE：一律 private, no-cache ────────────────────────────────
            (SceneAssetAccessScope.SHARE, "manifest.json", PRIVATE_NO_CACHE),
            (SceneAssetAccessScope.SHARE, "poster.webp", PRIVATE_NO_CACHE),
            (SceneAssetAccessScope.SHARE, "current/manifest.json", PRIVATE_NO_CACHE),
            (SceneAssetAccessScope.SHARE, "current/poster.webp", PRIVATE_NO_CACHE),
            (SceneAssetAccessScope.SHARE, "current/model.sog", PRIVATE_NO_CACHE),
            (SceneAssetAccessScope.SHARE, "versions/v1/manifest.json", PRIVATE_NO_CACHE),
            (SceneAssetAccessScope.SHARE, "versions/v1/poster.webp", PRIVATE_NO_CACHE),
            (SceneAssetAccessScope.SHARE, "versions/v1/model.sog", PRIVATE_NO_CACHE),
            (SceneAssetAccessScope.SHARE, "versions/v1/0_0/chunk.webp", PRIVATE_NO_CACHE),
        ],
    )
    def test_matrix(self, scope, rel, expected):
        assert build_cache_control(scope, rel) == expected

    def test_share_never_long_cached_any_asset(self):
        for rel in (
            "manifest.json",
            "poster.webp",
            "current/manifest.json",
            "current/poster.webp",
            "current/x.sog",
            "versions/v1/manifest.json",
            "versions/v1/poster.webp",
            "versions/v1/x.sog",
        ):
            header = build_cache_control(SceneAssetAccessScope.SHARE, rel)
            assert header == PRIVATE_NO_CACHE, (rel, header)
            # SHARE 矩阵禁止 public / immutable / 任何 max-age（可吊销 token）
            for banned in ("public", "immutable", "max-age="):
                assert banned not in header, (rel, header)

    def test_private_never_public_even_immutable_paths(self):
        for rel in ("current/x.sog", "versions/abc/x.sog", "poster.webp", "manifest.json"):
            for scope in (SceneAssetAccessScope.OWNER, SceneAssetAccessScope.SHARE):
                header = build_cache_control(scope, rel)
                assert "public" not in header, (scope, rel, header)


# ── FIX-05C §8：五个历史 bug 的优先级回归锁 ──────────────────────────────────
class TestCachePriorityRegression:
    """文件名特例（manifest/poster）不得再次覆盖 scope/路径语义。"""

    def test_current_manifest_json_never_60s(self):
        header = build_cache_control(SceneAssetAccessScope.PUBLIC, "current/manifest.json")
        assert header != MANIFEST_PUBLIC          # 历史 bug：current/manifest → 60s
        assert header == PUBLIC_NO_CACHE

    def test_current_poster_webp_never_1day(self):
        header = build_cache_control(SceneAssetAccessScope.PUBLIC, "current/poster.webp")
        assert header != POSTER_PUBLIC            # 历史 bug：current/poster → 1d
        assert header == PUBLIC_NO_CACHE

    def test_versions_manifest_never_60s(self):
        header = build_cache_control(SceneAssetAccessScope.PUBLIC, "versions/v1/manifest.json")
        assert header != MANIFEST_PUBLIC          # 历史 bug：versions/manifest → 60s
        assert header == PUBLIC_IMMUTABLE

    def test_versions_poster_never_1day(self):
        header = build_cache_control(SceneAssetAccessScope.PUBLIC, "versions/v1/poster.webp")
        assert header != POSTER_PUBLIC            # 历史 bug：versions/poster → 1d
        assert header == PUBLIC_IMMUTABLE

    def test_share_poster_never_long_max_age(self):
        header = build_cache_control(SceneAssetAccessScope.SHARE, "poster.webp")
        assert header != POSTER_PRIVATE           # 历史 bug：SHARE+poster → private 1d
        assert "max-age=" not in header
        assert header == PRIVATE_NO_CACHE


# ── FIX-05C.1 §5：manifest/poster 特例只对顶层文件生效 ────────────────────────
class TestTopLevelSpecialCaseOnly:
    """top-level special-case ≠ basename special-case (nested → default)."""

    @pytest.mark.parametrize(
        ("rel", "expected_public"),
        [
            # 顶层 → 特例保留（FIX-05C 不回归）
            ("manifest.json", MANIFEST_PUBLIC),
            ("poster.webp", POSTER_PUBLIC),
            # 嵌套 → 回落 default（no-cache），不再继承顶层 TTL
            ("foo/manifest.json", PUBLIC_NO_CACHE),
            ("foo/poster.webp", PUBLIC_NO_CACHE),
            ("nested/path/manifest.json", PUBLIC_NO_CACHE),
            ("nested/path/poster.webp", PUBLIC_NO_CACHE),
            ("media/poster.webp", PUBLIC_NO_CACHE),
        ],
    )
    def test_public_nested_paths_fall_back_to_no_cache(self, rel, expected_public):
        assert build_cache_control(SceneAssetAccessScope.PUBLIC, rel) == expected_public

    @pytest.mark.parametrize("rel", ["foo/manifest.json", "foo/poster.webp"])
    def test_owner_nested_paths_are_private_no_cache(self, rel):
        # OWNER 嵌套路径 → 默认 private no-cache（不是 poster 的 1day 特例）
        assert build_cache_control(SceneAssetAccessScope.OWNER, rel) == PRIVATE_NO_CACHE

    @pytest.mark.parametrize(
        "rel", ["manifest.json", "poster.webp", "foo/manifest.json", "foo/poster.webp"]
    )
    def test_share_nested_and_top_level_both_private_no_cache(self, rel):
        assert build_cache_control(SceneAssetAccessScope.SHARE, rel) == PRIVATE_NO_CACHE

    def test_current_and_versioned_precedence_not_regressed(self):
        # 顶层特例绝不覆盖 current/* 与 versions/*
        assert (
            build_cache_control(SceneAssetAccessScope.PUBLIC, "current/manifest.json")
            == PUBLIC_NO_CACHE
        )
        assert (
            build_cache_control(SceneAssetAccessScope.PUBLIC, "current/poster.webp")
            == PUBLIC_NO_CACHE
        )
        assert (
            build_cache_control(SceneAssetAccessScope.PUBLIC, "versions/v1/manifest.json")
            == PUBLIC_IMMUTABLE
        )
        assert (
            build_cache_control(SceneAssetAccessScope.PUBLIC, "versions/v1/poster.webp")
            == PUBLIC_IMMUTABLE
        )


# ── endpoint: real asset response headers（§9 / FIX-05C）──────────────────────
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

    def test_public_current_manifest_and_poster_no_cache(self, db, origin, anon_client):
        """真实 HTTP：current/manifest.json 与 current/poster.webp 必须 no-cache。"""
        scene = create_scene(
            session=db,
            visibility="PUBLIC",
            status="PUBLISHED",
            slug=f"cman-{uuid.uuid4().hex[:8]}",
        )
        slug_dir = _write_origin(origin, scene.slug)
        (slug_dir / "versions" / "v1" / "manifest.json").write_text("{}")
        (slug_dir / "versions" / "v1" / "poster.webp").write_bytes(b"v1-poster")

        for rel in ("current/manifest.json", "current/poster.webp"):
            resp = anon_client.get(f"/api/v1/scenes/{scene.slug}/assets/{rel}")
            assert resp.status_code == 200, rel
            header = resp.headers.get("cache-control") or ""
            assert header == "public, no-cache", (rel, header)

    def test_public_versioned_manifest_and_poster_immutable(self, db, origin, anon_client):
        """真实 HTTP：versions/v1/manifest.json 与 poster.webp 必须 immutable。"""
        scene = create_scene(
            session=db,
            visibility="PUBLIC",
            status="PUBLISHED",
            slug=f"vman-{uuid.uuid4().hex[:8]}",
        )
        slug_dir = _write_origin(origin, scene.slug)
        (slug_dir / "versions" / "v1" / "manifest.json").write_text("{}")
        (slug_dir / "versions" / "v1" / "poster.webp").write_bytes(b"v1-poster")

        for rel in ("versions/v1/manifest.json", "versions/v1/poster.webp"):
            resp = anon_client.get(f"/api/v1/scenes/{scene.slug}/assets/{rel}")
            assert resp.status_code == 200, rel
            header = resp.headers.get("cache-control") or ""
            assert header == "public, max-age=31536000, immutable", (rel, header)

    def test_share_asset_never_long_cached(self, db, origin, anon_client):
        """真实 HTTP：share token 场景的任何资产都 private, no-cache（可吊销）。"""
        from app.core.identity import _resolve_dev_user_id

        owner_id = _resolve_dev_user_id(settings)
        scene = create_scene(
            session=db,
            visibility="PRIVATE",
            status="PUBLISHED",
            slug=f"sharec-{uuid.uuid4().hex[:8]}",
            owner_id=owner_id,
        )
        _write_origin(origin, scene.slug)
        # 匿名不得直接访问私有场景（未认证 401 / 已认证非属主 403）
        denied = anon_client.get(f"/api/v1/scenes/{scene.slug}/assets/current/lod-meta.json")
        assert denied.status_code in (401, 403), denied.status_code

        token = client.post(f"/api/v1/shares/scenes/{scene.slug}").json()["token"]

        for rel in (
            "current/lod-meta.json",
            "versions/v1/lod-meta.json",
            "poster.webp",
        ):
            resp = anon_client.get(
                f"/api/v1/scenes/{scene.slug}/assets/{rel}?share={token}"
            )
            assert resp.status_code == 200, rel
            header = resp.headers.get("cache-control") or ""
            assert header == "private, no-cache", (rel, header)
            for banned in ("public", "immutable", "max-age="):
                assert banned not in header, (rel, header)

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
