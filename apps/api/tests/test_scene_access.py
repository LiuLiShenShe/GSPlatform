"""FIX-01 §13 — unified scene access policy, HTTP level.

The dev-identity bypass makes every TestClient request resolve to the dev
user, so the genuinely-anonymous rows are exercised two ways:

  - **HTTP** rows override the identity dependency to return ``None``
    (a true anonymous caller) and assert the wire status;
  - **service** rows call the policy with ``identity=None`` directly, which
    is exactly what the runtime/asset paths pass for an anonymous visitor.

Matrix (FIXED policy):
  owner, any non-deleted status/visibility            → 200
  anonymous + PUBLIC + PUBLISHED                      → 200
  anonymous + PUBLIC + READY                          → 401  (was 200, P1-1)
  anonymous + PRIVATE + PUBLISHED                     → 401
  other user + PRIVATE + PUBLISHED                    → 403
  owner + deleted                                     → 404  (was 200, P1-2)
  anonymous + deleted PUBLIC                          → 404
  other user + deleted                                → 404
  anonymous + UNLISTED + PUBLISHED                    → 401
  anonymous + missing                                 → 404
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.core.errors import ForbiddenError, NotFoundError, UnauthorizedError
from app.db.models.scene import Scene
from app.db.models.user import User
from app.main import app
from app.services.scene_access import SceneAccessPolicy
from tests.conftest_scenes import create_scene

# module-level client (dev bypass) for owner/other-user rows
client = TestClient(app)


@pytest.fixture
def anon_client() -> TestClient:
    """A TestClient that behaves like a genuinely anonymous caller.

    The dev-identity bypass (conftest) makes every normal request resolve to
    the dev user, so the anonymous rows override the identity dependency to
    return ``None`` and assert the real wire status.  The override is scoped
    to the test via fixture teardown.
    """
    from app.core.identity import get_optional_current_user

    app.dependency_overrides[get_optional_current_user] = lambda: None
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_optional_current_user, None)


def _runtime(slug: str):
    return f"/api/v1/scenes/{slug}/runtime"


def _attach_version(db, scene) -> None:
    """Give *scene* a current streamed-sog version (needed by resolve_share)."""
    from app.db.models.scene import SceneVersion

    version = SceneVersion(
        scene_id=scene.id,
        asset_version=uuid.uuid4().hex[:40],
        format="streamed-sog",
        size_bytes=1024,
        manifest={"format": "streamed-sog", "stream": {}},
    )
    db.add(version)
    db.flush()
    scene.current_version_id = version.id
    db.commit()
    db.refresh(scene)


def _other_user(db) -> User:
    user = User(email=f"fix13-{uuid.uuid4().hex[:8]}@example.com", display_name="他人")
    db.add(user)
    db.flush()
    return user


def _make_scene(db, *, status, visibility, owner_id=None, slug=None, deleted=False):
    scene = Scene(
        owner_id=owner_id or None,
        slug=slug or f"fix13-{uuid.uuid4().hex[:8]}",
        title="策略测试场景",
        description="policy",
        category="experiment",
        visibility=visibility,
        status=status,
        views=0,
        likes=0,
    )
    if deleted:
        scene.deleted_at = datetime.now(UTC)
    db.add(scene)
    db.flush()
    db.commit()
    db.refresh(scene)
    return scene


# ── owner ──────────────────────────────────────────────────────────────────
class TestOwnerAccess:
    def test_owner_public_published_allowed(self, db):
        scene = create_scene(session=db, visibility="PUBLIC", status="PUBLISHED")
        assert client.get(_runtime(scene.slug)).status_code == 200

    def test_owner_private_published_allowed(self, private_scene):
        assert client.get(_runtime(private_scene.slug)).status_code == 200

    def test_owner_ready_private_allowed(self, db):
        """Owner can preview a READY (unpublished) private scene."""
        from app.core.config import settings
        from app.core.identity import _resolve_dev_user_id

        scene = _make_scene(
            db,
            status="READY",
            visibility="PRIVATE",
            owner_id=_resolve_dev_user_id(settings),
        )
        assert client.get(_runtime(scene.slug)).status_code == 200

    def test_owner_draft_private_allowed(self, draft_scene):
        assert client.get(_runtime(draft_scene.slug)).status_code == 200

    def test_owner_detail_allowed(self, private_scene):
        resp = client.get(f"/api/v1/scenes/{private_scene.slug}")
        assert resp.status_code == 200


# ── anonymous public + published ────────────────────────────────────────────
class TestAnonymousPublic:
    def test_anonymous_public_published_allowed(self, db, anon_client):
        scene = create_scene(session=db, visibility="PUBLIC", status="PUBLISHED")
        assert anon_client.get(_runtime(scene.slug)).status_code == 200


# ── P1-1: PUBLIC + READY must NOT be anonymously readable ───────────────────
class TestPublicReadyNotAnonymous:
    def test_anonymous_public_ready_denied_401(self, db, anon_client):
        scene = create_scene(session=db, visibility="PUBLIC", status="READY")
        assert anon_client.get(_runtime(scene.slug)).status_code == 401

    def test_public_ready_detail_denied_401(self, db, anon_client):
        scene = create_scene(session=db, visibility="PUBLIC", status="READY")
        assert anon_client.get(f"/api/v1/scenes/{scene.slug}").status_code == 401

    def test_public_ready_excluded_from_public_list(self, db, anon_client):
        """The works hall only lists PUBLIC+PUBLISHED; READY must not appear."""
        scene = create_scene(session=db, visibility="PUBLIC", status="READY")
        resp = anon_client.get("/api/v1/scenes?limit=100")
        assert resp.status_code == 200
        assert scene.slug not in {item["id"] for item in resp.json()["items"]}


# ── anonymous private ───────────────────────────────────────────────────────
class TestAnonymousPrivate:
    def test_anonymous_private_published_denied_401(self, db, anon_client):
        other = _other_user(db)
        db.commit()
        scene = _make_scene(
            db, status="PUBLISHED", visibility="PRIVATE", owner_id=other.id
        )
        assert anon_client.get(_runtime(scene.slug)).status_code == 401

    def test_anonymous_unlisted_published_denied_401(self, db, anon_client):
        other = _other_user(db)
        db.commit()
        scene = _make_scene(
            db, status="PUBLISHED", visibility="UNLISTED", owner_id=other.id
        )
        assert anon_client.get(_runtime(scene.slug)).status_code == 401

    def test_anonymous_draft_denied_401(self, draft_scene, anon_client):
        assert anon_client.get(_runtime(draft_scene.slug)).status_code == 401


# ── other user ──────────────────────────────────────────────────────────────
class TestOtherUserAccess:
    def test_other_user_private_published_403(self, db):
        other = _other_user(db)
        db.commit()
        scene = _make_scene(
            db, status="PUBLISHED", visibility="PRIVATE", owner_id=other.id
        )
        assert client.get(_runtime(scene.slug)).status_code == 403

    def test_other_user_unlisted_published_403(self, db):
        other = _other_user(db)
        db.commit()
        scene = _make_scene(
            db, status="PUBLISHED", visibility="UNLISTED", owner_id=other.id
        )
        assert client.get(_runtime(scene.slug)).status_code == 403

    def test_other_user_public_ready_403(self, db):
        other = _other_user(db)
        db.commit()
        scene = _make_scene(
            db, status="READY", visibility="PUBLIC", owner_id=other.id
        )
        assert client.get(_runtime(scene.slug)).status_code == 403


# ── P1-2: deleted scenes are invisible everywhere ───────────────────────────
class TestDeletedInvisible:
    def test_owner_deleted_denied_404(self, db):
        from app.core.config import settings
        from app.core.identity import _resolve_dev_user_id

        scene = _make_scene(
            db,
            status="PUBLISHED",
            visibility="PRIVATE",
            owner_id=_resolve_dev_user_id(settings),
            deleted=True,
        )
        assert client.get(_runtime(scene.slug)).status_code == 404

    def test_anonymous_deleted_public_denied_404(self, db, anon_client):
        other = _other_user(db)
        db.commit()
        scene = _make_scene(
            db,
            status="PUBLISHED",
            visibility="PUBLIC",
            owner_id=other.id,
            deleted=True,
        )
        assert anon_client.get(_runtime(scene.slug)).status_code == 404

    def test_other_user_deleted_denied_404(self, db):
        other = _other_user(db)
        db.commit()
        scene = _make_scene(
            db,
            status="PUBLISHED",
            visibility="PRIVATE",
            owner_id=other.id,
            deleted=True,
        )
        assert client.get(_runtime(scene.slug)).status_code == 404

    def test_deleted_detail_404(self, db):
        from app.core.config import settings
        from app.core.identity import _resolve_dev_user_id

        scene = _make_scene(
            db,
            status="PUBLISHED",
            visibility="PRIVATE",
            owner_id=_resolve_dev_user_id(settings),
            deleted=True,
        )
        assert client.get(f"/api/v1/scenes/{scene.slug}").status_code == 404


# ── missing ─────────────────────────────────────────────────────────────────
class TestMissing:
    def test_anonymous_missing_404(self, anon_client):
        assert anon_client.get(_runtime("no-such-scene-xyz")).status_code == 404

    def test_authenticated_missing_404(self):
        assert client.get(_runtime("no-such-scene-xyz")).status_code == 404


# ── SHARE grant (reuse of the existing token mechanism, FIX-01 §3) ─────────
class TestShareGrant:
    def _create_share(self, db, scene, *, hours=None) -> dict:
        from app.services.share_service import ShareService

        result = ShareService(db).create_share(
            owner_id=scene.owner_id, scene_slug=scene.slug, hours=hours
        )
        db.commit()
        return result

    def test_share_token_grants_runtime_to_anonymous(self, db, anon_client):
        """?share=<token> on the runtime route → 200 for an anonymous caller."""
        other = _other_user(db)
        db.commit()
        scene = _make_scene(
            db, status="PUBLISHED", visibility="PRIVATE", owner_id=other.id
        )
        share = self._create_share(db, scene)
        assert share["token"] is not None
        assert anon_client.get(_runtime(scene.slug)).status_code == 401  # no token
        assert (
            anon_client.get(_runtime(scene.slug) + f"?share={share['token']}").status_code
            == 200
        )

    def test_share_token_grants_asset_to_anonymous(self, db, anon_client, monkeypatch, tmp_path):
        """A shared scene's asset bytes are readable via the grant."""

        other = _other_user(db)
        db.commit()
        scene = _make_scene(
            db, status="PUBLISHED", visibility="PRIVATE", owner_id=other.id
        )
        share = self._create_share(db, scene)
        monkeypatch.setattr(settings, "scene_origin_root", str(tmp_path))
        (tmp_path / scene.slug).mkdir(parents=True, exist_ok=True)
        (tmp_path / scene.slug / "poster.webp").write_bytes(b"shared-poster")
        assert anon_client.get(
            f"/api/v1/scenes/{scene.slug}/assets/poster.webp"
        ).status_code == 401
        assert (
            anon_client.get(
                f"/api/v1/scenes/{scene.slug}/assets/poster.webp",
                params={"share": share["token"]},
            ).status_code
            == 200
        )

    def test_resolve_sets_share_cookie_and_grants_followups(self, db, anon_client):
        """/shares/resolve/{token} sets gs_share so viewer chunk fetches work.

        The descriptor + every asset fetch must carry the grant without the
        token in the URL (the official viewer loads LOD chunks with its own
        loader, so the token cannot be threaded through by hand).
        """
        other = _other_user(db)
        db.commit()
        scene = _make_scene(
            db, status="PUBLISHED", visibility="PRIVATE", owner_id=other.id
        )
        _attach_version(db, scene)
        share = self._create_share(db, scene)
        # anonymous resolve → Set-Cookie gs_share
        resp = anon_client.get(f"/api/v1/shares/resolve/{share['token']}")
        assert resp.status_code == 200
        cookie_header = resp.headers.get("set-cookie", "")
        assert settings.share_cookie_name in cookie_header
        assert "HttpOnly" in cookie_header
        # follow-up runtime fetch carries the cookie → 200
        anon_client.cookies.set(settings.share_cookie_name, share["token"])
        assert anon_client.get(_runtime(scene.slug)).status_code == 200

    def test_expired_share_token_denied(self, db, anon_client):

        other = _other_user(db)
        db.commit()
        scene = _make_scene(
            db, status="PUBLISHED", visibility="PRIVATE", owner_id=other.id
        )
        # expired link: hours in the past
        from datetime import UTC, datetime, timedelta

        from app.core.security import generate_share_token, sha256_hex
        from app.db.models.share_link import ShareLink

        raw = generate_share_token()
        db.add(
            ShareLink(
                scene_id=scene.id,
                owner_id=scene.owner_id,
                token_hash=sha256_hex(raw),
                expires_at=datetime.now(UTC) - timedelta(hours=1),
            )
        )
        db.commit()
        assert anon_client.get(_runtime(scene.slug) + f"?share={raw}").status_code == 401

    def test_revoked_share_token_denied(self, db, anon_client):
        other = _other_user(db)
        db.commit()
        scene = _make_scene(
            db, status="PUBLISHED", visibility="PRIVATE", owner_id=other.id
        )
        share = self._create_share(db, scene)
        from app.core.security import sha256_hex
        from app.db.models.share_link import ShareLink

        link = (
            db.query(ShareLink)
            .filter(ShareLink.token_hash == sha256_hex(share["token"]))
            .first()
        )
        link.revoked_at = datetime.now(UTC)
        db.commit()
        assert anon_client.get(_runtime(scene.slug) + f"?share={share['token']}").status_code == 401


# ── policy at the service boundary (the exact call the runtime uses) ────────
class TestPolicyServiceLevel:
    def test_anonymous_private_raises_unauthorized(self, db):
        other = _other_user(db)
        db.commit()
        scene = _make_scene(
            db, status="PUBLISHED", visibility="PRIVATE", owner_id=other.id
        )
        policy = SceneAccessPolicy(db)
        with pytest.raises(UnauthorizedError):
            policy.resolve_readable_scene(scene.slug, None)

    def test_anonymous_public_ready_raises_unauthorized(self, db):
        scene = create_scene(session=db, visibility="PUBLIC", status="READY")
        policy = SceneAccessPolicy(db)
        with pytest.raises(UnauthorizedError):
            policy.resolve_readable_scene(scene.slug, None)

    def test_anonymous_public_published_returns(self, db):
        scene = create_scene(session=db, visibility="PUBLIC", status="PUBLISHED")
        policy = SceneAccessPolicy(db)
        assert policy.resolve_readable_scene(scene.slug, None).id == scene.id

    def test_other_user_private_raises_forbidden(self, db):
        from app.core.config import settings
        from app.core.identity import RequestIdentity, _resolve_dev_user_id

        other = _other_user(db)
        db.commit()
        scene = _make_scene(
            db, status="PUBLISHED", visibility="PRIVATE", owner_id=other.id
        )
        dev = RequestIdentity(
            user_id=_resolve_dev_user_id(settings),
            email="dev@gsplatform.local",
            display_name="dev",
        )
        policy = SceneAccessPolicy(db)
        with pytest.raises(ForbiddenError):
            policy.resolve_readable_scene(scene.slug, dev)

    def test_deleted_raises_not_found(self, db):
        from app.core.config import settings
        from app.core.identity import RequestIdentity, _resolve_dev_user_id

        scene = _make_scene(
            db,
            status="PUBLISHED",
            visibility="PRIVATE",
            owner_id=_resolve_dev_user_id(settings),
            deleted=True,
        )
        owner = RequestIdentity(
            user_id=scene.owner_id,
            email="dev@gsplatform.local",
            display_name="dev",
        )
        policy = SceneAccessPolicy(db)
        with pytest.raises(NotFoundError):
            policy.resolve_readable_scene(scene.slug, owner)
        with pytest.raises(NotFoundError):
            policy.resolve_readable_scene(scene.slug, None)
