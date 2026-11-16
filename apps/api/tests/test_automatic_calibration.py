import uuid

import pytest

from app.core.config import settings
from app.db.models.scene_edit_session import SceneEditSession
from app.db.models.scene_processing import SceneProcessingSettings
from app.schemas.scene_presentation import (
    ScenePresentationUpdateRequest,
    SceneViewpointCreateRequest,
)
from app.services.authoring import AuthoringService
from app.storage import LocalDiskStorage
from tests import test_editor_sessions

owner = test_editor_sessions.owner


def payload(scene):
    return {
        "expectedCurrentVersion": str(scene.current_version_id),
        "referenceName": "20 mm cube",
        "originalDistance": 0.25,
        "realLength": 20,
        "unit": "mm",
    }


def test_automatic_calibration_queues_without_client_file_and_is_idempotent(owner, monkeypatch, db):
    client, scene, headers = owner
    calls = []
    monkeypatch.setattr(
        "app.services.celery_client.send_task", lambda name, **kw: calls.append((name, kw))
    )
    url = f"/api/v1/scenes/{scene.slug}/calibrate"
    assert client.post(url, json=payload(scene)).status_code == 403
    response = client.post(url, json=payload(scene), headers=headers)
    assert response.status_code == 202, response.text
    data = response.json()
    assert data["status"] == "QUEUED"
    assert data["automaticCalibration"]["scaleFactor"] == 8
    assert data["automaticCalibration"]["geometryUnits"] == "cm"
    assert data["uploadId"] and len(calls) == 1
    assert client.post(url, json=payload(scene), headers=headers).json()["id"] == data["id"]
    assert len(calls) == 1
    # A spatial write racing the worker is rejected before it changes anything.
    from app.core.errors import ConflictError
    from app.schemas.scene_presentation import ScenePresentationUpdateRequest
    from app.services.authoring import AuthoringService
    from app.storage import LocalDiskStorage

    with pytest.raises(ConflictError, match="尺度标定正在进行"):
        AuthoringService(db, LocalDiskStorage(settings.storage_root)).update_presentation(
            scene.slug, scene.owner_id, ScenePresentationUpdateRequest(initialCameraFov=60)
        )
    db.rollback()


@pytest.mark.parametrize("length,unit", [(200, "mm"), (20, "cm"), (0.2, "m")])
def test_calibration_always_bakes_centimeter_geometry(owner, monkeypatch, db, length, unit):
    from app.db.models.scene import SceneVersion
    from app.services.automatic_calibration import finish_calibration

    client, scene, headers = owner
    monkeypatch.setattr("app.services.celery_client.send_task", lambda *a, **kw: None)
    response = client.post(
        f"/api/v1/scenes/{scene.slug}/calibrate",
        json={**payload(scene), "realLength": length, "unit": unit},
        headers=headers,
    )
    assert response.status_code == 202, response.text
    request = response.json()["automaticCalibration"]
    # A 0.25-unit reference becomes 20 cm, not 0.2 coordinate units.
    assert request["scaleFactor"] * 0.25 == pytest.approx(20)
    edit = db.get(SceneEditSession, response.json()["id"])
    edit.provenance = {
        **edit.provenance,
        "automaticVerification": {"allGaussianAttributesChecked": True},
    }
    result = SceneVersion(
        scene_id=scene.id, asset_version=uuid.uuid4().hex,
        format="ply", size_bytes=1,
    )
    db.add(result)
    db.flush()
    scene.current_version_id = result.id
    finish_calibration(db, scene, result, edit)
    db.flush()
    row = db.get(SceneProcessingSettings, scene.id)
    assert row.meters_per_scene_unit == 0.01
    assert row.calibration_evidence["geometryUnits"] == "cm"
    assert row.calibration_evidence["realLengthMeters"] == pytest.approx(0.2)


@pytest.mark.parametrize("kind", ["camera", "world", "marker", "completed"])
def test_other_edits_permanently_lock_calibration(owner, db, kind):
    client, scene, headers = owner
    service = AuthoringService(db, LocalDiskStorage(settings.storage_root))
    if kind == "camera":
        service.update_presentation(
            scene.slug, scene.owner_id, ScenePresentationUpdateRequest(initialCameraFov=60)
        )
    elif kind == "world":
        service.update_presentation(
            scene.slug,
            scene.owner_id,
            ScenePresentationUpdateRequest(worldScale={"x": 2, "y": 2, "z": 2}),
        )
    elif kind == "marker":
        view = service.create_viewpoint(
            scene.slug,
            scene.owner_id,
            SceneViewpointCreateRequest(
                name="View",
                position={"x": 1, "y": 2, "z": 3},
                target={"x": 0, "y": 0, "z": 0},
                fov=60,
            ),
        )
        service.delete_viewpoint(scene.slug, scene.owner_id, view.id)
    else:
        db.add(
            SceneProcessingSettings(
                scene_id=scene.id,
                calibration_evidence={"geometryScaleAppliedBy": "OFFICIAL_SPLAT_TRANSFORM"},
            )
        )
    db.commit()
    source = client.get(f"/api/v1/scenes/{scene.slug}/edit-source").json()
    assert source["calibrationAvailable"] is False
    assert source["calibrationBlockedReason"]
    result = client.post(
        f"/api/v1/scenes/{scene.slug}/calibrate", json=payload(scene), headers=headers
    )
    assert result.status_code == 409, result.text
    assert db.query(SceneEditSession).filter_by(scene_id=scene.id).count() == 0


def test_calibration_rejects_changed_version_and_invalid_dimensions(owner):
    import uuid

    client, scene, headers = owner
    url = f"/api/v1/scenes/{scene.slug}/calibrate"
    body = payload(scene)
    assert (
        client.post(
            url, json={**body, "expectedCurrentVersion": str(uuid.uuid4())}, headers=headers
        ).status_code
        == 409
    )
    for invalid in (0, -1):
        assert (
            client.post(
                url, json={**body, "originalDistance": invalid}, headers=headers
            ).status_code
            == 422
        )


def test_dispatch_failure_does_not_leave_calibration_locked(owner, monkeypatch):
    client, scene, headers = owner

    def unavailable(*args, **kwargs):
        raise RuntimeError("broker unavailable")

    monkeypatch.setattr("app.services.celery_client.send_task", unavailable)
    response = client.post(
        f"/api/v1/scenes/{scene.slug}/calibrate", json=payload(scene), headers=headers
    )
    assert response.status_code == 503
    source = client.get(f"/api/v1/scenes/{scene.slug}/edit-source").json()
    assert source["calibrationAvailable"] is True


def test_saving_then_resetting_camera_does_not_unlock_calibration(owner, db):
    from app.schemas.scene_presentation import ScenePresentationUpdateRequest
    from app.services.authoring import AuthoringService
    from app.storage import LocalDiskStorage

    client, scene, headers = owner
    service = AuthoringService(db, LocalDiskStorage(settings.storage_root))
    service.update_presentation(
        scene.slug, scene.owner_id, ScenePresentationUpdateRequest(initialCameraFov=60)
    )
    db.commit()
    service.update_presentation(
        scene.slug, scene.owner_id, ScenePresentationUpdateRequest(), overwrite=True
    )
    db.commit()
    assert (
        client.post(
            f"/api/v1/scenes/{scene.slug}/calibrate", json=payload(scene), headers=headers
        ).status_code
        == 409
    )
