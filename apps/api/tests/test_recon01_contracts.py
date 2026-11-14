# ruff: noqa: F811
"""Reconstruction persistence and calibration may never grant verified scale."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from app.db.models.scene import SceneVersion
from app.db.models.scene_edit_session import SceneEditSession
from app.db.models.scene_processing import SceneProcessingSettings
from app.schemas.compute import CreateReconstructionRequest
from tests.test_editor_sessions import create_edit, owner  # noqa: F401


def test_legacy_and_prompt_contract():
    base = dict(uploadIds=[uuid.uuid4()], sceneTitle="plant")
    assert CreateReconstructionRequest(**base).algorithm == "gsplat"
    assert CreateReconstructionRequest(**base, algorithm="2dgs").algorithm == "2dgs"
    with pytest.raises(ValidationError):
        CreateReconstructionRequest(**base, algorithm="arbitrary-training-command")
    assert CreateReconstructionRequest(**base).segmentation.mode == "OFF"
    for settings in (
        {"mode": "KEEP_PROMPTED_OBJECT"},
        {"mode": "KEEP_PROMPTED_OBJECT", "prompt": "   "},
        {"mode": "OFF", "prompt": "plant"},
        {"mode": "KEEP_PROMPTED_OBJECT", "prompt": "plant", "checkpoint": "evil"},
    ):
        with pytest.raises(ValidationError):
            CreateReconstructionRequest(**base, segmentation=settings)
    valid = CreateReconstructionRequest(
        **base, segmentation={"mode": "KEEP_PROMPTED_OBJECT", "prompt": "  potted plant  "}
    )
    assert valid.segmentation.prompt == "potted plant"


def completed(owner, db):
    client, scene, headers = owner
    edit = create_edit(owner)
    source = scene.current_version_id
    result = SceneVersion(
        scene_id=scene.id,
        asset_version=uuid.uuid4().hex,
        format="ply",
        size_bytes=1000,
        manifest={"content": {"counts": [3]}},
    )
    db.add(result)
    db.flush()
    row = db.get(SceneEditSession, uuid.UUID(edit["id"]))
    row.status = "COMPLETED"
    row.result_version_id = result.id
    row.result_sha256 = "b" * 64
    scene.current_version_id = result.id
    db.commit()
    payload = {
        "sourceVersionId": str(source),
        "resultVersionId": str(result.id),
        "referenceName": "20 mm cube",
        "originalDistance": 2.0,
        "realLength": 20.0,
        "unit": "mm",
        "remeasuredDistance": 0.0201,
        "provenance": "Official Editor two surface clicks",
        "endpoints": [[0, 0, 0], [2, 0, 0]],
    }
    url = f"/api/v1/scenes/{scene.slug}/edit-sessions/{edit['id']}/calibration"
    return client, scene, headers, payload, url


def test_calibration_binds_export_and_remains_assumed(owner, db):
    client, scene, headers, payload, url = completed(owner, db)
    assert client.post(url, json=payload).status_code == 403
    assert (
        client.post(
            url, json={**payload, "calibrationState": "VERIFIED"}, headers=headers
        ).status_code
        == 422
    )
    response = client.post(url, json=payload, headers=headers)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["state"] == "ASSUMED"
    assert result["physicalWalkAllowed"] is False
    assert result["evidence"]["scaleFactor"] == 0.01
    assert result["evidence"]["absoluteErrorMeters"] == pytest.approx(0.0001)
    assert len(result["evidence"]["evidenceSha256"]) == 64
    db.expire_all()
    settings = db.get(SceneProcessingSettings, scene.id)
    assert settings.calibration_state == "ASSUMED"
    assert settings.calibration_source_version == scene.current_version.asset_version
    assert settings.meters_per_scene_unit == 1.0


def test_calibration_rejects_wrong_version_and_mismatched_endpoints(owner, db):
    client, scene, headers, payload, url = completed(owner, db)
    assert (
        client.post(
            url, json={**payload, "resultVersionId": str(uuid.uuid4())}, headers=headers
        ).status_code
        == 409
    )
    assert (
        client.post(
            url, json={**payload, "endpoints": [[0, 0, 0], [3, 0, 0]]}, headers=headers
        ).status_code
        == 409
    )
    scene.current_version_id = uuid.UUID(payload["sourceVersionId"])
    db.commit()
    assert client.post(url, json=payload, headers=headers).status_code == 409


@pytest.mark.parametrize("algorithm", ["gsplat", "2dgs"])
def test_reconstruction_persists_prompt_and_reuses_pending_submission(
    owner, db, monkeypatch, algorithm
):
    from io import BytesIO

    from PIL import Image

    from app.db.models.job import Job

    client, _, headers = owner
    calls = []
    monkeypatch.setattr(
        "app.api.v1.compute.send_task", lambda *args, **kwargs: calls.append((args, kwargs))
    )
    data = BytesIO()
    Image.new("RGB", (32, 32), "green").save(data, format="PNG")
    raw = data.getvalue()
    response = client.post(
        "/api/v1/uploads",
        headers=headers,
        json={
            "filename": "photo.png",
            "mime_type": "image/png",
            "size": len(raw),
            "format": "png",
            "title": "Prompt contract",
            "purpose": "RECONSTRUCT",
        },
    )
    assert response.status_code == 201, response.text
    uid = response.json()["uploadId"]
    assert (
        client.patch(
            f"/api/v1/uploads/{uid}", content=raw, headers={**headers, "Upload-Offset": "0"}
        ).status_code
        == 200
    )
    assert (
        client.post(f"/api/v1/uploads/{uid}/complete", headers=headers, json={}).status_code == 200
    )
    payload = {
        "uploadIds": [uid],
        "sceneTitle": "Plant",
        "algorithm": algorithm,
        "profile": "draft",
        "segmentation": {"mode": "KEEP_PROMPTED_OBJECT", "prompt": "potted plant; blue cube"},
    }
    first = client.post("/api/v1/compute/reconstruct", headers=headers, json=payload)
    assert first.status_code == 202, first.text
    second = client.post("/api/v1/compute/reconstruct", headers=headers, json=payload)
    assert second.status_code == 202, second.text
    assert first.json()["jobId"] == second.json()["jobId"]
    assert len(calls) == 1
    job = db.get(Job, uuid.UUID(first.json()["jobId"]))
    assert job.task_parameters["segmentation"] == payload["segmentation"]
    assert job.task_parameters["uploadIds"] == [uid]
    assert job.task_parameters["algorithm"] == algorithm
    detail = client.get(f"/api/v1/jobs/{job.id}", headers=headers)
    assert detail.status_code == 200, detail.text
    assert detail.json()["algorithm"] == algorithm
    # The same uploads with a different algorithm are a different GPU job.
    alternate = "2dgs" if algorithm == "gsplat" else "gsplat"
    different = client.post(
        "/api/v1/compute/reconstruct", headers=headers, json={**payload, "algorithm": alternate}
    )
    assert different.status_code == 202, different.text
    assert different.json()["jobId"] != str(job.id)
    assert different.json()["sceneId"] != first.json()["sceneId"]
    assert len(calls) == 2

    job.status = "SUCCEEDED"
    db.commit()
    rerun = client.post("/api/v1/compute/reconstruct", headers=headers, json=payload)
    assert rerun.status_code == 202, rerun.text
    assert rerun.json()["sceneId"] != first.json()["sceneId"]


@pytest.mark.parametrize("scale", [{"x": 2, "y": 2, "z": 2}, {"x": 2, "y": 3, "z": 4}])
@pytest.mark.parametrize("binding", ["sourceVersionId", "resultVersionId"])
def test_metric_calibration_cannot_reapply_an_existing_world_transform(owner, db, scale, binding):
    from app.db.models.scene_presentation import ScenePresentation
    from app.services.scene_processing import processing_for_scene, transform_identity
    from app.services.scene_runtime import SceneRuntimeService

    client, scene, headers, payload, url = completed(owner, db)
    presentation = ScenePresentation(
        scene_id=scene.id, world_scale=scale,
        world_position={"x": 3, "y": 4, "z": 5},
        world_rotation={"x": 0, "y": 30, "z": 0},
        world_transform_version_id=uuid.UUID(payload[binding]),
    )
    db.add(presentation)
    db.commit()
    response = client.post(url, json=payload, headers=headers)
    assert response.status_code == 200, response.text
    db.expire_all()
    assert transform_identity(db, scene) == "identity"
    evidence = response.json()["evidence"]
    assert evidence["previousWorldTransform"]["scale"] == scale
    assert evidence["transformIdentity"] == "identity"
    retry = client.post(url, json=payload, headers=headers)
    assert retry.status_code == 200, retry.text
    assert retry.json()["evidence"]["previousWorldTransform"] == evidence["previousWorldTransform"]
    runtime = SceneRuntimeService(db)._build_presentation(scene)
    assert runtime.worldTransform.scale is None or runtime.worldTransform.scale.model_dump() == {
        "x": 1, "y": 1, "z": 1,
    }
    # A metric edge in the exported asset must remain the same physical edge in Viewer.
    scale_x = runtime.worldTransform.scale.x if runtime.worldTransform.scale else 1
    assert 0.02 * scale_x == pytest.approx(0.02)
    processing = processing_for_scene(db, scene)
    assert processing.calibration.state == "ASSUMED"
    assert not processing.calibration.physicalWalkAllowed
    assert not processing.calibration.stale
    # Later presentation re-authoring cannot silently keep the old calibration valid.
    presentation = db.get(ScenePresentation, presentation.id)
    presentation.world_scale = {"x": 2, "y": 2, "z": 2}
    db.commit()
    assert processing_for_scene(db, scene).calibration.stale


def test_high_profile_accepts_800_upload_ids_but_standard_does_not():
    ids = [uuid.uuid4() for _ in range(801)]
    for name, count in (("draft", 80), ("standard", 300), ("high", 800)):
        base = {"uploadIds": ids[:count], "sceneTitle": "Limits", "profile": name}
        assert len(CreateReconstructionRequest(**base).uploadIds) == count
        with pytest.raises(ValidationError):
            CreateReconstructionRequest(**{**base, "uploadIds": ids[:count+1]})
    with pytest.raises(ValidationError, match="未知 profile"):
        CreateReconstructionRequest(uploadIds=ids[:1], sceneTitle="Invalid", profile="missing")


def test_first_presentation_creation_is_atomic(owner):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from app.db.session import SessionLocal
    from app.repositories.authoring import ScenePresentationRepository

    _, scene, _ = owner
    barrier = Barrier(2)

    def create():
        with SessionLocal() as session:
            repository = ScenePresentationRepository(session)
            barrier.wait(timeout=10)
            row = repository.get_by_scene_or_create(scene.id)
            session.commit()
            return row.id

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(create) for _ in range(2)]
        assert futures[0].result(timeout=20) == futures[1].result(timeout=20)


def media_upload(db, owner_id, *, size=100):
    from app.db.models.upload_session import UploadSession

    upload = UploadSession(
        owner_id=owner_id, status="UPLOADED", purpose="RECONSTRUCT",
        storage_key=f"test/{uuid.uuid4()}", mime_type="image/png", upload_format="png",
        total_size=size, offset=size, expires_at=datetime.now(UTC) + timedelta(days=1),
        title="Plant", visibility="PRIVATE", category="experiment",
    )
    db.add(upload)
    db.commit()
    return upload


@pytest.mark.parametrize("variant", ["same", "algorithm", "prompt", "uploads"])
def test_concurrent_reconstruction_submissions_are_deduped_by_request(owner, db, variant):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from app.core.config import settings
    from app.core.identity import RequestIdentity
    from app.db.session import SessionLocal
    from app.services.reconstruction_service import ReconstructionService

    _, scene, _ = owner
    upload = media_upload(db, scene.owner_id)
    first = CreateReconstructionRequest(uploadIds=[upload.id], sceneTitle="Concurrent plant")
    changes = {
        "same": {},
        "algorithm": {"algorithm": "2dgs"},
        "prompt": {"segmentation": {"mode": "KEEP_PROMPTED_OBJECT", "prompt": "plant; cube"}},
        "uploads": {"uploadIds": [media_upload(db, scene.owner_id).id]},
    }
    second = CreateReconstructionRequest(**{**first.model_dump(), **changes[variant]})
    identity = RequestIdentity(
        user_id=scene.owner_id, email="test@example.com", display_name="Test"
    )
    barrier = Barrier(2)
    dispatched = []

    def submit(request):
        with SessionLocal() as session:
            service = ReconstructionService(session, settings)
            barrier.wait(timeout=10)
            return service.submit_reconstruction(
                request, identity,
                send_task=lambda *args, **kwargs: dispatched.append(kwargs["args"]),
            )

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(submit, request) for request in (first, second)]
        left, right = [future.result(timeout=20) for future in futures]
    if variant == "same":
        assert left.jobId == right.jobId
        assert left.sceneId == right.sceneId
        assert len(dispatched) == 1
    else:
        assert left.jobId != right.jobId
        assert left.sceneId != right.sceneId
        assert len(dispatched) == 2


def test_reconstruction_rejects_profile_byte_overflow_before_allocating_a_run(
    owner, db, monkeypatch,
):
    from workers.reconstruction.profiles import load_profile

    client, scene, headers = owner
    size = int(load_profile("draft").input_limits()["max_bytes"]) + 1
    upload = media_upload(db, scene.owner_id, size=size)
    dispatched = []
    monkeypatch.setattr("app.api.v1.compute.send_task", lambda *a, **k: dispatched.append(k))
    response = client.post("/api/v1/compute/reconstruct", headers=headers, json={
        "uploadIds": [str(upload.id)], "sceneTitle": "Over limit", "profile": "draft",
    })
    assert response.status_code == 409, response.text
    assert not dispatched
