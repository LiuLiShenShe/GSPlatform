"""PC-INTEGRATION-02 P2-A PostgreSQL settings, ACL and legacy compatibility."""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.core.identity import RequestIdentity, get_optional_current_user, require_csrf
from app.db.models.asset import Asset
from app.db.models.collision_asset import CollisionAsset
from app.db.models.job import Job
from app.db.models.scene_presentation import ScenePresentation
from app.db.models.scene_processing import SceneProcessingSettings
from app.main import app
from app.schemas.scene_processing import SceneProcessingPatch
from app.services.scene_processing import SceneProcessingService, processing_for_scene

client = TestClient(app)


def test_old_defaults_do_not_write_or_change_scene(db, public_scene):
    before = (public_scene.category, public_scene.status, public_scene.current_version_id)
    version = public_scene.current_version
    assert version is not None
    version_before = (version.asset_version, version.manifest, version.sha256)
    counts = (db.query(Asset).count(), db.query(Job).count())
    response = client.get(f"/api/v1/scenes/{public_scene.slug}/processing")
    assert response.status_code == 200
    result = response.json()
    assert result["sceneType"] == "UNSPECIFIED"
    assert result["conversionProfile"] == "balanced"
    assert result["collisionPolicy"] == "MANUAL_ONLY"
    assert result["calibration"]["state"] == "UNVERIFIED"
    assert not result["calibration"]["physicalWalkAllowed"]
    assert db.get(SceneProcessingSettings, public_scene.id) is None
    db.refresh(public_scene)
    assert before == (public_scene.category, public_scene.status, public_scene.current_version_id)
    assert version_before == (version.asset_version, version.manifest, version.sha256)
    assert counts == (db.query(Asset).count(), db.query(Job).count())


@pytest.mark.parametrize("scene_type", ["PLANT_OBJECT", "GREENHOUSE_SCENE", "FIELD_SCENE"])
def test_type_is_independent_and_defaults_manual(db, public_scene, scene_type):
    category = public_scene.category
    counts = (db.query(Job).count(), db.query(Asset).count())
    response = client.patch(
        f"/api/v1/scenes/{public_scene.slug}/processing", json={"sceneType": scene_type}
    )
    assert response.status_code == 200
    assert response.json()["sceneType"] == scene_type
    assert response.json()["collisionPolicy"] == "MANUAL_ONLY"
    assert response.json()["calibration"]["state"] == "UNVERIFIED"
    db.refresh(public_scene)
    assert public_scene.category == category
    assert counts == (db.query(Job).count(), db.query(Asset).count())


def test_policy_edits_preserve_successful_collision(db, public_scene):
    collision = CollisionAsset(scene_id=public_scene.id, mode="OUTDOOR", status="SUCCEEDED")
    db.add(collision)
    db.commit()
    previous = (collision.id, collision.status, collision.build_params)
    response = client.patch(
        f"/api/v1/scenes/{public_scene.slug}/processing",
        json={"conversionProfile": "eco", "sceneType": "PLANT_OBJECT"},
    )
    assert response.status_code == 200
    db.refresh(collision)
    assert previous == (collision.id, collision.status, collision.build_params)


@pytest.mark.parametrize("body", [
    {"sceneType": "architecture"}, {"conversionProfile": "--gpu=0"},
    {"collisionPolicy": "ALWAYS"}, {"sceneType": None}, {"storage_key": "/etc/passwd"},
    {"job_id": str(uuid.uuid4())}, {"execution_generation": 3}, {"cliArgs": ["--help"]},
    {"calibration": {"state": "VERIFIED"}},
    {"calibration": {"state": "ASSUMED", "metersPerSceneUnit": True}},
])
def test_reject_unsafe_processing_inputs(public_scene, body):
    response = client.patch(f"/api/v1/scenes/{public_scene.slug}/processing", json=body)
    assert response.status_code == 422


def test_assumption_binding_and_transform_staleness(db, public_scene):
    response = client.patch(f"/api/v1/scenes/{public_scene.slug}/processing", json={
        "collisionPolicy": "AUTO_WHEN_CALIBRATED",
        "calibration": {
            "state": "ASSUMED", "metersPerSceneUnit": 0.25,
            "referenceMethod": "USER_ASSUMPTION", "referenceValue": 1.0,
            "provenance": "User-provided assumption; not a measured reference",
        },
    })
    assert response.status_code == 200
    result = response.json()["calibration"]
    assert result["sourceVersion"] == public_scene.current_version.asset_version
    assert result["transformIdentity"] == "identity"
    assert result["state"] == "ASSUMED"
    assert not result["physicalWalkAllowed"]
    db.add(ScenePresentation(scene_id=public_scene.id, world_scale={"x": 1, "y": 1, "z": 1}))
    db.commit()
    result = processing_for_scene(db, public_scene).calibration
    assert result.state == "UNVERIFIED" and result.stale
    assert result.recordedState == "ASSUMED"


def test_assumption_source_version_staleness(db, public_scene):
    identity = RequestIdentity(user_id=public_scene.owner_id, email="test@invalid.local",
                               display_name="Test", source="dev")
    service = SceneProcessingService(db)
    request = SceneProcessingPatch.model_validate({"calibration": {
        "state": "ASSUMED", "metersPerSceneUnit": 1.0,
        "referenceMethod": "USER_ASSUMPTION", "referenceValue": 1.0,
        "provenance": "Explicit non-physical test assumption",
    }})
    service.patch(public_scene.slug, identity, request)
    db.commit()
    from app.db.models.scene import SceneVersion

    version = SceneVersion(scene_id=public_scene.id, asset_version=uuid.uuid4().hex,
                           format="streamed-sog", size_bytes=1)
    db.add(version)
    db.flush()
    public_scene.current_version_id = version.id
    db.commit()
    assert processing_for_scene(db, public_scene).calibration.stale


def test_processing_permissions(db, public_scene, private_scene):
    foreign = RequestIdentity(user_id=uuid.uuid4(), email="test@invalid.local",
                              display_name="Foreign", source="dev")
    app.dependency_overrides[require_csrf] = lambda: foreign
    app.dependency_overrides[get_optional_current_user] = lambda: None
    try:
        assert client.get(f"/api/v1/scenes/{public_scene.slug}/processing").status_code == 200
        assert client.get(f"/api/v1/scenes/{private_scene.slug}/processing").status_code == 401
        response = client.patch(f"/api/v1/scenes/{public_scene.slug}/processing",
                                json={"sceneType": "FIELD_SCENE"})
        assert response.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize("column,value", [
    ("scene_type", "architecture"), ("conversion_profile", "arbitrary"),
    ("collision_policy", "ALWAYS"), ("calibration_state", "VERIFIED"),
])
def test_postgresql_constraints_reject_invalid_policy(db, public_scene, column, value):
    row = SceneProcessingSettings(scene_id=public_scene.id)
    setattr(row, column, value)
    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.add(row)
            db.flush()
    db.rollback()


def test_category_constraint_remains_exact(db):
    constraint = db.execute(text(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE conname = 'ck_scenes_category_valid'"
    )).scalar_one()
    for category in ("urban", "architecture", "interior", "nature", "portrait", "experiment"):
        assert category in constraint
    assert "PLANT_OBJECT" not in constraint


def test_upload_processing_declaration_applied_on_completion(db, dev_user_id, tmp_path):
    from app.core.config import settings
    from app.schemas.uploads import CreateUploadRequest
    from app.services.upload_service import UploadService
    from app.storage import LocalDiskStorage

    identity = RequestIdentity(user_id=dev_user_id, email="test@invalid.local",
                               display_name="Test", source="dev")
    service = UploadService(db, LocalDiskStorage(tmp_path), settings,
                            send_task=lambda *args, **kwargs: "test-private-broker")
    created = service.create_session(CreateUploadRequest(
        filename="plant.ply", mime_type="application/octet-stream", size=4, format="ply",
        title="Plant", category="architecture", scene_type="PLANT_OBJECT", conversion_profile="eco",
    ), identity)
    service.append_chunk(created.uploadId, identity, b"ply\n", declared_offset=0)
    result = service.complete(created.uploadId, identity, expected_size=4, client_sha256=None)
    row = db.get(SceneProcessingSettings, result.sceneId)
    assert row is not None and row.scene_type == "PLANT_OBJECT"
    assert row.conversion_profile == "eco" and row.collision_policy == "MANUAL_ONLY"


def test_processing_patch_retains_session_csrf(public_scene):
    import hashlib

    from app.core.identity import get_current_user

    identity = RequestIdentity(
        user_id=public_scene.owner_id, email="test@invalid.local", display_name="Test",
        source="session", csrf_token_hash=hashlib.sha256(b"test-csrf").hexdigest(),
    )
    app.dependency_overrides[get_current_user] = lambda: identity
    try:
        response = client.patch(f"/api/v1/scenes/{public_scene.slug}/processing",
                                json={"sceneType": "FIELD_SCENE"})
        assert response.status_code == 403
    finally:
        app.dependency_overrides.clear()
