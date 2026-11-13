# ruff: noqa: F811
"""Reconstruction persistence and calibration may never grant verified scale."""

from __future__ import annotations

import uuid

import pytest
from pydantic import ValidationError

from app.db.models.scene import SceneVersion
from app.db.models.scene_edit_session import SceneEditSession
from app.db.models.scene_processing import SceneProcessingSettings
from app.schemas.compute import CreateReconstructionRequest
from tests.test_editor_sessions import create_edit, owner  # noqa: F401


def test_legacy_and_prompt_contract():
    base = dict(uploadIds=[uuid.uuid4()], sceneTitle="plant")
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


def test_reconstruction_persists_prompt_and_reuses_pending_submission(owner, db, monkeypatch):
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


def test_first_reconstruction_scene_creation_is_atomic(owner):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from types import SimpleNamespace

    from app.core.config import settings
    from app.core.identity import RequestIdentity
    from app.db.session import SessionLocal
    from app.services.reconstruction_service import ReconstructionService

    _, scene, _ = owner
    upload_id = uuid.uuid4()
    request = CreateReconstructionRequest(uploadIds=[upload_id], sceneTitle="Concurrent plant")
    identity = RequestIdentity(
        user_id=scene.owner_id, email="test@example.com", display_name="Test"
    )
    barrier = Barrier(2)

    def create():
        with SessionLocal() as session:
            service = ReconstructionService(session, settings)
            barrier.wait(timeout=10)
            result = service._find_or_create_draft_scene(
                request, identity, [SimpleNamespace(id=upload_id)]
            )
            session.commit()
            return result.id

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(create) for _ in range(2)]
        assert futures[0].result(timeout=20) == futures[1].result(timeout=20)
