from __future__ import annotations

import json
import uuid

import pytest

from app.core.errors import ConflictError
from app.db.models.asset import Asset
from app.db.models.scene import Scene
from app.services.publish_service import PublishService
from app.storage import LocalDiskStorage


def test_duplicate_manifest_cannot_hide_changed_chunk(tmp_path, db):
    scene_id = uuid.uuid4()
    version = "recipe000001"
    storage = LocalDiskStorage(str(tmp_path))
    original = tmp_path / f"published/{scene_id}/versions/{version}"
    staging = tmp_path / f"published/{scene_id}/.staging-new/{version}"
    for directory, payload in [(original, b"old"), (staging, b"new")]:
        directory.mkdir(parents=True)
        (directory / "manifest.json").write_text(json.dumps({"assetVersion": version}))
        (directory / "chunk.webp").write_bytes(payload)
    service = PublishService(db, storage)
    with pytest.raises(ConflictError):
        service.promote_staging_to_version(
            scene_id, version, staging.relative_to(tmp_path).as_posix()
        )
    assert (original / "chunk.webp").read_bytes() == b"old"


def test_database_idempotency_rejects_mismatched_provenance(tmp_path, db, public_scene):
    service = PublishService(db, LocalDiskStorage(str(tmp_path)))
    manifest = {"schemaVersion": 1, "assetVersion": "recipe000002", "poster": None}
    original = service.commit_version(
        scene_id=public_scene.id,
        version_id="recipe000002",
        manifest=manifest,
        entry_bytes=10,
        entry_url="versions/recipe000002/lod-meta.json",
        counts=[100, 30, 10],
        source_sha256="a" * 64,
    )
    db.commit()
    with pytest.raises(ConflictError):
        service.commit_version(
            scene_id=public_scene.id,
            version_id="recipe000002",
            manifest=manifest,
            entry_bytes=10,
            entry_url="versions/recipe000002/lod-meta.json",
            counts=[100, 30, 10],
            source_sha256="b" * 64,
        )
    db.rollback()
    scene = db.get(Scene, public_scene.id)
    assert scene.current_version_id == original.id


def test_asset_hash_is_output_hash_not_source_hash(tmp_path, db, public_scene):
    service = PublishService(db, LocalDiskStorage(str(tmp_path)))
    source_hash = "a" * 64
    output_hash = "b" * 64
    manifest = {
        "schemaVersion": 1,
        "assetVersion": "recipe000003",
        "sourceSha256": source_hash,
        "stream": {"sha256": output_hash},
    }
    version = service.commit_version(
        scene_id=public_scene.id,
        version_id="recipe000003",
        manifest=manifest,
        entry_bytes=10,
        entry_url="versions/recipe000003/lod-meta.json",
        counts=[100, 30, 10],
        source_sha256=source_hash,
    )
    db.flush()
    asset = db.query(Asset).filter_by(version_id=version.id, kind="SOG").one()
    assert version.sha256 == source_hash
    assert asset.sha256 == output_hash
    assert asset.metadata_["sourceSha256"] == source_hash
    assert public_scene.splat_count == 100
    asset.sha256 = source_hash
    asset.metadata_ = {"counts": [100, 30, 10], "lodLevels": 3}
    db.flush()
    duplicate = service.commit_version(
        scene_id=public_scene.id,
        version_id="recipe000003",
        manifest=manifest,
        entry_bytes=10,
        entry_url="versions/recipe000003/lod-meta.json",
        counts=[100, 30, 10],
        source_sha256=source_hash,
    )
    assert duplicate.id == version.id
    assert asset.sha256 == output_hash
    assert asset.metadata_["sourceSha256"] == source_hash
