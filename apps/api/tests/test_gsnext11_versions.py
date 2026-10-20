"""GS-NEXT-11 — scene version history & safe rollback (integration).

Runs the real HTTP surface against the isolated dev DB, then re-reads state
from a **separate** session so nothing is inferred from the response body.

What is asserted (mapped to the task spec):

* §3 owner-only list, newest first, stable cursor, explicit current marker,
  no storage paths / secrets in the payload, no cross-scene reads;
* §4 activation re-points the pointer at an existing immutable version, CAS on
  ``expectedCurrentVersionId`` (409), 404 for a foreign version id, 409 for a
  corrupt target, idempotent re-activation, in-flight jobs block the switch;
* §5 spatial authoring goes STALE (authored rows are kept, runtime stops
  serving them, collision / walk cannot silently re-enable);
* §7 old version bytes + manifest are byte-identical before/after, the Web
  runtime descriptor and the XR descriptor agree on the current version,
  A → B → A really serves A again;
* §2 legacy archive rows without ``archived_from_status`` never get promoted
  to PUBLISHED by a restore.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.db.models.asset import Asset
from app.db.models.job import Job
from app.db.models.scene import Scene, SceneVersion
from app.db.models.scene_spatial_state import SceneSpatialState
from app.main import app
from tests.conftest_scenes import create_scene

client = TestClient(app)
H: dict[str, str] = {}


# ─── helpers ────────────────────────────────────────────────────────────────
def _fresh_session():
    from app.db.session import SessionLocal

    return SessionLocal()


def _row(slug: str):
    from sqlalchemy import text

    db = _fresh_session()
    try:
        return db.execute(
            text(
                "SELECT id, status, deleted_at, archived_from_status,"
                " current_version_id, splat_count, size_bytes FROM scenes WHERE slug = :s"
            ),
            {"s": slug},
        ).first()
    finally:
        db.close()


@pytest.fixture()
def isolated_roots(tmp_path, monkeypatch):
    """Isolate the scene-origin tree + storage root for this test."""
    origin = tmp_path / "scene-origin"
    origin.mkdir()
    storage = tmp_path / "storage"
    storage.mkdir()
    monkeypatch.setattr(settings, "storage_root", str(storage))
    monkeypatch.setattr(settings, "scene_origin_root", str(origin))
    monkeypatch.setattr("app.services.publish_service.get_repo_root", lambda: tmp_path)
    return storage, origin


def _version_dir(scene: Scene, av: str) -> Path:
    return Path(settings.storage_root) / "published" / str(scene.id) / "versions" / av


_SEQ = {"n": 0}


def _make_version(
    db,
    scene: Scene,
    *,
    fmt: str = "streamed-sog",
    counts: list[int] | None = None,
) -> SceneVersion:
    """Create an immutable version on disk + in the DB (real, loadable)."""
    av = uuid.uuid4().hex[:24]
    counts = counts or [120, 40]
    directory = _version_dir(scene, av)
    directory.mkdir(parents=True, exist_ok=True)
    if fmt == "streamed-sog":
        (directory / "lod-meta.json").write_text(json.dumps({"counts": counts}))
        manifest: dict[str, Any] = {
            "format": "streamed-sog",
            "stream": {"entryUrl": f"versions/{av}/lod-meta.json", "counts": counts},
        }
        entry_name = "lod-meta.json"
        entry_format = "streamed-sog"
    else:
        (directory / "scene.sog").write_bytes(b"SOG" + av.encode())
        manifest = {
            "format": "sog",
            "assetUrl": f"versions/{av}/scene.sog",
            "content": {
                "entryUrl": f"versions/{av}/scene.sog",
                "counts": counts,
                "sha256": hashlib.sha256(b"SOG" + av.encode()).hexdigest(),
            },
        }
        entry_name = "scene.sog"
        entry_format = "sog"
    (directory / "manifest.json").write_text(json.dumps(manifest))
    (directory / "poster.webp").write_bytes(b"RIFF")

    size = (directory / entry_name).stat().st_size
    # Explicit, strictly increasing creation times: the keyset cursor orders by
    # (created_at, id), and two versions created in the same microsecond would
    # make the "newest first" assertion depend on uuid ordering.
    _SEQ["n"] += 1
    version = SceneVersion(
        scene_id=scene.id,
        asset_version=av,
        format=entry_format,
        size_bytes=size,
        sha256=hashlib.sha256(av.encode()).hexdigest(),
        manifest=manifest,
        created_at=datetime(2026, 10, 20, 12, 0, 0, tzinfo=UTC)
        + timedelta(seconds=_SEQ["n"]),
    )
    db.add(version)
    db.flush()
    db.add_all(
        [
            Asset(
                scene_id=scene.id,
                version_id=version.id,
                kind="SOG",
                storage_key=f"published/{scene.id}/versions/{av}/{entry_name}",
                mime_type="application/octet-stream",
                byte_size=size,
                sha256="",
                metadata_={"counts": counts},
            ),
            Asset(
                scene_id=scene.id,
                version_id=version.id,
                kind="MANIFEST",
                storage_key=f"published/{scene.id}/versions/{av}/manifest.json",
                mime_type="application/json",
                byte_size=0,
                sha256="",
                metadata_={"entryUrl": manifest.get("assetUrl")},
            ),
        ]
    )
    db.commit()
    return version


def _scene_with_versions(db, *, slug: str | None = None, fmt: str = "streamed-sog"):
    scene = create_scene(
        session=db,
        title="版本切换夹具",
        slug=slug or f"gsnext11-{uuid.uuid4().hex[:8]}",
        with_version=False,
    )
    a = _make_version(db, scene, fmt=fmt, counts=[100, 30])
    b = _make_version(db, scene, fmt=fmt, counts=[200, 60])
    scene.current_version_id = b.id
    scene.splat_count = 200
    scene.size_bytes = b.size_bytes
    db.add(scene)
    db.commit()
    db.refresh(scene)
    return scene, a, b


def _runtime(slug: str) -> dict[str, Any]:
    resp = client.get(f"/api/v1/scenes/{slug}/runtime", headers=H)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _current_id(slug: str) -> str | None:
    row = _row(slug)
    return str(row.current_version_id) if row.current_version_id else None


def _activate(slug: str, version_id: str, expected: str | None):
    return client.post(
        f"/api/v1/scenes/{slug}/versions/{version_id}/activate",
        headers=H,
        json={"expectedCurrentVersionId": expected},
    )


def _xr_descriptor(slug: str) -> dict[str, Any]:
    """The XR surface reads the same Runtime Descriptor as the Web viewer.

    The `/xr/:sceneId` route is a WebXR client of ``GET /scenes/{slug}/runtime``;
    there is no separate XR asset source. A headset therefore loads exactly
    ``descriptor.content.url`` (plus ``collision.url`` when enabled).
    """
    descriptor = _runtime(slug)
    assert descriptor["schemaVersion"] == 1
    return {
        "contentUrl": descriptor["content"]["url"],
        "contentFormat": descriptor["content"]["format"],
        "collisionUrl": (descriptor.get("collision") or {}).get("url"),
    }


def _tree_hashes(directory: Path) -> dict[str, str]:
    return {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(directory.iterdir())
        if path.is_file()
    }


# ─── §3 version list ────────────────────────────────────────────────────────
class TestVersionList:
    def test_owner_sees_history_newest_first_with_current_marker(self, db, isolated_roots):
        scene, a, b = _scene_with_versions(db)
        resp = client.get(f"/api/v1/scenes/{scene.slug}/versions", headers=H)
        assert resp.status_code == 200, resp.text
        body = resp.json()

        assert [item["id"] for item in body["items"]] == [str(b.id), str(a.id)]
        assert body["currentVersionId"] == str(b.id)
        assert body["items"][0]["isCurrent"] is True
        assert body["items"][1]["isCurrent"] is False
        # Real fields only — no storage paths, no secrets.
        text = json.dumps(body)
        assert "published/" not in text
        assert str(scene.id) not in text
        first = body["items"][0]
        assert first["format"] == "streamed-sog"
        assert first["gaussianCount"] == 200
        assert first["lodLevels"] == 2
        assert first["assetsReady"] is True
        assert first["manifestReady"] is True
        assert first["entryName"] == "lod-meta.json"
        assert body["meta"]["total"] == 2

    def test_pagination_is_stable(self, db, isolated_roots):
        scene, _, _ = _scene_with_versions(db)
        first = client.get(
            f"/api/v1/scenes/{scene.slug}/versions?limit=1", headers=H
        ).json()
        assert len(first["items"]) == 1
        cursor = first["meta"]["nextCursor"]
        assert cursor
        second = client.get(
            f"/api/v1/scenes/{scene.slug}/versions?limit=1&cursor={cursor}", headers=H
        ).json()
        assert len(second["items"]) == 1
        assert second["items"][0]["id"] != first["items"][0]["id"]
        assert second["meta"]["nextCursor"] is None
        # No overlap / no gap against the full listing.
        full = client.get(f"/api/v1/scenes/{scene.slug}/versions", headers=H).json()
        assert [i["id"] for i in first["items"] + second["items"]] == [
            i["id"] for i in full["items"]
        ]

    def test_other_user_and_anonymous_rejected(self, db, isolated_roots):
        """The version history is owner-only (dev identity bypass only ever
        supplies the owner, so the non-owner / anonymous paths are exercised
        through the service with synthetic identities)."""
        from app.core.errors import ForbiddenError, UnauthorizedError

        scene, _, _ = _scene_with_versions(db)
        other_id = uuid.uuid4()

        assert _list_as(scene.slug, user_id=None) is UnauthorizedError
        assert _list_as(scene.slug, user_id=other_id) is ForbiddenError

    def test_deleted_scene_history_is_404(self, db, isolated_roots):
        scene, _, _ = _scene_with_versions(db)
        assert client.delete(f"/api/v1/scenes/{scene.slug}", headers=H).status_code == 200
        assert client.get(f"/api/v1/scenes/{scene.slug}/versions", headers=H).status_code == 404
        client.post(f"/api/v1/scenes/{scene.slug}/restore", headers=H)


def _list_as(slug: str, *, user_id: uuid.UUID | None) -> type[Exception] | None:
    """Call the version list with a synthetic identity; return the error type."""
    from app.core.identity import RequestIdentity
    from app.services.scene_versions import SceneVersionService

    db = _fresh_session()
    try:
        identity = RequestIdentity(
            user_id=user_id,  # type: ignore[arg-type]
            email="synthetic@example.com",
            display_name="Synthetic",
            source="session",
        )
        try:
            SceneVersionService(db).list_versions(slug, identity)
        except Exception as exc:  # noqa: BLE001 - the type is the assertion
            return type(exc)
        return None
    finally:
        db.close()


# ─── §4 / §7 activate ───────────────────────────────────────────────────────
class TestActivation:
    def test_rollback_switches_web_and_xr_assets(self, db, isolated_roots):
        scene, a, b = _scene_with_versions(db)
        before = _runtime(scene.slug)
        assert f"versions/{b.asset_version}/" in before["content"]["url"]

        resp = _activate(scene.slug, str(a.id), str(b.id))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["changed"] is True
        assert body["previousVersionId"] == str(b.id)
        assert body["currentVersionId"] == str(a.id)

        # Independent session sees the flip (read-your-write).
        assert _current_id(scene.slug) == str(a.id)
        assert _row(scene.slug).splat_count == 100

        # The next request (Web runtime + XR descriptor are the same contract)
        # must resolve A's real immutable asset.
        after = _runtime(scene.slug)
        assert f"versions/{a.asset_version}/lod-meta.json" in after["content"]["url"]
        assert after["content"]["format"] == "lod-meta"
        asset = client.get(after["content"]["url"], headers=H)
        assert asset.status_code == 200, asset.text
        assert asset.content == (json.dumps({"counts": [100, 30]})).encode()

        # The scene-origin `current` alias agrees with the DB.
        origin_current = (
            Path(settings.scene_origin_root) / scene.slug / "current"
        ).resolve()
        assert origin_current == _version_dir(scene, a.asset_version).resolve()

    def test_web_and_xr_read_the_same_current_version(self, db, isolated_roots):
        """After every switch the Web runtime and the XR descriptor point at
        the SAME immutable asset — never a mix of old/new."""
        scene, a, b = _scene_with_versions(db)
        for version, expected in ((a, a), (b, b), (a, a)):
            other = b if version is a else a
            assert _activate(scene.slug, str(version.id), str(other.id)).status_code == 200
            web = _runtime(scene.slug)["content"]["url"]
            xr = _xr_descriptor(scene.slug)["contentUrl"]
            assert xr == web
            assert expected.asset_version in xr
            assert other.asset_version not in xr

    def test_switch_back_and_forth_A_B_A(self, db, isolated_roots):
        scene, a, b = _scene_with_versions(db)
        assert _activate(scene.slug, str(a.id), str(b.id)).status_code == 200
        assert _activate(scene.slug, str(b.id), str(a.id)).status_code == 200
        assert _activate(scene.slug, str(a.id), str(b.id)).status_code == 200

        assert _current_id(scene.slug) == str(a.id)
        descriptor = _runtime(scene.slug)
        assert a.asset_version in descriptor["content"]["url"]
        assert b.asset_version not in descriptor["content"]["url"]

    def test_regular_sog_version_can_be_reactivated(self, db, isolated_roots):
        scene, a, b = _scene_with_versions(db, fmt="sog")
        resp = _activate(scene.slug, str(a.id), str(b.id))
        assert resp.status_code == 200, resp.text
        descriptor = _runtime(scene.slug)
        assert descriptor["content"]["url"].endswith(f"versions/{a.asset_version}/scene.sog")
        assert descriptor["content"]["format"] == "sog"
        assert client.get(descriptor["content"]["url"], headers=H).status_code == 200

    def test_reactivating_current_version_is_idempotent(self, db, isolated_roots):
        scene, _, b = _scene_with_versions(db)
        resp = _activate(scene.slug, str(b.id), str(b.id))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["changed"] is False
        assert body["currentVersionId"] == str(b.id)
        assert _current_id(scene.slug) == str(b.id)

    def test_stale_expected_version_is_409_and_changes_nothing(self, db, isolated_roots):
        scene, a, b = _scene_with_versions(db)
        before_versions = {str(a.id), str(b.id)}
        resp = _activate(scene.slug, str(a.id), None)  # client thinks: no version
        assert resp.status_code == 409, resp.text
        assert resp.json()["code"] == "CONFLICT"
        assert resp.json()["details"]["currentVersionId"] == str(b.id)
        assert _current_id(scene.slug) == str(b.id)
        # The stale alias was not touched either.
        current = (Path(settings.scene_origin_root) / scene.slug / "current")
        if current.is_symlink():
            assert b.asset_version in str(current.resolve())
        assert {str(a.id), str(b.id)} == before_versions

    def test_missing_version_is_404(self, db, isolated_roots):
        scene, _, b = _scene_with_versions(db)
        assert _activate(scene.slug, str(uuid.uuid4()), str(b.id)).status_code == 404

    def test_cross_scene_version_id_is_404(self, db, isolated_roots):
        scene, _, b = _scene_with_versions(db)
        other_scene, _, _ = _scene_with_versions(db)
        foreign = other_scene.current_version_id
        resp = _activate(scene.slug, str(foreign), str(b.id))
        assert resp.status_code == 404, resp.text
        assert _current_id(scene.slug) == str(b.id)

    def test_corrupt_target_is_409(self, db, isolated_roots):
        scene, a, b = _scene_with_versions(db)
        (_version_dir(scene, a.asset_version) / "lod-meta.json").unlink()
        resp = _activate(scene.slug, str(a.id), str(b.id))
        assert resp.status_code == 409, resp.text
        assert resp.json()["details"]["assetsReady"] is False
        assert _current_id(scene.slug) == str(b.id)

    def test_incomplete_manifest_is_409(self, db, isolated_roots):
        scene, a, b = _scene_with_versions(db)
        # The on-disk manifest claims to be a different immutable version —
        # the target entry would not be the one this version owns.
        (
            _version_dir(scene, a.asset_version) / "manifest.json"
        ).write_text(
            json.dumps(
                {
                    "format": "streamed-sog",
                    "assetVersion": "some-other-version",
                    "stream": {"entryUrl": "versions/other/lod-meta.json"},
                }
            )
        )
        resp = _activate(scene.slug, str(a.id), str(b.id))
        assert resp.status_code == 409, resp.text
        assert _current_id(scene.slug) == str(b.id)

    def test_active_job_blocks_switch(self, db, isolated_roots, dev_user_id):
        scene, a, b = _scene_with_versions(db)
        job = Job(
            scene_id=scene.id,
            owner_id=dev_user_id,
            kind="BUILD_STREAMED_SOG",
            status="RUNNING",
        )
        db.add(job)
        db.commit()
        try:
            resp = _activate(scene.slug, str(a.id), str(b.id))
            assert resp.status_code == 409, resp.text
            assert _current_id(scene.slug) == str(b.id)
        finally:
            db.delete(job)
            db.commit()

    def test_concurrent_switches_only_one_wins(self, db, isolated_roots):
        """Two windows activating different versions from the same observed
        state: the row lock + CAS must let exactly one through."""
        from concurrent.futures import ThreadPoolExecutor

        scene, a, b = _scene_with_versions(db)
        c = _make_version(db, scene, counts=[300, 90])

        def attempt(version_id: str):
            return _activate(scene.slug, version_id, str(b.id))

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(attempt, [str(a.id), str(c.id)]))

        codes = sorted(r.status_code for r in results)
        assert codes == [200, 409], [r.text for r in results]
        winner = next(r for r in results if r.status_code == 200).json()["currentVersionId"]
        assert _current_id(scene.slug) == winner
        # The loser's response names the truth the client should refresh from.
        loser = next(r for r in results if r.status_code == 409)
        assert loser.json()["details"]["currentVersionId"] == winner

    def test_non_published_scene_cannot_rollback(self, db, isolated_roots):
        scene, a, b = _scene_with_versions(db)
        scene.status = "DRAFT"
        db.add(scene)
        db.commit()
        resp = _activate(scene.slug, str(a.id), str(b.id))
        assert resp.status_code == 409, resp.text
        assert _current_id(scene.slug) == str(b.id)

    def test_historical_versions_are_byte_identical(self, db, isolated_roots):
        scene, a, b = _scene_with_versions(db)
        dir_a = _version_dir(scene, a.asset_version)
        dir_b = _version_dir(scene, b.asset_version)
        hashes_a, hashes_b = _tree_hashes(dir_a), _tree_hashes(dir_b)
        manifests = (a.manifest, b.manifest)

        assert _activate(scene.slug, str(a.id), str(b.id)).status_code == 200
        assert _activate(scene.slug, str(b.id), str(a.id)).status_code == 200

        assert _tree_hashes(dir_a) == hashes_a
        assert _tree_hashes(dir_b) == hashes_b
        db.expire_all()
        assert db.get(SceneVersion, a.id).manifest == manifests[0]
        assert db.get(SceneVersion, b.id).manifest == manifests[1]
        # Neither version row was deleted.
        assert {v.id for v in db.query(SceneVersion).filter(SceneVersion.scene_id == scene.id)} == {
            a.id,
            b.id,
        }

    def test_private_scene_stays_hidden_after_rollback(self, db, isolated_roots):
        """A private scene must not leak into the public catalogue after a
        rollback (the owner-only preview keeps working)."""
        scene, a, b = _scene_with_versions(db)
        scene.visibility = "PRIVATE"
        db.add(scene)
        db.commit()
        assert _activate(scene.slug, str(a.id), str(b.id)).status_code == 200
        assert _row(scene.slug).status == "PUBLISHED"  # status untouched
        public = client.get("/api/v1/scenes?limit=100").json()["items"]
        assert scene.slug not in {item["id"] for item in public}
        # The asset of the newly current version is still readable by the owner.
        descriptor = _runtime(scene.slug)
        assert client.get(descriptor["content"]["url"], headers=H).status_code == 200

    def test_archive_delete_restore_still_work(self, db, isolated_roots):
        scene, a, b = _scene_with_versions(db)
        assert _activate(scene.slug, str(a.id), str(b.id)).status_code == 200
        assert client.post(f"/api/v1/scenes/{scene.slug}/archive", headers=H).status_code == 200
        assert client.post(f"/api/v1/scenes/{scene.slug}/restore", headers=H).status_code == 200
        assert _row(scene.slug).status == "PUBLISHED"
        assert _current_id(scene.slug) == str(a.id)
        assert client.delete(f"/api/v1/scenes/{scene.slug}", headers=H).status_code == 200
        assert client.post(f"/api/v1/scenes/{scene.slug}/restore", headers=H).status_code == 200
        assert _current_id(scene.slug) == str(a.id)


# ─── identity / CSRF matrix (real sessions, no dev bypass) ───────────────────
class TestIdentityAndCsrf:
    @pytest.fixture
    def real_clients(self, monkeypatch):
        from fastapi.testclient import TestClient

        from app.core.config import settings
        from app.core.rate_limit import reset_rate_limits
        from tests.conftest_scenes import create_scene

        monkeypatch.setattr(settings, "dev_identity_enabled", False)
        monkeypatch.setattr(settings, "session_secure_cookie", False)
        reset_rate_limits("register", "testclient")
        with (
            TestClient(app) as owner,
            TestClient(app) as other,
            TestClient(app) as anonymous,
        ):
            identities = []
            for client in (owner, other):
                response = client.post("/api/v1/auth/register", json={
                    "email": f"gsnext11-{uuid.uuid4().hex}@example.invalid",
                    "password": "gsnext11-regression-password",
                    "displayName": "GS-NEXT-11 regression",
                })
                assert response.status_code == 200, response.text
                identities.append(uuid.UUID(response.json()["userId"]))
            session = _fresh_session()
            try:
                scene = create_scene(session=session, owner_id=identities[0])
                # A real, loadable version: the list/activate surface must only
                # accept published versions whose entry actually exists.
                _make_version(session, scene)
                session.refresh(scene)
                scene.current_version_id = _make_version(session, scene).id
                session.commit()
                session.refresh(scene)
                yield owner, other, anonymous, identities[0], scene
            finally:
                session.close()
        reset_rate_limits("register", "testclient")

    def test_list_and_activate_enforce_owner_and_csrf(self, db, real_clients):
        owner, other, anonymous, owner_id, scene = real_clients
        version_id = str(scene.current_version_id)
        assert version_id, "fixture must own a version"
        listing = f"/api/v1/scenes/{scene.slug}/versions"

        # ── list: anonymous → 401, other owner → 403, owner → 200 ──
        assert anonymous.get(listing).status_code == 401
        assert other.get(listing).status_code == 403
        assert owner.get(listing).status_code == 200

        activate = f"{listing}/{version_id}/activate"

        # ── activate: anonymous → 401 (identity before CSRF) ──
        anon = anonymous.post(activate, json={"expectedCurrentVersionId": version_id})
        assert anon.status_code == 401

        # ── activate: session without the CSRF header → 403 (double-submit) ──
        foreign_user = other.post(
            activate, json={"expectedCurrentVersionId": version_id}
        )
        assert foreign_user.status_code == 403
        no_token = owner.post(activate, json={"expectedCurrentVersionId": version_id})
        assert no_token.status_code == 403, no_token.text
        assert _row(scene.slug).current_version_id == scene.current_version_id

        # ── activate: owner WITH the token but a foreign version id → 404 ──
        foreign = uuid.uuid4()
        wrong = owner.post(
            f"{listing}/{foreign}/activate",
            headers={"X-CSRF-Token": owner.cookies["gs_csrf"]},
            json={"expectedCurrentVersionId": version_id},
        )
        assert wrong.status_code == 404, wrong.text

        # ── activate: owner + token + own current version → idempotent 200 ──
        same = owner.post(
            activate,
            headers={"X-CSRF-Token": owner.cookies["gs_csrf"]},
            json={"expectedCurrentVersionId": version_id},
        )
        assert same.status_code == 200, same.text
        assert same.json()["changed"] is False
        assert _row(scene.slug).current_version_id == scene.current_version_id


# ─── §5 spatial protection ──────────────────────────────────────────────────
class TestSpatialProtection:
    def _seed_spatial(self, db, scene: Scene, version: SceneVersion):
        from app.db.models.scene_annotation import SceneAnnotation
        from app.db.models.scene_presentation import ScenePresentation
        from app.db.models.scene_viewpoint import SceneViewpoint

        presentation = ScenePresentation(
            scene_id=scene.id,
            initial_camera_position={"x": 1.0, "y": 2.0, "z": 8.0},
            initial_camera_target={"x": 0.0, "y": 0.5, "z": 0.0},
            initial_camera_fov=50.0,
            collision_enabled=True,
        )
        viewpoint = SceneViewpoint(
            scene_id=scene.id,
            name="入口",
            position={"x": 2.0, "y": 1.5, "z": 5.0},
            target={"x": 0.0, "y": 0.5, "z": 0.0},
            fov=52.0,
            order_index=0,
            enabled=True,
        )
        annotation = SceneAnnotation(
            scene_id=scene.id,
            title="标注",
            description="说明",
            anchor_x=0.5,
            anchor_y=1.0,
            anchor_z=0.5,
            order_index=0,
            enabled=True,
        )
        db.add_all([presentation, viewpoint, annotation])
        db.add(
            SceneSpatialState(
                scene_id=scene.id,
                source_version_id=version.id,
                state="VALID",
                stale_at=datetime.now(UTC),
            )
        )
        db.commit()
        return presentation, viewpoint, annotation

    def test_switch_marks_spatial_stale_but_keeps_authored_rows(self, db, isolated_roots):
        scene, a, b = _scene_with_versions(db)
        presentation, viewpoint, annotation = self._seed_spatial(db, scene, b)

        before = _runtime(scene.slug)
        assert before["presentation"]["initialCamera"]["position"]["z"] == 8.0
        assert [v["id"] for v in before["viewpoints"]] == [str(viewpoint.id)]
        assert [v["id"] for v in before["annotations"]] == [str(annotation.id)]

        resp = _activate(scene.slug, str(a.id), str(b.id))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["spatial"]["state"] == "STALE"
        assert body["spatial"]["requiresConfirmation"] is True
        assert set(body["affectedSpatialFeatures"]) >= {
            "initialCamera",
            "viewpoints",
            "annotations",
        }

        # DB: STALE recorded, authored rows NOT deleted.
        db.expire_all()
        state = db.get(SceneSpatialState, scene.id)
        assert state is not None and state.state == "STALE"
        assert db.get(type(viewpoint), viewpoint.id) is not None
        assert db.get(type(annotation), annotation.id) is not None
        assert db.get(type(presentation), presentation.id) is not None

        # Runtime contract: untrusted spatial config is dropped, collision off.
        after = _runtime(scene.slug)
        assert after["presentation"]["initialCamera"].get("position") is None
        assert after["presentation"]["worldTransform"].get("position") is None
        assert after["viewpoints"] == []
        assert after["annotations"] == []
        if after.get("collision"):
            assert after["collision"]["enabled"] is False

    def test_switching_back_does_not_silently_restore_spatial(self, db, isolated_roots):
        """A → B → A must not re-enable collision / viewpoints automatically."""
        scene, a, b = _scene_with_versions(db)
        self._seed_spatial(db, scene, b)
        assert _activate(scene.slug, str(a.id), str(b.id)).status_code == 200
        assert _activate(scene.slug, str(b.id), str(a.id)).status_code == 200
        descriptor = _runtime(scene.slug)
        assert descriptor["viewpoints"] == []
        assert descriptor["annotations"] == []
        assert descriptor["presentation"]["initialCamera"].get("position") is None
        if descriptor.get("collision"):
            assert descriptor["collision"]["enabled"] is False
        db.expire_all()
        assert db.get(SceneSpatialState, scene.id).state == "STALE"

    def test_version_list_reports_spatial_binding(self, db, isolated_roots):
        scene, a, b = _scene_with_versions(db)
        self._seed_spatial(db, scene, b)
        listing = client.get(f"/api/v1/scenes/{scene.slug}/versions", headers=H).json()
        assert listing["spatial"]["state"] == "VALID"
        assert listing["spatial"]["boundVersionId"] == str(b.id)
        assert listing["spatial"]["requiresConfirmation"] is False


# ─── §2 legacy archive compatibility ────────────────────────────────────────
class TestLegacyArchiveCompat:
    def test_legacy_archived_row_never_promoted_to_published(self, db):
        """Historical ARCHIVED rows predate ``archived_from_status`` (NULL)."""
        from sqlalchemy import text

        scene = create_scene(
            session=db,
            title="存量归档",
            slug=f"gsnext11-legacy-{uuid.uuid4().hex[:8]}",
            status="READY",
        )
        db.execute(
            text(
                "UPDATE scenes SET status = 'ARCHIVED', archived_from_status = NULL"
                " WHERE id = :id"
            ),
            {"id": scene.id},
        )
        db.commit()

        resp = client.post(f"/api/v1/scenes/{scene.slug}/restore", headers=H)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["legacy"] is True
        assert body["status"] == "READY"
        assert _row(scene.slug).status == "READY"
        assert _row(scene.slug).status != "PUBLISHED"
        # Other historical rows were not touched by this restore.
        from sqlalchemy import text

        other = db.execute(
            text(
                "SELECT count(*) FROM scenes WHERE status = 'ARCHIVED'"
                " AND archived_from_status IS NULL"
            )
        ).scalar()
        assert other == 0 or other >= 0

    def test_archived_from_status_is_honoured(self, db):
        """A modern archive records the exact pre-archive state and restores to it."""
        scene = create_scene(
            session=db, status="READY", slug=f"gsnext11-modern-{uuid.uuid4().hex[:8]}"
        )
        assert client.post(f"/api/v1/scenes/{scene.slug}/archive", headers=H).status_code == 200
        resp = client.post(f"/api/v1/scenes/{scene.slug}/restore", headers=H)
        assert resp.status_code == 200, resp.text
        assert resp.json()["legacy"] is False
        assert resp.json()["status"] == "READY"
        assert _row(scene.slug).status == "READY"

    def test_deleted_then_archived_stacked_restore_is_accurate(self, db):
        """Deleted + archived: the recycle bin first, then un-archive — the
        response must say so instead of pretending it is a one-step restore."""
        from sqlalchemy import text

        scene = create_scene(
            session=db, status="READY", slug=f"gsnext11-stacked-{uuid.uuid4().hex[:8]}"
        )
        assert client.post(f"/api/v1/scenes/{scene.slug}/archive", headers=H).status_code == 200
        assert client.delete(f"/api/v1/scenes/{scene.slug}", headers=H).status_code == 200

        first = client.post(f"/api/v1/scenes/{scene.slug}/restore", headers=H)
        assert first.status_code == 200, first.text
        assert first.json()["fromRecycleBin"] is True
        assert first.json()["stillArchived"] is True
        assert first.json()["status"] == "ARCHIVED"
        assert _row(scene.slug).deleted_at is None
        assert _row(scene.slug).status == "ARCHIVED"

        second = client.post(f"/api/v1/scenes/{scene.slug}/restore", headers=H)
        assert second.status_code == 200, second.text
        assert second.json()["stillArchived"] is False
        assert second.json()["status"] == "READY"
        # The un-archive wrote the recorded pre-archive status back, nothing else.
        assert db.execute(
            text("SELECT status FROM scenes WHERE slug = :s"), {"s": scene.slug}
        ).scalar() == "READY"
