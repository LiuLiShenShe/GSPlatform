"""FIX-01 §12/§14 — authorized asset delivery: permissions, Range, traversal.

Under dev bypass every normal request is the dev user; anonymous rows use the
``anon_client`` fixture (dependency override → identity None).

Layout (monkeypatched scene_origin_root):

    <tmp>/<slug>/poster.webp              real file
    <tmp>/<slug>/scene.sog                real file (also target of ./current)
    <tmp>/<slug>/versions/v1/lod-meta.json  real file
    <tmp>/<slug>/current -> versions/v1   relative symlink (legit escape into
                                          the version dir within the scene)
    <tmp>/<slug>/evil -> /etc             symlink escape → must be rejected
    <tmp>/<slug>/linked -> ../<other>     symlink escape into origin root but
                                          OUTSIDE this scene → rejected

Asset matrix (FIXED):
  private asset, anonymous                → 401
  private asset, owner                    → 200
  public+published asset, anonymous       → 200
  public+ready asset, anonymous           → 401
  deleted scene asset, owner/anonymous    → 404
  missing asset                           → 404
  Range: bytes=0-3                        → 206 + Content-Range
  Range: unsatisfiable                    → 416

Traversal matrix (all must be rejected, 404):
  ../secret, %2e%2e%2f, %2E%2E, ..%2f, encoded slash, absolute path,
  Windows backslash, %00 NUL, %25 in segment, symlink escapes, invalid slug
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.core.errors import NotFoundError
from app.db.models.scene import Scene
from app.db.models.user import User
from app.main import app
from app.services.scene_access import is_publicly_visible
from app.services.scene_asset import (
    SceneAssetService,
)
from tests.conftest_scenes import create_scene

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

    root = tmp_path_factory.mktemp("scene-origin")
    monkeypatch.setattr(settings, "scene_origin_root", str(root))
    return root


def _write_origin(origin, slug: str):
    """Materialize <slug> tree described in the module docstring."""
    import os

    slug_dir = origin / slug
    versions = slug_dir / "versions" / "v1"
    versions.mkdir(parents=True, exist_ok=True)
    (versions / "lod-meta.json").write_text('{"entryUrl":"versions/v1/lod-meta.json"}')
    (slug_dir / "poster.webp").write_bytes(b"fake-poster-webp-bytes")
    (slug_dir / "scene.sog").write_bytes(b"S" * 4096)
    os.symlink("versions/v1", slug_dir / "current", target_is_directory=True)
    os.symlink("/etc", slug_dir / "evil")          # absolute escape
    os.symlink(
        os.path.join(str(origin / "sibling" / "secret.sog")), slug_dir / "linked"
    )
    (origin / "sibling").mkdir(exist_ok=True)
    (origin / "sibling" / "secret.sog").write_bytes(b"OTHER-SCENE-SECRET")
    return slug_dir


def _other_user(db) -> User:
    user = User(email=f"fix14-{uuid.uuid4().hex[:8]}@example.com", display_name="他人")
    db.add(user)
    db.flush()
    return user


def _priv_scene(db, *, owner_id):
    scene = Scene(
        owner_id=owner_id,
        slug=f"a14-{uuid.uuid4().hex[:8]}",
        title="私密资产场景",
        description="assets",
        category="experiment",
        visibility="PRIVATE",
        status="PUBLISHED",
        views=0,
        likes=0,
    )
    db.add(scene)
    db.commit()
    db.refresh(scene)
    return scene


# ── permission matrix (§14) ────────────────────────────────────────────────
class TestAssetPermission:
    def test_private_asset_anonymous_denied_401(self, db, origin, anon_client):
        other = _other_user(db)
        db.commit()
        scene = _priv_scene(db, owner_id=other.id)
        _write_origin(origin, scene.slug)
        resp = anon_client.get(
            f"/api/v1/scenes/{scene.slug}/assets/poster.webp"
        )
        assert resp.status_code == 401

    def test_private_asset_owner_allowed_200(self, db, origin):
        from app.core.identity import _resolve_dev_user_id

        scene = _priv_scene(db, owner_id=_resolve_dev_user_id(settings))
        _write_origin(origin, scene.slug)
        resp = client.get(f"/api/v1/scenes/{scene.slug}/assets/poster.webp")
        assert resp.status_code == 200
        assert resp.content == b"fake-poster-webp-bytes"
        assert resp.headers["content-type"] == "image/webp"

    def test_public_published_asset_anonymous_allowed_200(self, db, origin, anon_client):
        scene = create_scene(
            session=db, visibility="PUBLIC", status="PUBLISHED", slug=f"apub-{uuid.uuid4().hex[:8]}"
        )
        _write_origin(origin, scene.slug)
        resp = anon_client.get(f"/api/v1/scenes/{scene.slug}/assets/poster.webp")
        assert resp.status_code == 200
        assert resp.content == b"fake-poster-webp-bytes"

    def test_public_ready_asset_anonymous_denied_401(self, db, origin, anon_client):
        scene = create_scene(
            session=db, visibility="PUBLIC", status="READY", slug=f"aready-{uuid.uuid4().hex[:8]}"
        )
        _write_origin(origin, scene.slug)
        resp = anon_client.get(f"/api/v1/scenes/{scene.slug}/assets/poster.webp")
        assert resp.status_code == 401

    def test_deleted_scene_asset_denied_404(self, db, origin, anon_client):
        from app.core.identity import _resolve_dev_user_id

        scene = Scene(
            owner_id=_resolve_dev_user_id(settings),
            slug=f"adel-{uuid.uuid4().hex[:8]}",
            title="删除场景资产",
            description="assets",
            category="experiment",
            visibility="PRIVATE",
            status="PUBLISHED",
            views=0,
            likes=0,
        )
        db.add(scene)
        db.commit()
        scene.deleted_at = __import__("datetime").datetime.now()
        db.commit()
        _write_origin(origin, scene.slug)
        # owner request (dev user) AND anonymous must both get 404
        assert client.get(f"/api/v1/scenes/{scene.slug}/assets/poster.webp").status_code == 404
        assert anon_client.get(f"/api/v1/scenes/{scene.slug}/assets/poster.webp").status_code == 404

    def test_missing_asset_404(self, db, origin):
        from app.core.identity import _resolve_dev_user_id

        scene = Scene(
            owner_id=_resolve_dev_user_id(settings),
            slug=f"amiss-{uuid.uuid4().hex[:8]}",
            title="缺失资产",
            description="assets",
            category="experiment",
            visibility="PRIVATE",
            status="PUBLISHED",
            views=0,
            likes=0,
        )
        db.add(scene)
        db.commit()
        _write_origin(origin, scene.slug)
        resp = client.get(f"/api/v1/scenes/{scene.slug}/assets/no-such-file.bin")
        assert resp.status_code == 404


# ── Range (§7 / §14) ───────────────────────────────────────────────────────
class TestRangeRequests:
    def test_range_206_with_content_range(self, db, origin, anon_client):
        scene = create_scene(
            session=db, visibility="PUBLIC", status="PUBLISHED",
                slug=f"arange-{uuid.uuid4().hex[:8]}"
        )
        _write_origin(origin, scene.slug)
        resp = anon_client.get(
            f"/api/v1/scenes/{scene.slug}/assets/scene.sog",
            headers={"Range": "bytes=0-3"},
        )
        assert resp.status_code == 206
        assert resp.headers["content-range"] == "bytes 0-3/4096"
        assert resp.content == b"SSSS"

    def test_range_416_unsatisfiable(self, db, origin, anon_client):
        scene = create_scene(
            session=db, visibility="PUBLIC", status="PUBLISHED",
                slug=f"ar416-{uuid.uuid4().hex[:8]}"
        )
        _write_origin(origin, scene.slug)
        resp = anon_client.get(
            f"/api/v1/scenes/{scene.slug}/assets/scene.sog",
            headers={"Range": "bytes=99999-"},
        )
        assert resp.status_code == 416
        assert "bytes */4096" in resp.headers["content-range"]

    def test_full_get_advertises_accept_ranges(self, db, origin, anon_client):
        scene = create_scene(
            session=db, visibility="PUBLIC", status="PUBLISHED",
                slug=f"ahead-{uuid.uuid4().hex[:8]}"
        )
        _write_origin(origin, scene.slug)
        resp = anon_client.get(f"/api/v1/scenes/{scene.slug}/assets/scene.sog")
        assert resp.status_code == 200
        assert resp.headers.get("accept-ranges") == "bytes"
        assert len(resp.content) == 4096


# ── traversal (§12) ────────────────────────────────────────────────────────
class TestTraversal:
    def test_dotdot_http_denied(self, db, origin, anon_client):
        """%2e%2e%2f must be rejected (uvicorn decodes it to ../)."""
        scene = create_scene(
            session=db, visibility="PUBLIC", status="PUBLISHED", slug=f"atra-{uuid.uuid4().hex[:8]}"
        )
        _write_origin(origin, scene.slug)
        cases = [
            f"/api/v1/scenes/{scene.slug}/assets/../secret",
            f"/api/v1/scenes/{scene.slug}/assets/..%2fsecret",
            f"/api/v1/scenes/{scene.slug}/assets/%2e%2e%2fsecret",
            f"/api/v1/scenes/{scene.slug}/assets/%2E%2E%2fsecret",
            f"/api/v1/scenes/{scene.slug}/assets/%252e%252e%252fsecret",
            f"/api/v1/scenes/{scene.slug}/assets/..\\secret",
        ]
        for url in cases:
            resp = anon_client.get(url)
            assert resp.status_code == 404, url

    def test_invalid_slug_rejected_service_level(self, origin, monkeypatch):
        """A slug that could not have been created must never touch disk."""
        monkeypatch.setattr(settings, "scene_origin_root", str(origin))
        svc = SceneAssetService()
        scene = Scene(slug="../escape-{")
        with pytest.raises(NotFoundError):
            svc.resolve(scene, "x.sog")

    # service-level: every syntactic form is rejected without touching disk
    def test_service_rejects_traversal_forms(self, origin, monkeypatch):
        monkeypatch.setattr(settings, "scene_origin_root", str(origin))
        svc = SceneAssetService()
        scene = Scene(slug="safe-slug")
        _write_origin(origin, "safe-slug")
        evil = [
            "../secret.sog",
            "..%2Fsecret.sog",
            "../../etc/passwd",
            "/etc/passwd",
            "..\\secret.sog",
            "current/../../secret",
            "a/../b/../c",
            "with%20space/..",
            "nul\x00byte",
        ]
        for path in evil:
            with pytest.raises(NotFoundError):
                svc.resolve(scene, path)

    def test_service_allows_legit_symlink_chain(self, origin, monkeypatch):
        """current -> versions/v1 is a legit escape INSIDE the scene tree."""
        monkeypatch.setattr(settings, "scene_origin_root", str(origin))
        svc = SceneAssetService()
        scene = Scene(slug="safe-slug")
        _write_origin(origin, "safe-slug")
        resolved = svc.resolve(scene, "current/lod-meta.json")
        assert resolved.absolute_path.name == "lod-meta.json"

    def test_service_rejects_symlink_escape(self, origin, monkeypatch):
        """A symlink pointing OUTSIDE the scene (even into storage/published
        would be legit only for real version dirs; /etc is not) → 404."""
        monkeypatch.setattr(settings, "scene_origin_root", str(origin))
        svc = SceneAssetService()
        scene = Scene(slug="safe-slug")
        _write_origin(origin, "safe-slug")
        for path in ("evil/passwd", "linked"):
            with pytest.raises(NotFoundError):
                svc.resolve(scene, path)

    def test_is_publicly_visible_matches_policy(self, db):
        from datetime import UTC, datetime

        scene = create_scene(session=db, visibility="PUBLIC", status="PUBLISHED")
        assert is_publicly_visible(scene) is True
        scene2 = create_scene(session=db, visibility="PUBLIC", status="READY")
        assert is_publicly_visible(scene2) is False
        scene3 = create_scene(session=db, visibility="PRIVATE", status="PUBLISHED")
        assert is_publicly_visible(scene3) is False
        scene4 = create_scene(session=db, visibility="PUBLIC", status="PUBLISHED")
        scene4.deleted_at = datetime.now(UTC)
        db.commit()
        assert is_publicly_visible(scene4) is False
