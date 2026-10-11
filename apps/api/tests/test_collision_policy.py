"""New-work policy and real PostgreSQL state preservation (no fake VERIFIED fixture)."""

from __future__ import annotations

import uuid

import pytest

from app.core.config import settings
from app.core.errors import ConflictError
from app.db.models.collision_asset import CollisionAsset
from app.db.models.job import Job
from app.db.models.scene_processing import SceneProcessingSettings
from app.schemas.collision import CollisionAssetCreateRequest
from app.services.collision import CollisionService
from app.services.collision_policy import resolve_collision_decision
from app.storage import LocalDiskStorage


class Recorder:
    def __init__(self):
        self.calls = []

    def __call__(self, name, *, args):
        self.calls.append((name, args))
        return type("Task", (), {"id": uuid.uuid4().hex})()


@pytest.mark.parametrize("scene_type", [
    "UNSPECIFIED", "PLANT_OBJECT", "GREENHOUSE_SCENE", "FIELD_SCENE",
])
def test_default_never_creates_new_collision(db, public_scene, scene_type, tmp_path):
    db.add(SceneProcessingSettings(scene_id=public_scene.id, scene_type=scene_type))
    db.commit()
    recorder = Recorder()
    service = CollisionService(db, LocalDiskStorage(tmp_path), send_task=recorder)
    for _ in range(2):
        assert service.ensure_auto_collision_for_current_version(
            public_scene.id, public_scene.owner_id
        ) is None
    service.reconcile_auto_collision()
    assert db.query(Job).filter(Job.scene_id == public_scene.id,
                                Job.kind == "BUILD_COLLISION").count() == 0
    assert db.query(CollisionAsset).filter(CollisionAsset.scene_id == public_scene.id).count() == 0
    assert not [args for _, args in recorder.calls if args[1] == str(public_scene.id)]
    assert resolve_collision_decision(db, public_scene)["reasonCode"] == "POLICY_MANUAL_ONLY"


def test_auto_requires_calibration_not_world_scale(db, public_scene):
    from app.db.models.scene_presentation import ScenePresentation

    db.add(SceneProcessingSettings(scene_id=public_scene.id,
                                   collision_policy="AUTO_WHEN_CALIBRATED"))
    db.add(ScenePresentation(scene_id=public_scene.id, world_scale={"x": 1, "y": 1, "z": 1}))
    db.commit()
    assert resolve_collision_decision(db, public_scene)["reasonCode"] == "CALIBRATION_UNVERIFIED"


def test_assumed_is_never_auto_approved(db, public_scene):
    row = SceneProcessingSettings(
        scene_id=public_scene.id, collision_policy="AUTO_WHEN_CALIBRATED",
        calibration_state="ASSUMED", meters_per_scene_unit=1,
        reference_method="USER_ASSUMPTION", reference_value=1,
        calibration_source_version=public_scene.current_version.asset_version,
        calibration_transform_identity="identity", calibration_evidence={"provenance": "Test"},
    )
    db.add(row)
    db.commit()
    assert resolve_collision_decision(db, public_scene)["reasonCode"] == "CALIBRATION_UNVERIFIED"
    row.calibration_source_version = "older-source"
    db.commit()
    assert resolve_collision_decision(db, public_scene)["reasonCode"] == "CALIBRATION_STALE"


def test_manual_build_and_rebuild_need_explicit_assumption(db, public_scene, tmp_path):
    recorder = Recorder()
    service = CollisionService(db, LocalDiskStorage(tmp_path), send_task=recorder)
    with pytest.raises(ConflictError, match="CALIBRATION_UNVERIFIED"):
        service.create_and_build(public_scene.slug, CollisionAssetCreateRequest(mode="OUTDOOR"),
                                 public_scene.owner_id)
    db.rollback()
    response = service.create_and_build(public_scene.slug, CollisionAssetCreateRequest(
        mode="OUTDOOR", acknowledge_unverified_scale=True,
    ), public_scene.owner_id)
    assert response.status == "QUEUED"
    collision = db.query(CollisionAsset).filter(CollisionAsset.scene_id == public_scene.id).one()
    assert collision.build_params["physicalScaleVerified"] is False
    assert collision.build_params["sourceVersion"] == public_scene.current_version.asset_version
    collision.status = "FAILED"
    db.commit()
    with pytest.raises(ConflictError, match="CALIBRATION_UNVERIFIED"):
        service.rebuild(public_scene.slug, public_scene.owner_id)
    db.rollback()
    response = service.rebuild(public_scene.slug, public_scene.owner_id,
                               acknowledge_unverified_scale=True)
    assert response.status == "QUEUED" and len(recorder.calls) == 2


def test_large_manual_collision_exceeds_operator_budget(db, public_scene, tmp_path):
    public_scene.splat_count = 13_090_324
    public_scene.size_bytes = 3_246_401_885
    db.commit()
    service = CollisionService(db, LocalDiskStorage(tmp_path), send_task=Recorder())
    with pytest.raises(ConflictError, match="RESOURCE_BUDGET_EXCEEDED"):
        service.create_and_build(public_scene.slug, CollisionAssetCreateRequest(
            mode="OUTDOOR", acknowledge_unverified_scale=True,
        ), public_scene.owner_id)
    db.rollback()


def test_running_historical_job_survives_policy_change(db, public_scene, tmp_path):
    recorder = Recorder()
    service = CollisionService(db, LocalDiskStorage(tmp_path), send_task=recorder)
    response = service.create_and_build(public_scene.slug, CollisionAssetCreateRequest(
        mode="OUTDOOR", acknowledge_unverified_scale=True,
    ), public_scene.owner_id)
    job = db.get(Job, uuid.UUID(response.job_id))
    job.status = "RUNNING"
    collision = db.query(CollisionAsset).filter(CollisionAsset.scene_id == public_scene.id).one()
    collision.status = "RUNNING"
    db.commit()
    service.ensure_auto_collision_for_current_version(public_scene.id, public_scene.owner_id)
    db.refresh(job)
    assert job.status == "RUNNING" and len(recorder.calls) == 1


def test_legacy_succeeded_collision_not_deleted_under_manual_policy(db, public_scene, tmp_path):
    collision = CollisionAsset(
        scene_id=public_scene.id, mode="OUTDOOR", status="SUCCEEDED",
        build_params={"sourceVersion": public_scene.current_version.asset_version},
    )
    db.add(collision)
    db.commit()
    service = CollisionService(db, LocalDiskStorage(tmp_path), send_task=Recorder())
    response = service.ensure_auto_collision_for_current_version(public_scene.id,
                                                                  public_scene.owner_id)
    assert response is not None and response.status == "SUCCEEDED"
    db.refresh(collision)
    assert collision.status == "SUCCEEDED"


def test_duplicate_completed_publish_respects_manual_policy(db, public_scene):
    from datetime import UTC, datetime, timedelta

    from workers.tasks.publish_scene import publish_scene

    from app.db.models.upload_session import UploadSession

    upload = UploadSession(
        owner_id=public_scene.owner_id, scene_id=public_scene.id, status="SUCCEEDED",
        storage_key="not-read", mime_type="application/octet-stream", upload_format="ply",
        total_size=4, offset=4, expires_at=datetime.now(UTC) + timedelta(days=1),
        title="Duplicate", visibility="PRIVATE", category="experiment",
    )
    job = Job(owner_id=public_scene.owner_id, scene_id=public_scene.id,
              kind="PUBLISH", status="SUCCEEDED")
    db.add_all([upload, job])
    db.commit()
    assert publish_scene(str(upload.id), str(public_scene.id), str(job.id))["duplicate"]
    assert db.query(Job).filter(Job.scene_id == public_scene.id,
                                Job.kind == "BUILD_COLLISION").count() == 0


def test_failed_old_job_does_not_pollute_new_upload_version(db, public_scene):
    from datetime import UTC, datetime, timedelta

    from app.core.identity import RequestIdentity
    from app.db.models.upload_session import UploadSession
    from app.services.upload_service import UploadService

    job = Job(owner_id=public_scene.owner_id, scene_id=public_scene.id,
              kind="BUILD_COLLISION", status="FAILED")
    db.add(job)
    db.flush()
    db.add(CollisionAsset(scene_id=public_scene.id, mode="OUTDOOR", status="FAILED", job_id=job.id,
                          build_params={"sourceVersion": "old-version"}))
    upload = UploadSession(
        owner_id=public_scene.owner_id, scene_id=public_scene.id, status="SUCCEEDED",
        storage_key="not-read", mime_type="application/octet-stream", upload_format="ply",
        total_size=4, offset=4, expires_at=datetime.now(UTC) + timedelta(days=1),
        title="Status", visibility="PRIVATE", category="experiment",
    )
    db.add(upload)
    db.commit()
    identity = RequestIdentity(user_id=public_scene.owner_id, email="test@invalid.local",
                               display_name="Test")
    result = UploadService(db, LocalDiskStorage(settings.storage_root), settings).get_status(
        upload.id, identity
    )
    assert result.collisionRequired is False
    assert result.collisionStatus is None


@pytest.mark.parametrize("with_job", [False, True])
def test_stale_or_orphaned_rows_do_not_bypass_manual_policy(db, public_scene, with_job, tmp_path):
    job = Job(owner_id=public_scene.owner_id, scene_id=public_scene.id,
              kind="BUILD_COLLISION", status="QUEUED") if with_job else None
    if job is not None:
        db.add(job)
        db.flush()
    collision = CollisionAsset(scene_id=public_scene.id, mode="OUTDOOR", status="QUEUED",
                               job_id=job.id if job else None,
                               build_params={"sourceVersion": "previous-version"})
    db.add(collision)
    db.commit()
    recorder = Recorder()
    service = CollisionService(db, LocalDiskStorage(tmp_path), send_task=recorder)
    assert service.ensure_auto_collision_for_current_version(public_scene.id,
                                                              public_scene.owner_id) is None
    assert resolve_collision_decision(db, public_scene)["reasonCode"] == "POLICY_MANUAL_ONLY"
    db.refresh(collision)
    assert collision.status == "QUEUED"
    assert not recorder.calls


@pytest.mark.parametrize("acknowledged", ["true", 1, "yes"])
def test_nonphysical_confirmation_is_strict_not_truthy(acknowledged):
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        CollisionAssetCreateRequest(mode="OUTDOOR", acknowledge_unverified_scale=acknowledged)
