from __future__ import annotations

import pytest

from app.core.config import settings
from app.db.models.asset import Asset
from app.db.models.scene import SceneVersion
from app.services.publish_service import PublishService
from app.services.scene_runtime import SceneRuntimeService
from app.storage.local_disk import LocalDiskStorage


def test_regular_publication_registers_real_entry_and_runtime(
    db, public_scene, monkeypatch, tmp_path,
):
    monkeypatch.setattr("app.services.publish_service.get_repo_root", lambda: tmp_path)
    manifest = {"schemaVersion": 1, "format": "sog", "assetVersion": "regular12345",
                "assetUrl": "versions/regular12345/scene.sog",
                "content": {"entryUrl": "versions/regular12345/scene.sog", "counts": [1788],
                            "byteLength": 100, "sha256": "b" * 64}}
    storage = LocalDiskStorage(settings.storage_root)
    version = PublishService(db, storage).commit_version(scene_id=public_scene.id,
        version_id="regular12345", manifest=manifest, entry_bytes=100,
        entry_url=manifest["assetUrl"], counts=[1788], source_sha256="a" * 64)
    db.commit()
    asset = db.query(Asset).filter(Asset.version_id == version.id, Asset.kind == "SOG").one()
    assert version.format == "sog"
    assert asset.storage_key.endswith("/regular12345/scene.sog")
    assert asset.sha256 == "b" * 64
    content = SceneRuntimeService(db)._resolve_content(public_scene, version)
    assert content.format == "sog"
    assert content.url.endswith("/regular12345/scene.sog")
    assert len(db.query(SceneVersion).filter(SceneVersion.scene_id == public_scene.id).all()) == 2


@pytest.mark.parametrize("visibility,status", [("PUBLIC",200), ("PRIVATE",401)])
def test_regular_runtime_keeps_anonymous_access_policy(
    db, public_scene, monkeypatch, visibility, status,
):
    from fastapi.testclient import TestClient

    from app.main import app

    public_scene.visibility = visibility
    db.flush()
    version = db.get(SceneVersion, public_scene.current_version_id)
    version.format = "sog"
    version.manifest = {"format":"sog", "assetUrl":f"versions/{version.asset_version}/scene.sog",
                        "content":{"counts":[1788]}}
    db.commit()
    monkeypatch.setattr(settings, "dev_identity_enabled", False)
    with TestClient(app) as client:
        response = client.get(f"/api/v1/scenes/{public_scene.slug}/runtime")
        assert response.status_code == status
        if status == 200:
            assert response.json()["content"]["format"] == "sog"
            assert response.json()["content"]["url"].endswith("/scene.sog")
