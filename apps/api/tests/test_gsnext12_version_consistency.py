"""GS-NEXT-12 §B — version activation / scene-origin consistency.

Covers the filesystem side of a switch:

* the ``current`` alias is swapped atomically — a concurrent reader never sees
  it missing;
* a bridge failure leaves the DB pointer untouched (compensation);
* a DB commit failure re-points the alias back at the previous version;
* the repeatable consistency checker detects a broken alias and safely repairs
  it without ever touching immutable version bytes;
* a missing version directory is reported and never "repaired" destructively.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.core.identity import RequestIdentity, _resolve_dev_user_id
from app.db.models.asset import Asset
from app.db.models.scene import Scene, SceneVersion
from app.main import app
from app.services.publish_service import bridge_scene_origin, scene_origin_slug_dir
from app.services.scene_versions import SceneVersionService
from app.services.version_consistency import check_scene, check_scenes, repair_scene
from tests.conftest_scenes import create_scene

client = TestClient(app)
H: dict[str, str] = {}
_SEQ = {"n": 0}


@pytest.fixture()
def isolated_roots(tmp_path, monkeypatch):
    origin = tmp_path / "scene-origin"
    origin.mkdir()
    storage = tmp_path / "storage"
    storage.mkdir()
    monkeypatch.setattr(settings, "storage_root", str(storage))
    monkeypatch.setattr(settings, "scene_origin_root", str(origin))
    monkeypatch.setattr("app.services.publish_service.get_repo_root", lambda: tmp_path)
    return storage, origin


def _make_version(db, scene: Scene) -> SceneVersion:
    av = uuid.uuid4().hex[:24]
    directory = Path(settings.storage_root) / "published" / str(scene.id) / "versions" / av
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "scene.sog").write_bytes(b"SOG" + av.encode())
    payload = b"SOG" + av.encode()
    manifest = {
        "format": "sog",
        "assetUrl": f"versions/{av}/scene.sog",
        "content": {
            "entryUrl": f"versions/{av}/scene.sog",
            "counts": [100],
            "sha256": hashlib.sha256(payload).hexdigest(),
        },
    }
    (directory / "manifest.json").write_text(json.dumps(manifest))
    _SEQ["n"] += 1
    version = SceneVersion(
        scene_id=scene.id,
        asset_version=av,
        format="sog",
        size_bytes=len(payload),
        sha256=hashlib.sha256(av.encode()).hexdigest(),
        manifest=manifest,
        created_at=datetime(2026, 10, 21, 12, 0, tzinfo=UTC) + timedelta(seconds=_SEQ["n"]),
    )
    db.add(version)
    db.flush()
    db.add(
        Asset(
            scene_id=scene.id,
            version_id=version.id,
            kind="SOG",
            storage_key=f"published/{scene.id}/versions/{av}/scene.sog",
            mime_type="application/octet-stream",
            byte_size=len(payload),
            sha256="",
            metadata_={"counts": [100]},
        )
    )
    db.commit()
    db.refresh(version)
    return version


def _scene(db):
    scene = create_scene(
        session=db,
        title="一致性",
        slug=f"gsnext12-cons-{uuid.uuid4().hex[:8]}",
        with_version=False,
    )
    a = _make_version(db, scene)
    b = _make_version(db, scene)
    scene.current_version_id = a.id
    db.add(scene)
    db.commit()
    db.refresh(scene)
    return scene, a, b


def _activate(slug: str, version_id, expected):
    return client.post(
        f"/api/v1/scenes/{slug}/versions/{version_id}/activate",
        headers=H,
        json={"expectedCurrentVersionId": str(expected)},
    )


def _alias_target(scene: Scene) -> str | None:
    slug_dir = scene_origin_slug_dir(scene)
    if slug_dir is None or not (slug_dir / "current").is_symlink():
        return None
    return os.readlink(slug_dir / "current")


class TestAtomicAliasSwap:
    def test_concurrent_readers_never_see_a_missing_alias(self, db, isolated_roots):
        scene, a, b = _scene(db)
        assert bridge_scene_origin(scene, a.asset_version) is True
        slug_dir = scene_origin_slug_dir(scene)
        assert slug_dir is not None
        stop = threading.Event()
        missing: list[str] = []
        errors: list[str] = []

        def reader() -> None:
            link = slug_dir / "current"
            while not stop.is_set():
                try:
                    os.readlink(link)
                except FileNotFoundError:
                    missing.append("ENOENT")
                except OSError as exc:  # pragma: no cover - unexpected
                    errors.append(str(exc))
                time.sleep(0.0005)

        thread = threading.Thread(target=reader, daemon=True)
        thread.start()
        try:
            for index in range(100):
                target = b if index % 2 == 0 else a
                assert bridge_scene_origin(scene, target.asset_version) is True
        finally:
            stop.set()
            thread.join(timeout=5)
        assert missing == []
        assert errors == []

    def test_bridge_failure_leaves_db_pointer_unchanged(self, db, isolated_roots, monkeypatch):
        scene, a, b = _scene(db)
        assert bridge_scene_origin(scene, a.asset_version) is True
        monkeypatch.setattr(
            "app.services.scene_versions.bridge_scene_origin", lambda *args: False
        )
        response = _activate(scene.slug, b.id, a.id)
        assert response.status_code == 503, response.text
        db.expire_all()
        assert db.get(Scene, scene.id).current_version_id == a.id
        assert _alias_target(scene) == f"versions/{a.asset_version}"

    def test_commit_failure_compensates_the_alias(self, db, isolated_roots, monkeypatch):
        scene, a, b = _scene(db)
        assert bridge_scene_origin(scene, a.asset_version) is True
        identity = RequestIdentity(
            user_id=_resolve_dev_user_id(settings),
            email="dev@gsplatform.local",
            display_name="dev",
        )
        service = SceneVersionService(db)
        original_commit = db.commit
        calls = {"n": 0}

        def flaky_commit() -> None:
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("simulated commit failure")
            original_commit()

        monkeypatch.setattr(db, "commit", flaky_commit)
        try:
            with pytest.raises(RuntimeError, match="commit failure"):
                service.activate(scene.slug, b.id, identity, expected_current_version_id=a.id)
        finally:
            monkeypatch.setattr(db, "commit", original_commit)

        from app.db.session import SessionLocal

        with SessionLocal() as fresh:
            current = fresh.get(Scene, scene.id).current_version_id
        assert str(current) == str(a.id)
        assert _alias_target(scene) == f"versions/{a.asset_version}"


class TestConsistencyChecker:
    def test_consistent_scene_reports_ok(self, db, isolated_roots):
        scene, a, b = _scene(db)
        assert _activate(scene.slug, b.id, a.id).status_code == 200
        db.expire_all()
        scene = db.get(Scene, scene.id)
        result = check_scene(db, scene)
        assert result.ok, result.problems

    def test_broken_alias_is_detected_and_safely_repaired(self, db, isolated_roots):
        scene, a, b = _scene(db)
        assert _activate(scene.slug, b.id, a.id).status_code == 200
        db.expire_all()
        scene = db.get(Scene, scene.id)
        slug_dir = scene_origin_slug_dir(scene)
        assert slug_dir is not None
        # Corrupt the alias by hand (as a crash / manual edit would).
        (slug_dir / "current").unlink()
        (slug_dir / "current").symlink_to(f"versions/{a.asset_version}")

        broken = check_scene(db, scene)
        assert not broken.ok
        assert "current_alias_mismatch" in broken.problems
        assert "alias" in broken.repairable

        repaired = repair_scene(db, scene, broken)
        assert repaired.ok, (repaired.problems, repaired.notes)
        assert "alias" in repaired.repaired
        assert _alias_target(scene) == f"versions/{b.asset_version}"
        # The immutable version bytes are untouched (only the mutable alias moved).
        assert (slug_dir / "versions" / b.asset_version).exists()
        for version in (a, b):
            assert (
                Path(settings.storage_root)
                / "published"
                / str(scene.id)
                / "versions"
                / version.asset_version
            ).is_dir()

    def test_missing_version_directory_is_never_repaired_destructively(self, db, isolated_roots):
        scene, a, b = _scene(db)
        assert _activate(scene.slug, b.id, a.id).status_code == 200
        db.expire_all()
        scene = db.get(Scene, scene.id)
        # Remove the *new* immutable version bytes (simulated storage loss).
        target_dir = (
            Path(settings.storage_root) / "published" / str(scene.id) / "versions" / b.asset_version
        )
        import shutil

        shutil.rmtree(target_dir)
        result = check_scene(db, scene)
        assert "version_directory_missing" in result.problems
        repaired = repair_scene(db, scene, result)
        assert not repaired.ok
        assert "manual_intervention_required" in repaired.notes
        # The DB pointer was NOT changed and nothing was deleted.
        db.expire_all()
        assert db.get(Scene, scene.id).current_version_id == b.id

    def test_check_scenes_is_read_only_by_default(self, db, isolated_roots):
        scene, a, b = _scene(db)
        assert _activate(scene.slug, b.id, a.id).status_code == 200
        db.expire_all()
        scene = db.get(Scene, scene.id)
        slug_dir = scene_origin_slug_dir(scene)
        assert slug_dir is not None
        (slug_dir / "current").unlink()
        (slug_dir / "current").symlink_to(f"versions/{a.asset_version}")
        before = _alias_target(scene)
        results = check_scenes(db, slug=scene.slug, repair=False)
        assert len(results) == 1 and not results[0].ok
        assert _alias_target(scene) == before
