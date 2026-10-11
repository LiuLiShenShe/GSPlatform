"""Same-scene resumable uploads and PostgreSQL publication compare-and-swap."""

from __future__ import annotations

import hashlib
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Event

import pytest
from sqlalchemy import select

from app.core.config import settings
from app.db.models.job import Job
from app.db.models.scene import Scene, SceneVersion
from app.db.models.scene_edit_session import SceneEditSession
from app.db.models.scene_spatial_state import SceneSpatialState
from app.db.models.upload_session import UploadSession
from app.db.session import SessionLocal
from app.services.editor_session import EditBaseVersionChanged
from app.services.publish_service import PublishService
from app.storage import LocalDiskStorage
from tests.test_editor_sessions import create_edit
from tests.test_editor_sessions import owner as owner


def upload_export(owner, edit, payload=b"export-bytes", *, digest=None):
    client, scene, headers = owner
    url = f"/api/v1/scenes/{scene.slug}/edit-sessions/{edit['id']}"
    response = client.post(url + "/uploads", headers=headers, json={
        "filename": "edited.ply", "format": "ply", "size": len(payload), "sha256": digest,
    })
    assert response.status_code == 200, response.text
    upload = response.json()
    response = client.patch(f"/api/v1/uploads/{upload['uploadId']}",
                            headers={**headers, "Upload-Offset": "0"}, content=payload)
    assert response.status_code == 200, response.text
    return url, upload


def publish_arguments(scene, edit, asset_version):
    return dict(
        scene_id=scene.id, version_id=asset_version,
        manifest={"schemaVersion": 1, "assetVersion": asset_version,
                  "conversionRecipe": {"toolVersion": "3.3.3", "recipeVersion": "2"}},
        entry_bytes=10, entry_url=f"versions/{asset_version}/lod-meta.json",
        counts=[2, 1, 1], source_sha256=edit.result_sha256, edit_session_id=edit.id,
    )


def test_export_reuses_chunk_protocol_same_scene_sha_and_job(owner, db, monkeypatch):
    client, scene, headers = owner
    source_version = scene.current_version_id
    edit = create_edit(owner)
    calls = []
    monkeypatch.setattr("app.services.celery_client.send_task",
                        lambda *args, **kwargs: calls.append((args, kwargs)))
    payload = b"export-bytes"
    digest = hashlib.sha256(payload).hexdigest()
    url, upload = upload_export(owner, edit, payload, digest=digest)
    response = client.post(url + "/complete", headers=headers, json={
        "expected_size": len(payload), "sha256": digest,
    })
    assert response.status_code == 200, response.text
    completed = response.json()
    assert completed["sceneId"] == str(scene.id)
    assert len(calls) == 1
    db.expire_all()
    assert db.get(Scene, scene.id).current_version_id == source_version
    assert db.get(UploadSession, upload["uploadId"]).scene_id == scene.id
    assert db.get(SceneEditSession, edit["id"]).result_sha256 == digest
    assert db.query(SceneVersion).filter_by(scene_id=scene.id).count() == 1
    repeat = client.post(url + "/complete", headers=headers, json={"sha256": digest})
    assert repeat.status_code == 200
    assert repeat.json()["jobId"] == completed["jobId"]
    assert len(calls) == 1
    status = client.get(f"/api/v1/uploads/{upload['uploadId']}/status").json()
    assert status["collisionRequired"] is False
    assert status["collisionPolicyReason"] == "POLICY_MANUAL_ONLY"


@pytest.mark.parametrize("state", ["CANCELLED", "EXPIRED"])
def test_terminated_session_blocks_generic_protocol_and_keeps_pointer(owner, db, state):
    client, scene, headers = owner
    edit = create_edit(owner)
    url, upload = upload_export(owner, edit)
    record = db.get(SceneEditSession, edit["id"])
    if state == "EXPIRED":
        record.created_at = datetime.now(UTC) - timedelta(hours=1)
        record.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    else:
        record.status = state
    db.commit()
    original_version = scene.current_version_id
    generic = f"/api/v1/uploads/{upload['uploadId']}"
    assert client.post(generic + "/complete", headers=headers, json={}).status_code == 409
    assert client.post(url + "/complete", headers=headers, json={}).status_code == 409
    assert client.patch(generic, headers={**headers, "Upload-Offset": "12"},
                        content=b"x").status_code == 409
    db.expire_all()
    assert db.get(Scene, scene.id).current_version_id == original_version


def test_checksum_offset_bounds_wrong_scene_and_replacement(owner, db):
    client, scene, headers = owner
    edit = create_edit(owner)
    url, upload = upload_export(owner, edit)
    generic = f"/api/v1/uploads/{upload['uploadId']}"
    assert client.post(url + "/complete", headers=headers,
                       json={"sha256": "0" * 64}).status_code == 409
    assert client.patch(generic, headers={**headers, "Upload-Offset": "0"},
                        content=b"wrong offset").status_code == 409
    assert client.post(url + "/uploads", headers=headers, json={
        "filename": "other.ply", "format": "ply", "size": 3,
    }).status_code == 409
    assert client.post(url.replace(scene.slug, "wrong-scene") + "/complete",
                       headers=headers, json={}).status_code == 404
    assert db.query(Job).filter_by(scene_id=scene.id, kind="PUBLISH").count() == 0


def test_publication_keeps_source_immutable_records_provenance_and_stale(owner, db):
    client, scene, headers = owner
    source_id = scene.current_version_id
    original = db.get(SceneVersion, source_id)
    from app.db.models.scene_processing import SceneProcessingSettings

    db.add(SceneProcessingSettings(scene_id=scene.id, collision_policy="AUTO_WHEN_CALIBRATED"))
    source_sha = original.sha256
    source_file = (Path(settings.storage_root) / "published" / str(scene.id)
                   / "versions" / original.asset_version / "scene.ply")
    before = hashlib.sha256(source_file.read_bytes()).hexdigest()
    edit = create_edit(owner)
    record = db.get(SceneEditSession, edit["id"])
    record.result_sha256 = "b" * 64
    record.provenance = {"sourceVersionId": str(source_id), "editSessionId": edit["id"]}
    db.flush()
    service = PublishService(db, LocalDiskStorage(settings.storage_root))
    result = service.commit_version(**publish_arguments(scene, record, "edited000001"))
    db.commit()
    assert result.scene_id == scene.id
    assert scene.current_version_id == result.id
    assert record.status == "COMPLETED"
    assert record.provenance["conversionRecipe"]["toolVersion"] == "3.3.3"
    assert record.provenance["collisionPolicy"] == "MANUAL_ONLY"
    assert record.provenance["previousCollisionPolicy"] == "AUTO_WHEN_CALIBRATED"
    assert db.get(SceneProcessingSettings, scene.id).collision_policy == "MANUAL_ONLY"
    assert db.get(SceneSpatialState, scene.id).state == "STALE"
    assert db.get(SceneVersion, source_id).sha256 == source_sha
    assert hashlib.sha256(source_file.read_bytes()).hexdigest() == before
    assert db.query(SceneVersion).filter_by(scene_id=scene.id).count() == 2
    source_info = client.get(f"/api/v1/scenes/{scene.slug}/edit-source").json()
    assert source_info["spatialState"] == "STALE"
    assert client.post(f"/api/v1/scenes/{scene.slug}/edit-sessions/{edit['id']}/cancel",
                       headers=headers).status_code == 409


def test_two_sessions_final_scene_lock_and_cas_prevent_lost_update(owner, db):
    _, scene, _ = owner
    first = create_edit(owner)
    second = create_edit(owner)
    first_record = db.get(SceneEditSession, first["id"])
    second_record = db.get(SceneEditSession, second["id"])
    first_record.result_sha256 = "a" * 64
    second_record.result_sha256 = "b" * 64
    db.commit()
    first_arguments = publish_arguments(scene, first_record, "edited000002")
    second_arguments = publish_arguments(scene, second_record, "edited000003")
    started = Event()
    db.execute(select(Scene).where(Scene.id == scene.id).with_for_update(of=Scene))

    def concurrent_publish():
        with SessionLocal() as concurrent:
            started.set()
            with pytest.raises(EditBaseVersionChanged):
                PublishService(concurrent, LocalDiskStorage(settings.storage_root)).commit_version(
                    **second_arguments,
                )
            concurrent.rollback()

    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(concurrent_publish)
        assert started.wait(5)
        result = PublishService(db, LocalDiskStorage(settings.storage_root)).commit_version(
            **first_arguments,
        )
        assert not pending.done()
        db.commit()
        pending.result(timeout=10)
    db.expire_all()
    assert db.get(Scene, scene.id).current_version_id == result.id
    assert db.query(SceneVersion).filter_by(scene_id=scene.id).count() == 2


def test_changed_base_rejects_complete_but_retains_valid_uploaded_bytes(owner, db):
    client, scene, headers = owner
    edit = create_edit(owner)
    url, upload = upload_export(owner, edit)
    new_version = SceneVersion(scene_id=scene.id, asset_version=uuid.uuid4().hex[:12],
                               format="sog", size_bytes=10, sha256="a" * 64, manifest={})
    db.add(new_version)
    db.flush()
    scene.current_version_id = new_version.id
    db.commit()
    response = client.post(url + "/complete", headers=headers, json={})
    assert response.status_code == 409
    assert response.json()["code"] == "EDIT_BASE_VERSION_CHANGED"
    assert (Path(settings.storage_root) / "staging" / upload["uploadId"]
            / "upload.bin").read_bytes() == b"export-bytes"
    db.expire_all()
    assert db.get(Scene, scene.id).current_version_id == new_version.id


def test_export_retention_preserves_current_and_history(owner, db):
    from app.services.editor_session import EditorSessionService

    _, scene, _ = owner
    edit = create_edit(owner)
    _, upload = upload_export(owner, edit)
    record = db.get(SceneEditSession, edit["id"])
    record.created_at = datetime.now(UTC) - timedelta(days=10)
    record.expires_at = datetime.now(UTC) - timedelta(days=8)
    db.commit()
    current = scene.current_version_id
    assert EditorSessionService(db, settings).cleanup_exports() == 1
    assert record.status == "EXPIRED"
    assert not (Path(settings.storage_root) / "staging" / upload["uploadId"]).exists()
    assert db.get(Scene, scene.id).current_version_id == current
    assert db.get(SceneVersion, current) is not None


def test_stale_spatial_history_is_preserved_but_not_used_by_runtime(owner, db):
    from app.db.models.asset import Asset
    from app.db.models.collision_asset import CollisionAsset
    from app.db.models.scene_presentation import ScenePresentation
    from app.services.collision import world_transform_hash

    client, scene, _ = owner
    position = {"x": 1.0, "y": 2.0, "z": 3.0}
    presentation = ScenePresentation(scene_id=scene.id, world_position=position,
                                     initial_camera_position=position, collision_enabled=True)
    db.add(presentation)
    db.add(SceneSpatialState(scene_id=scene.id, source_version_id=scene.current_version_id,
                             state="STALE", stale_at=datetime.now(UTC)))
    asset = Asset(scene_id=scene.id, version_id=scene.current_version_id,
                  kind="COLLISION_GLB", storage_key="private/collision.glb",
                  mime_type="model/gltf-binary", byte_size=3, sha256="a" * 64, metadata_={})
    db.add(asset)
    db.flush()
    collision = CollisionAsset(scene_id=scene.id, asset_id=asset.id, mode="OUTDOOR",
                               status="SUCCEEDED", build_params={
                                   "sourceVersion": scene.current_version.asset_version,
                                   "worldTransformHash": world_transform_hash(position, None, None),
                               })
    db.add(collision)
    db.commit()
    runtime = client.get(f"/api/v1/scenes/{scene.slug}/runtime").json()
    assert runtime["presentation"]["initialCamera"]["position"] is None
    assert runtime["presentation"]["worldTransform"]["position"] is None
    assert runtime["viewpoints"] == []
    assert runtime["annotations"] == []
    assert runtime["collision"]["stale"] is True
    assert runtime["collision"]["enabled"] is False
    assert runtime["collision"]["url"] is None
    db.refresh(presentation)
    assert presentation.world_position == position
    assert presentation.initial_camera_position == position
    assert db.get(CollisionAsset, collision.id).status == "SUCCEEDED"
