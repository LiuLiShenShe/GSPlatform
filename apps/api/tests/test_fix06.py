"""FIX-06 tests — production integrity remediation.

Groups (spec §18):
  TestStorageTracked         — the storage package is tracked (gitignore gate)
  TestMediaAuthorization     — media serve routes honor the unified access policy
  TestCoverUrlRoundTrip      — coverUrl is slug-anchored and round-trips
  TestUploadStateMachine     — append/complete/cancel reject illegal states
  TestCompleteIdempotency    — complete twice → one Scene, one Job
  TestDispatchFailureRecovery— send_task failure → failed job + safe 503, upload recoverable
  TestPublishIdempotency     — commit_version/promote never duplicate or delete
  TestUploadCsrf             — session-mode CSRF enforced on upload writes
  TestComputeCsrf            — session-mode CSRF enforced on compute writes
  TestRateLimiterRedis       — shared Redis limiter: counting/TTL/over-limit/fallback
"""

from __future__ import annotations

import hashlib
import subprocess
import uuid
from datetime import UTC, datetime

import pytest
import redis
from fastapi.testclient import TestClient

from app.core.config import settings
from app.core.identity import _resolve_dev_user_id, get_optional_current_user
from app.core.paths import get_repo_root
from app.core.rate_limit import reset_rate_limits, reset_rate_limits_redis
from app.db.models.asset import Asset
from app.db.models.enums import AssetKind, JobKind, JobStatus
from app.db.models.job import Job
from app.db.models.scene import Scene, SceneVersion
from app.db.models.scene_annotation import SceneAnnotation
from app.db.models.scene_presentation import ScenePresentation
from app.db.models.share_link import ShareLink
from app.db.models.user import User
from app.main import app
from app.storage import LocalDiskStorage
from tests.conftest_scenes import create_scene

client = TestClient(app)

COVER_BYTES = b"\x89PNG\r\n\x1a\n" + b"FIX06-cover"
BG_BYTES = b"\x89PNG\r\n\x1a\n" + b"FIX06-background"
AUDIO_BYTES = b"\xff\xf3" + b"FIX06-audio"
ANN_MEDIA_BYTES = b"\x89PNG\r\n\x1a\n" + b"FIX06-annotation"


@pytest.fixture
def anon_client():
    app.dependency_overrides[get_optional_current_user] = lambda: None
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_optional_current_user, None)


@pytest.fixture(autouse=True)
def _clean_rate_limit_keys():
    yield
    for scope in ("login", "register", "share", "assistant"):
        reset_rate_limits(scope, "testclient")


# ── helpers ─────────────────────────────────────────────────────────────────
def _seed_media(db, scene, *, with_annotation: bool = True):
    """Create ScenePresentation + cover/background/background-audio assets and
    (optionally) an annotation with media — bytes written under storage_root,
    the same shape the authoring service produces."""
    storage = LocalDiskStorage(settings.storage_root)

    def _asset(kind: str, name: str, mime: str, data: bytes) -> Asset:
        key = f"presentation/{scene.id}/{name}"
        storage.write(key, data)
        return Asset(
            scene_id=scene.id,
            version_id=None,
            kind=kind,
            storage_key=key,
            mime_type=mime,
            byte_size=len(data),
            sha256=hashlib.sha256(data).hexdigest(),
            metadata_={},
        )

    cover = _asset(AssetKind.POSTER.value, "cover", "image/png", COVER_BYTES)
    bg = _asset("background", "background", "image/png", BG_BYTES)
    audio = _asset("background-audio", "background-audio", "audio/mpeg", AUDIO_BYTES)
    db.add_all([cover, bg, audio])
    db.flush()

    ann = None
    if with_annotation:
        ann = SceneAnnotation(
            scene_id=scene.id,
            title="媒体标注",
            anchor_x=1.0,
            anchor_y=2.0,
            anchor_z=3.0,
            style="LEADER_TEXT",
            content_type="IMAGE",
        )
        db.add(ann)
        db.flush()
        ann_media = _asset(
            AssetKind.ANNOTATION_MEDIA.value,
            f"annotations/{scene.id}/{ann.id}",
            "image/png",
            ANN_MEDIA_BYTES,
        )
        db.add(ann_media)
        db.flush()
        ann.media_asset_id = ann_media.id

    pres = ScenePresentation(
        scene_id=scene.id,
        cover_asset_id=cover.id,
        background_asset_id=bg.id,
        background_audio_asset_id=audio.id,
    )
    db.add(pres)
    db.commit()
    return ann


def _media_urls(scene, ann=None):
    """(label, url) pairs for the four media serve routes."""
    return [
        ("cover", f"/api/v1/scenes/{scene.slug}/presentation/cover"),
        ("background", f"/api/v1/scenes/{scene.slug}/presentation/background"),
        ("background-audio", f"/api/v1/scenes/{scene.slug}/presentation/background-audio"),
        (
            "annotation-media",
            f"/api/v1/scenes/{scene.slug}/annotations/{ann.id}/media"
            if ann is not None
            else None,
        ),
    ]


def _create_share_token(client, slug: str) -> str:
    resp = client.post(f"/api/v1/shares/scenes/{slug}")
    assert resp.status_code == 200, resp.text
    token = resp.json().get("token")
    assert token, "share token expected for private published scene"
    return token


def _revoke_share(db, scene) -> None:
    link = db.query(ShareLink).filter(ShareLink.scene_id == scene.id).first()
    assert link is not None
    link.revoked_at = datetime.now(UTC)
    db.commit()


@pytest.fixture
def session_client():
    """TestClient wired to real session auth (no dev bypass) — CSRF tests."""
    import app.core.config as config_mod

    original = config_mod.settings.dev_identity_enabled
    config_mod.settings.dev_identity_enabled = False
    try:
        with TestClient(app) as c:
            yield c
    finally:
        config_mod.settings.dev_identity_enabled = original


def _register_session(session_client) -> tuple[TestClient, str]:
    """Register a fresh session user; returns client + userId."""
    email = f"fix06-{uuid.uuid4().hex[:10]}@example.com"
    resp = session_client.post(
        "/api/v1/auth/register",
        json={
            "email": email,
            "password": "password-123",
            "displayName": "FIX06 user",
        },
    )
    assert resp.status_code == 200, resp.text
    return session_client, resp.json()["userId"]


def _create_full_upload(authed_client, size: int = 100, **overrides):
    payload = {
        "filename": "test.sog",
        "mime_type": "application/octet-stream",
        "size": size,
        "format": "sog",
        "title": "FIX06 场景",
        "category": "experiment",
        "visibility": "PRIVATE",
    }
    payload.update(overrides)
    created = authed_client.post("/api/v1/uploads", json=payload)
    assert created.status_code == 201, created.text
    uid = created.json()["uploadId"]
    patched = authed_client.patch(
        f"/api/v1/uploads/{uid}",
        content=b"\x00" * size,
        headers={
            "Upload-Offset": "0",
            "Content-Type": "application/octet-stream",
        },
    )
    assert patched.status_code == 200, patched.text
    return uid


# ── §18A storage tracking gate ──────────────────────────────────────────────
class TestStorageTracked:
    STORAGE_FILES = [
        "apps/api/app/storage/__init__.py",
        "apps/api/app/storage/base.py",
        "apps/api/app/storage/local_disk.py",
        "apps/api/app/storage/paths.py",
    ]

    @pytest.fixture(autouse=True)
    def _require_git_work_tree(self):
        """These are repo-level gates: in the clean-checkout gate the archive
        has no .git, so git ls-files/check-ignore are meaningless — the gate's
        own integrity section already asserts the storage files are present in
        the archive."""
        if not (get_repo_root() / ".git").exists():
            pytest.skip("not a git work tree (clean-checkout gate)")

    def _git(self, *args: str) -> subprocess.CompletedProcess:
        # noqa: S603, S607 — args are hardcoded literals, never user input.
        cmd = ["git", "-C", str(get_repo_root()), *args]  # noqa: S603, S607
        return subprocess.run(cmd, capture_output=True, text=True)  # noqa: S603

    def test_storage_package_is_tracked(self):
        """FIX-06 §1: the bare `storage/` gitignore rule previously hid the
        storage package — a tracked release must contain it."""
        ls = self._git("ls-files", "apps/api/app/storage").stdout
        for f in self.STORAGE_FILES:
            assert f in ls, f"not tracked: {f}"

    def test_storage_package_not_gitignored(self):
        for f in self.STORAGE_FILES:
            res = self._git("check-ignore", "--quiet", f)
            assert res.returncode == 1, f"{f} is ignored (exit {res.returncode})"

    def test_gitignore_uses_root_anchored_storage(self):
        gi = (get_repo_root() / ".gitignore").read_text()
        # Bare `storage/` (un-anchored) would ignore apps/api/app/storage/.
        assert "/storage/" in gi
        assert "\nstorage/\n" not in "\n" + gi + "\n"


# ── §18 media authorization matrix ──────────────────────────────────────────
class TestMediaAuthorization:
    def test_public_scene_media_anon_ok_public_no_cache(self, db, anon_client):
        scene = create_scene(session=db, visibility="PUBLIC", status="PUBLISHED")
        ann = _seed_media(db, scene)
        for _label, url in _media_urls(scene, ann):
            r = anon_client.get(url)
            assert r.status_code == 200, (_label, url, r.status_code)
            assert r.headers.get("cache-control") == "public, no-cache", _label

    def test_private_scene_media_anon_denied(self, db, anon_client):
        scene = create_scene(session=db, visibility="PRIVATE", status="PUBLISHED")
        ann = _seed_media(db, scene)
        for _label, url in _media_urls(scene, ann):
            r = anon_client.get(url)
            assert r.status_code in (401, 403), (_label, url, r.status_code)

    def test_private_scene_media_owner_ok_private_no_cache(self, db):
        scene = create_scene(
            session=db,
            visibility="PRIVATE",
            status="PUBLISHED",
            owner_id=_resolve_dev_user_id(settings),
        )
        ann = _seed_media(db, scene)
        for _label, url in _media_urls(scene, ann):
            r = client.get(url)
            assert r.status_code == 200, (_label, url, r.status_code)
            assert r.headers.get("cache-control") == "private, no-cache", _label

    def test_private_scene_media_other_owner_forbidden(self, db):
        other = User(
            email=f"fix06-other-{uuid.uuid4().hex[:8]}@example.com",
            password_hash="x",
            display_name="other",
        )
        db.add(other)
        db.commit()
        scene = create_scene(
            session=db, owner_id=other.id, visibility="PRIVATE", status="PUBLISHED"
        )
        ann = _seed_media(db, scene)
        for _label, url in _media_urls(scene, ann):
            r = client.get(url)  # dev user = not the owner
            assert r.status_code == 403, (_label, url, r.status_code)

    def test_private_scene_media_share_token_ok_private_no_cache(self, db, anon_client):
        owner_id = _resolve_dev_user_id(settings)
        scene = create_scene(
            session=db,
            owner_id=owner_id,
            visibility="PRIVATE",
            status="PUBLISHED",
            slug=f"mshare-{uuid.uuid4().hex[:8]}",
        )
        ann = _seed_media(db, scene)
        token = _create_share_token(client, scene.slug)
        for _label, url in _media_urls(scene, ann):
            r = anon_client.get(url, params={"share": token})
            assert r.status_code == 200, (_label, url, r.status_code)
            assert r.headers.get("cache-control") == "private, no-cache", _label

    def test_revoked_share_media_denied(self, db, anon_client):
        owner_id = _resolve_dev_user_id(settings)
        scene = create_scene(
            session=db,
            owner_id=owner_id,
            visibility="PRIVATE",
            status="PUBLISHED",
        )
        ann = _seed_media(db, scene)
        token = _create_share_token(client, scene.slug)
        _revoke_share(db, scene)
        for _label, url in _media_urls(scene, ann):
            r = anon_client.get(url, params={"share": token})
            assert r.status_code in (401, 403), (_label, url, r.status_code)

    def test_deleted_scene_media_404_for_owner(self, db):
        owner_id = _resolve_dev_user_id(settings)
        scene = create_scene(
            session=db, owner_id=owner_id, visibility="PRIVATE", status="PUBLISHED"
        )
        ann = _seed_media(db, scene)
        scene.deleted_at = datetime.now(UTC)
        db.commit()
        for _label, url in _media_urls(scene, ann):
            r = client.get(url)  # owner, but soft-deleted → 404
            assert r.status_code == 404, (_label, url, r.status_code)


# ── §18 coverUrl slug round-trip ────────────────────────────────────────────
class TestCoverUrlRoundTrip:
    def test_cover_url_is_slug_anchored_and_serves(self, db):
        scene = create_scene(session=db, visibility="PUBLIC", status="PUBLISHED")
        # Upload a cover through the real multipart route.
        upload = client.post(
            f"/api/v1/scenes/{scene.slug}/presentation/cover",
            files={"file": ("cover.png", COVER_BYTES, "image/png")},
        )
        assert upload.status_code == 200, upload.text
        pres = client.get(f"/api/v1/scenes/{scene.slug}/presentation").json()
        cover_url = pres["coverUrl"]
        assert cover_url == f"/api/v1/scenes/{scene.slug}/presentation/cover", cover_url
        got = client.get(cover_url)
        assert got.status_code == 200
        assert got.content == COVER_BYTES
        assert got.headers["content-type"] == "image/png"


# ── §18 upload state machine ────────────────────────────────────────────────
class TestUploadStateMachine:
    def test_append_after_complete_rejected(self):
        uid = _create_full_upload(client, size=64)
        done = client.post(f"/api/v1/uploads/{uid}/complete", json={})
        assert done.status_code == 200, done.text
        resp = client.patch(
            f"/api/v1/uploads/{uid}",
            content=b"\x00" * 8,
            headers={"Upload-Offset": "64", "Content-Type": "application/octet-stream"},
        )
        assert resp.status_code == 409, resp.text

    def test_append_after_cancel_404(self):
        uid = _create_full_upload(client, size=64)
        client.delete(f"/api/v1/uploads/{uid}")
        resp = client.patch(
            f"/api/v1/uploads/{uid}",
            content=b"\x00" * 8,
            headers={"Upload-Offset": "0", "Content-Type": "application/octet-stream"},
        )
        assert resp.status_code == 404, resp.text

    def test_complete_before_uploaded_rejected(self):
        created = client.post(
            "/api/v1/uploads",
            json={
                "filename": "t.sog",
                "mime_type": "application/octet-stream",
                "size": 512,
                "format": "sog",
                "title": "未上传完",
                "category": "experiment",
                "visibility": "PRIVATE",
            },
        )
        uid = created.json()["uploadId"]
        resp = client.post(f"/api/v1/uploads/{uid}/complete", json={})
        assert resp.status_code == 409, resp.text

    def test_complete_partial_rejected(self):
        uid = _create_full_upload(client, size=512)
        # Overwrite: replace with a partial upload by creating a new one.
        payload = {
            "filename": "t.sog",
            "mime_type": "application/octet-stream",
            "size": 512,
            "format": "sog",
            "title": "部分",
            "category": "experiment",
            "visibility": "PRIVATE",
        }
        created = client.post("/api/v1/uploads", json=payload)
        uid2 = created.json()["uploadId"]
        client.patch(
            f"/api/v1/uploads/{uid2}",
            content=b"\x00" * 100,
            headers={"Upload-Offset": "0", "Content-Type": "application/octet-stream"},
        )
        resp = client.post(f"/api/v1/uploads/{uid2}/complete", json={})
        assert resp.status_code == 409, resp.text
        assert uid != uid2  # keep linters honest about uid

    def test_cancel_after_queued_rejected(self, monkeypatch):
        sent: list[dict] = []

        def _spy(name: str, args=None):
            sent.append({"name": name, "args": args})

        monkeypatch.setattr("app.api.v1.uploads.send_task", _spy)
        uid = _create_full_upload(client, size=32)
        done = client.post(f"/api/v1/uploads/{uid}/complete", json={})
        assert done.status_code == 200
        assert done.json()["status"] == "QUEUED"
        resp = client.delete(f"/api/v1/uploads/{uid}")
        assert resp.status_code == 409, resp.text


# ── §18 complete idempotency ────────────────────────────────────────────────
class TestCompleteIdempotency:
    def test_complete_twice_creates_one_scene_one_job(self, db, monkeypatch):
        from app.db.models.upload_session import UploadSession

        sent: list[dict] = []

        def _spy(name: str, args=None):
            sent.append({"name": name, "args": args})

        monkeypatch.setattr("app.api.v1.uploads.send_task", _spy)
        uid = _create_full_upload(client, size=48)
        first = client.post(f"/api/v1/uploads/{uid}/complete", json={})
        assert first.status_code == 200, first.text
        job1 = first.json()["jobId"]

        second = client.post(f"/api/v1/uploads/{uid}/complete", json={})
        assert second.status_code == 200, second.text
        assert second.json()["jobId"] == job1, "replay must reuse the existing job"
        # One dispatch only, one scene, one job.
        assert len(sent) == 1, f"expected 1 dispatch, got {len(sent)}"

        us = db.query(UploadSession).filter(UploadSession.id == uuid.UUID(uid)).first()
        assert us.scene_id is not None
        scene_count = (
            db.query(Scene).filter(Scene.id == us.scene_id).count()
        )
        assert scene_count == 1
        job_count = (
            db.query(Job).filter(Job.id == uuid.UUID(job1)).count()
        )
        assert job_count == 1
        # Failed-job retry path: FAIL the job, complete again → new job on the SAME scene.
        job = db.query(Job).filter(Job.id == uuid.UUID(job1)).first()
        job.status = JobStatus.FAILED.value
        db.commit()
        retry = client.post(f"/api/v1/uploads/{uid}/complete", json={})
        assert retry.status_code == 200, retry.text
        assert retry.json()["jobId"] != job1
        assert len(sent) == 2
        # Still exactly one scene.
        assert db.query(Scene).filter(Scene.id == us.scene_id).count() == 1


# ── §18 dispatch failure recovery ───────────────────────────────────────────
class TestDispatchFailureRecovery:
    def test_send_task_raises_marks_job_failed_and_503(self, db, monkeypatch):
        from app.db.models.enums import UploadSessionStatus
        from app.db.models.upload_session import UploadSession

        def _boom(name: str, args=None):
            raise RuntimeError("broker exploded")

        monkeypatch.setattr("app.api.v1.uploads.send_task", _boom)
        uid = _create_full_upload(client, size=40)
        resp = client.post(f"/api/v1/uploads/{uid}/complete", json={})
        assert resp.status_code == 503, resp.text
        body = resp.json()
        assert body["code"] == "SERVICE_UNAVAILABLE"
        assert "broker exploded" not in body["message"]

        # No orphan QUEUED job; the job is FAILED with a safe reason; the
        # upload is back to UPLOADED (recoverable).
        us = db.query(UploadSession).filter(UploadSession.id == uuid.UUID(uid)).first()
        assert us.status == UploadSessionStatus.UPLOADED.value
        assert us.scene_id is not None
        jobs = (
            db.query(Job)
            .filter(Job.scene_id == us.scene_id, Job.kind == JobKind.PUBLISH.value)
            .all()
        )
        assert len(jobs) == 1
        assert jobs[0].status == JobStatus.FAILED.value
        assert jobs[0].error_code == "TASK_DISPATCH_FAILED"
        assert "broker exploded" not in (jobs[0].error_message_safe or "")

    def test_retry_after_dispatch_failure_succeeds(self, db, monkeypatch):
        from app.db.models.upload_session import UploadSession

        calls = {"n": 0}

        def _flaky(name: str, args=None):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("first broker hiccup")
            return None

        monkeypatch.setattr("app.api.v1.uploads.send_task", _flaky)
        uid = _create_full_upload(client, size=32)
        first = client.post(f"/api/v1/uploads/{uid}/complete", json={})
        assert first.status_code == 503

        second = client.post(f"/api/v1/uploads/{uid}/complete", json={})
        assert second.status_code == 200, second.text
        assert second.json()["jobId"] is not None
        # Exactly one scene row was ever created (no unique-slug blowup).
        us = db.query(UploadSession).filter(UploadSession.id == uuid.UUID(uid)).first()
        assert db.query(Scene).filter(Scene.id == us.scene_id).count() == 1


# ── §18 publish idempotency (service level) ─────────────────────────────────
class TestPublishIdempotency:
    @pytest.fixture
    def svc(self, tmp_path, monkeypatch):
        monkeypatch.setattr(settings, "env", "production")
        monkeypatch.setattr(settings, "scene_origin_root", "")
        storage = LocalDiskStorage(str(tmp_path / "store"))
        return storage

    def test_commit_version_twice_no_duplicates(self, db, svc):
        from app.services.publish_service import PublishService

        scene = create_scene(session=db, status="PROCESSING", with_version=False)
        manifest = {"stream": {"counts": [1, 2, 3]}, "poster": {"url": "x.webp"}}
        svc.mkdir("published")
        publish = PublishService(db, svc)
        v1 = publish.commit_version(
            scene_id=scene.id,
            version_id="v-sha-123456",
            manifest=manifest,
            entry_bytes=100,
            entry_url="versions/v-sha-123456/lod-meta.json",
            counts=[1, 2, 3],
            source_sha256="a" * 64,
        )
        v2 = publish.commit_version(
            scene_id=scene.id,
            version_id="v-sha-123456",
            manifest=manifest,
            entry_bytes=100,
            entry_url="versions/v-sha-123456/lod-meta.json",
            counts=[1, 2, 3],
            source_sha256="a" * 64,
        )
        assert v1.id == v2.id, "second commit must reuse the same SceneVersion"
        versions = (
            db.query(SceneVersion)
            .filter(SceneVersion.scene_id == scene.id)
            .all()
        )
        assert len(versions) == 1, "no duplicate SceneVersion"
        assets = (
            db.query(Asset)
            .filter(Asset.scene_id == scene.id, Asset.version_id == v1.id)
            .all()
        )
        kinds = {a.kind for a in assets}
        assert kinds == {AssetKind.MANIFEST.value, AssetKind.SOG.value, AssetKind.POSTER.value}
        assert len(assets) == 3, "no duplicate Assets"
        db.refresh(scene)
        assert scene.current_version_id == v1.id
        assert scene.status == "PUBLISHED"
        assert scene.splat_count == 6

    def test_promote_reuses_existing_never_deletes(self, tmp_path):
        from app.services.publish_service import PublishService

        storage = LocalDiskStorage(str(tmp_path))
        publish = PublishService(None, storage)  # type: ignore[arg-type]
        sid = uuid.uuid4()
        publish.begin(sid, "v-abc123")
        staging = f"published/{sid}/.staging"
        storage.mkdir(staging)
        storage.write(f"{staging}/manifest.json", b'{"a":1}')
        storage.write(f"{staging}/lod-meta.json", b"{}")

        key = publish.promote_staging_to_version(sid, "v-abc123", staging)
        manifest1 = storage.read(f"{key}/manifest.json")
        # Second delivery: same content → reuse, no delete, bytes identical.
        storage.mkdir(staging)
        storage.write(f"{staging}/manifest.json", b'{"a":1}')
        key2 = publish.promote_staging_to_version(sid, "v-abc123", staging)
        assert key == key2
        assert storage.read(f"{key}/manifest.json") == manifest1
        assert storage.read(f"{key}/manifest.json") == b'{"a":1}'

    def test_promote_conflict_when_content_differs(self, tmp_path):
        from app.core.errors import ConflictError
        from app.services.publish_service import PublishService

        storage = LocalDiskStorage(str(tmp_path))
        publish = PublishService(None, storage)  # type: ignore[arg-type]
        sid = uuid.uuid4()
        staging = f"published/{sid}/.staging"
        storage.mkdir(staging)
        storage.write(f"{staging}/manifest.json", b'{"a":1}')
        key = publish.promote_staging_to_version(sid, "v-conflict", staging)
        assert storage.read(f"{key}/manifest.json") == b'{"a":1}'
        # Different content under the same content-addressed id → conflict.
        storage.mkdir(staging)
        storage.write(f"{staging}/manifest.json", b'{"a":2}')
        with pytest.raises(ConflictError):
            publish.promote_staging_to_version(sid, "v-conflict", staging)
        # The immutable version was NOT overwritten.
        assert storage.read(f"{key}/manifest.json") == b'{"a":1}'


# ── §18 CSRF on upload writes ───────────────────────────────────────────────
class TestUploadCsrf:
    def test_session_write_without_csrf_403(self, session_client):
        _register_session(session_client)
        resp = session_client.post(
            "/api/v1/uploads",
            json={
                "filename": "t.sog",
                "mime_type": "application/octet-stream",
                "size": 10,
                "format": "sog",
                "title": "csrf",
                "category": "experiment",
                "visibility": "PRIVATE",
            },
        )
        assert resp.status_code == 403, resp.text

    def test_wrong_csrf_403(self, session_client):
        _register_session(session_client)
        resp = session_client.post(
            "/api/v1/uploads",
            json={
                "filename": "t.sog",
                "mime_type": "application/octet-stream",
                "size": 10,
                "format": "sog",
                "title": "csrf",
                "category": "experiment",
                "visibility": "PRIVATE",
            },
            headers={"X-CSRF-Token": "deadbeef"},
        )
        assert resp.status_code == 403, resp.text

    def test_correct_csrf_succeeds(self, session_client):
        _register_session(session_client)
        csrf = session_client.cookies.get("gs_csrf")
        assert csrf
        resp = session_client.post(
            "/api/v1/uploads",
            json={
                "filename": "t.sog",
                "mime_type": "application/octet-stream",
                "size": 10,
                "format": "sog",
                "title": "csrf",
                "category": "experiment",
                "visibility": "PRIVATE",
            },
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 201, resp.text


# ── §18 CSRF on compute writes ──────────────────────────────────────────────
class TestComputeCsrf:
    def _reconstruct_job(self, db) -> uuid.UUID:
        owner_id = _resolve_dev_user_id(settings)  # real users row (dev user)
        scene = create_scene(session=db, status="PROCESSING", with_version=False)
        scene.owner_id = owner_id
        job = Job(
            scene_id=scene.id,
            owner_id=owner_id,
            kind=JobKind.RECONSTRUCT.value,
            status=JobStatus.QUEUED.value,
            progress=0,
        )
        db.add(job)
        db.commit()
        return job.id

    def test_cancel_without_csrf_403(self, db, session_client):
        _register_session(session_client)
        job_id = self._reconstruct_job(db)
        # CSRF gate fires before the ownership check → 403 without the header.
        resp = session_client.post(f"/api/v1/compute/jobs/{job_id}/cancel")
        assert resp.status_code == 403, resp.text

    def test_cancel_wrong_csrf_403(self, db, session_client):
        _register_session(session_client)
        job_id = self._reconstruct_job(db)
        resp = session_client.post(
            f"/api/v1/compute/jobs/{job_id}/cancel",
            headers={"X-CSRF-Token": "wrong-token"},
        )
        assert resp.status_code == 403, resp.text

    def test_cancel_with_csrf_but_not_owner_404(self, db, session_client):
        _register_session(session_client)
        csrf = session_client.cookies.get("gs_csrf")
        assert csrf
        job_id = self._reconstruct_job(db)
        # CSRF passes (valid header) → ownership gate → 404 for a stranger job.
        resp = session_client.post(
            f"/api/v1/compute/jobs/{job_id}/cancel",
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 404, resp.text


# ── §18 rate limiter (Redis backend) ────────────────────────────────────────
class TestRateLimiterRedis:
    @pytest.fixture(autouse=True)
    def _reset_redis_lazily(self):
        import app.core.rate_limit as rl

        rl._redis_client = None
        rl._redis_client_attempted = False
        yield
        rl._redis_client = None
        rl._redis_client_attempted = False

    def _ping(self) -> bool:
        import socket

        try:
            s = socket.create_connection(("127.0.0.1", 6379), timeout=2)
            s.close()
            return True
        except OSError:
            return False

    def test_redis_counts_and_over_limits(self, monkeypatch):
        if not self._ping():
            pytest.skip("no local redis — cannot assert shared limiter")
        monkeypatch.setattr(settings, "rate_limit_backend", "redis")
        monkeypatch.setattr(settings, "redis_url", "redis://127.0.0.1:6379/15")

        from app.core.rate_limit import check_rate_limit_shared

        scope = f"test-{uuid.uuid4().hex[:8]}"
        try:
            r1 = check_rate_limit_shared(scope, "k", limit=2, window_seconds=60)
            assert r1.allowed

            r2 = check_rate_limit_shared(scope, "k", limit=2, window_seconds=60)
            assert r2.allowed

            r3 = check_rate_limit_shared(scope, "k", limit=2, window_seconds=60)
            assert not r3.allowed
            assert r3.retry_after_seconds >= 1
            # Key survives within the window:
            r4 = check_rate_limit_shared(scope, "k", limit=2, window_seconds=60)
            assert not r4.allowed
        finally:
            reset_rate_limits_redis(scope, "k")

    def test_redis_unavailable_falls_back_to_memory(self, monkeypatch):
        monkeypatch.setattr(settings, "rate_limit_backend", "redis")
        monkeypatch.setattr(settings, "redis_url", "redis://127.0.0.1:1/0")  # dead port

        from app.core.rate_limit import (
            check_rate_limit_redis,
            check_rate_limit_shared,
            reset_rate_limits,
        )

        scope = f"test-fb-{uuid.uuid4().hex[:8]}"
        reset_rate_limits(scope, "k")
        try:
            with pytest.raises(redis.exceptions.RedisError):
                check_rate_limit_redis(scope, "k", limit=5, window_seconds=60)
            # Shared dispatch degrades to memory — still counts:
            assert check_rate_limit_shared(scope, "k", limit=2, window_seconds=60).allowed
            assert check_rate_limit_shared(scope, "k", limit=2, window_seconds=60).allowed
            denied = check_rate_limit_shared(scope, "k", limit=2, window_seconds=60)
            assert not denied.allowed
        finally:
            reset_rate_limits(scope, "k")
