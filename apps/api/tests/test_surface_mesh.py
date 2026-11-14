"""Real session/CSRF tests for scale, geometry provenance and private mesh jobs."""

import json
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.db.models.job import Job
from app.db.models.scene import SceneVersion
from app.db.models.scene_processing import SceneProcessingSettings
from app.main import app
from tests import test_editor_sessions

owner = test_editor_sessions.owner


@pytest.fixture
def mesh_source(owner, db, monkeypatch):
    client, scene, headers = owner
    original = scene.current_version_id
    calibrated = SceneVersion(
        scene_id=scene.id, asset_version=uuid.uuid4().hex, format="ply", size_bytes=50
    )
    db.add(calibrated)
    db.flush()
    scene.current_version_id = calibrated.id
    db.add(
        SceneProcessingSettings(
            scene_id=scene.id,
            calibration_evidence={
                "geometryScaleAppliedBy": "OFFICIAL_SPLAT_TRANSFORM",
                "scaleFactor": 0.08,
                "sourceVersionId": str(original),
                "resultVersionId": str(calibrated.id),
            },
        )
    )
    reconstruction = Job(
        scene_id=scene.id,
        owner_id=scene.owner_id,
        kind="RECONSTRUCT",
        status="SUCCEEDED",
        progress=100,
        attempt=1,
        task_parameters={"resultVersionId": str(original), "algorithm": "gsplat"},
    )
    db.add(reconstruction)
    db.commit()
    source = Path(settings.storage_root) / "jobs" / str(reconstruction.id) / "attempt-1/gsplat"
    source.mkdir(parents=True)
    (source / "final.ply").write_text("ply\nsource\n")
    monkeypatch.setattr(
        "workers.meshing.runtime.mesh_runtime",
        lambda _: (Path("/usr/bin/python"), source / "unused"),
    )
    return client, scene, headers, reconstruction


def post_mesh(fixture):
    client, scene, headers, _ = fixture
    return client.post(
        f"/api/v1/scenes/{scene.slug}/mesh",
        headers=headers,
        json={"expectedCurrentVersion": str(scene.current_version_id)},
    )


@pytest.mark.parametrize("algorithm,mesher", [("gsplat", "nksr"), ("2dgs", "2dgs-tsdf")])
def test_routes_default_mesher_and_persists_scale_idempotently(
    mesh_source, db, monkeypatch, algorithm, mesher
):
    client, scene, _, reconstruction = mesh_source
    reconstruction.task_parameters = {**reconstruction.task_parameters, "algorithm": algorithm}
    db.commit()
    calls = []
    monkeypatch.setattr(
        "app.services.celery_client.send_task", lambda *args, **kw: calls.append((args, kw))
    )
    first, second = post_mesh(mesh_source), post_mesh(mesh_source)
    assert first.status_code == second.status_code == 202, first.text
    data = first.json()
    assert data["algorithm"] == mesher
    assert data["job"]["id"] == second.json()["job"]["id"]
    assert len(calls) == 1 and calls[0][0] == ("tasks.build_mesh",)
    db.expire_all()
    job = db.get(Job, data["job"]["id"])
    assert job.task_parameters["scaleFactor"] == 0.08
    assert job.task_parameters["reconstructionJobId"] == str(reconstruction.id)
    assert job.task_parameters["sourceVersionId"] == str(scene.current_version_id)
    assert "storage" not in json.dumps(data)


def test_calibration_is_required_before_mesh(owner):
    client, scene, headers = owner
    state = client.get(f"/api/v1/scenes/{scene.slug}/mesh")
    assert state.status_code == 200
    assert state.json()["available"] is False
    assert "先完成尺度标定" in state.json()["reason"]
    assert (
        client.post(
            f"/api/v1/scenes/{scene.slug}/mesh",
            headers=headers,
            json={"expectedCurrentVersion": str(scene.current_version_id)},
        ).status_code
        == 409
    )


def test_requires_owner_csrf_and_exact_version(mesh_source):
    client, scene, _, _ = mesh_source
    url = f"/api/v1/scenes/{scene.slug}/mesh"
    assert TestClient(app).get(url).status_code == 401
    assert (
        client.post(url, json={"expectedCurrentVersion": str(scene.current_version_id)}).status_code
        == 403
    )
    assert (
        client.post(
            url, json={"expectedCurrentVersion": str(uuid.uuid4())}, headers=mesh_source[2]
        ).status_code
        == 409
    )
    assert (
        client.post(
            url,
            json={"expectedCurrentVersion": str(scene.current_version_id), "source": "/untrusted"},
            headers=mesh_source[2],
        ).status_code
        == 422
    )


def test_imported_gaussian_does_not_borrow_other_reconstruction(mesh_source, db):
    client, scene, _, reconstruction = mesh_source
    reconstruction.task_parameters = {
        **reconstruction.task_parameters,
        "resultVersionId": str(uuid.uuid4()),
    }
    db.commit()
    assert client.get(f"/api/v1/scenes/{scene.slug}/mesh").json()["available"] is False
    assert post_mesh(mesh_source).status_code == 409


def test_dispatch_failure_is_retryable(mesh_source, monkeypatch):
    def broken(*args, **kw):
        raise RuntimeError("broker secret")

    monkeypatch.setattr("app.services.celery_client.send_task", broken)
    result = post_mesh(mesh_source)
    assert result.status_code == 503 and "secret" not in result.text
    monkeypatch.setattr("app.services.celery_client.send_task", lambda *args, **kw: None)
    assert post_mesh(mesh_source).status_code == 202


def test_cancelled_queued_task_never_runs_subprocess(mesh_source, monkeypatch, db):
    from workers.meshing.job import run_mesh_job

    from app.db.session import SessionLocal

    monkeypatch.setattr("app.services.celery_client.send_task", lambda *args, **kw: None)
    job = post_mesh(mesh_source).json()["job"]
    client, scene, headers, _ = mesh_source
    assert (
        client.post(
            f"/api/v1/scenes/{scene.slug}/mesh/{job['id']}/cancel", headers=headers
        ).status_code
        == 200
    )
    monkeypatch.setattr(
        "workers.meshing.job.CommandRunner.run", lambda *args: pytest.fail("cancelled task ran")
    )
    run_mesh_job(job["id"], SessionLocal, settings)
    db.expire_all()
    assert db.get(Job, job["id"]).status == "CANCELLED"


def test_completed_mesh_download_private_and_stale_geometry_blocked(mesh_source, monkeypatch, db):
    monkeypatch.setattr("app.services.celery_client.send_task", lambda *args, **kw: None)
    job_id = post_mesh(mesh_source).json()["job"]["id"]
    client, scene, _, _ = mesh_source
    job = db.get(Job, job_id)
    job.status = "SUCCEEDED"
    job.task_parameters = {
        **job.task_parameters,
        "result": {"vertices": 3, "faces": 1, "units": "m"},
    }
    db.commit()
    path = Path(settings.storage_root) / "meshes" / str(scene.id) / job_id / "mesh.ply"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"ply\nmetric mesh\n")
    url = f"/api/v1/scenes/{scene.slug}/mesh/{job_id}/download"
    result = client.get(url)
    assert result.status_code == 200 and result.content == path.read_bytes()
    assert result.headers["cache-control"] == "private, no-store"
    assert TestClient(app).get(url).status_code == 401
    state = client.get(f"/api/v1/scenes/{scene.slug}/mesh").json()
    assert state["job"]["result"]["downloadUrl"] == url
    # Viewpoint edits don't change the geometry version and preserve downloads.
    scene.title = "renamed work"
    db.commit()
    assert client.get(url).status_code == 200
    evidence = db.get(SceneProcessingSettings, scene.id).calibration_evidence
    scene.current_version_id = uuid.UUID(evidence["sourceVersionId"])
    db.commit()
    assert client.get(url).status_code == 409


def test_fenced_worker_applies_durable_input_and_cannot_run_twice(mesh_source, monkeypatch, db):
    from workers.meshing.job import run_mesh_job
    from workers.reconstruction.command_runner import RunResult

    from app.db.session import SessionLocal

    monkeypatch.setattr("app.services.celery_client.send_task", lambda *args, **kw: None)
    monkeypatch.setattr(
        "workers.meshing.job.mesh_runtime",
        lambda _: (Path("/usr/bin/python"), Path(settings.storage_root) / "unused"),
    )
    job_id = post_mesh(mesh_source).json()["job"]["id"]
    calls = []

    def run(runner, command):
        calls.append(command)
        assert not runner._is_cancelled()
        runner._on_progress("MESHPROGRESS RENDERING 45")
        if "workers.meshing.extract" in command:
            assert command[-1] == "0.08"
            output = Path(command[command.index("--output") + 1])
            (output / "mesh.ply").write_text("ply\nmesh\n")
            (output / "result.json").write_text(
                json.dumps({"vertices": 3, "faces": 1, "units": "m", "scaleFactor": 0.08})
            )
        return RunResult(command=command, returncode=0)

    monkeypatch.setattr("workers.meshing.job.CommandRunner.run", run)
    run_mesh_job(job_id, SessionLocal, settings)
    run_mesh_job(job_id, SessionLocal, settings)
    db.expire_all()
    job = db.get(Job, job_id)
    assert job.status == "SUCCEEDED" and job.progress == 100
    assert job.task_parameters["result"]["scaleFactor"] == 0.08
    assert job.execution_generation == 1 and len(calls) == 2


def test_another_account_cannot_read_state_or_download(mesh_source):
    from app.core.rate_limit import reset_rate_limits

    _, scene, _, _ = mesh_source
    other = TestClient(app)
    reset_rate_limits("register", "testclient")
    response = other.post(
        "/api/v1/auth/register",
        json={
            "email": f"mesh-other-{uuid.uuid4().hex}@example.com",
            "password": "mesh-other-password",
            "displayName": "Other",
        },
    )
    assert response.status_code == 200
    url = f"/api/v1/scenes/{scene.slug}/mesh"
    assert other.get(url).status_code == 403
    assert other.get(f"{url}/{uuid.uuid4()}/download").status_code == 403
    other.close()


def test_api_producer_delivers_mesh_to_the_gpu_queue(monkeypatch):
    from celery import Celery

    from app.services import celery_client

    monkeypatch.setattr(celery_client, "_broker", None)
    monkeypatch.setattr(settings, "celery_broker_url", "memory://")
    monkeypatch.setattr(settings, "celery_result_backend", "cache+memory://")
    identifier = str(uuid.uuid4())
    celery_client.send_task("tasks.build_mesh", args=[identifier])
    reader = Celery("mesh-queue-verification", broker="memory://")
    with reader.connection_for_read() as connection:
        with connection.SimpleQueue("gpu") as queue:
            message = queue.get(block=False)
            assert message.headers["task"] == "tasks.build_mesh"
            assert message.payload[0] == [identifier]
            message.ack()


@pytest.mark.parametrize("change", ["geometry", "cancel"])
def test_worker_cannot_publish_after_geometry_change_or_late_cancellation(
    mesh_source, monkeypatch, db, change
):
    from workers.meshing.job import run_mesh_job
    from workers.reconstruction.command_runner import RunResult

    from app.db.models.scene import Scene
    from app.db.session import SessionLocal

    monkeypatch.setattr("app.services.celery_client.send_task", lambda *args, **kw: None)
    monkeypatch.setattr(
        "workers.meshing.job.mesh_runtime",
        lambda _: (Path("/usr/bin/python"), Path(settings.storage_root)),
    )
    job_id = post_mesh(mesh_source).json()["job"]["id"]
    _, scene, _, _ = mesh_source

    def run(runner, command):
        if "workers.meshing.extract" in command:
            output = Path(command[command.index("--output") + 1])
            (output / "mesh.ply").write_text("ply\n")
            (output / "result.json").write_text("{}")
            with SessionLocal() as concurrent:
                if change == "geometry":
                    row = concurrent.get(Scene, scene.id)
                    evidence = concurrent.get(
                        SceneProcessingSettings, scene.id
                    ).calibration_evidence
                    row.current_version_id = uuid.UUID(evidence["sourceVersionId"])
                else:
                    concurrent.get(Job, job_id).status = "CANCELLED"
                concurrent.commit()
        return RunResult(command=command, returncode=0)

    monkeypatch.setattr("workers.meshing.job.CommandRunner.run", run)
    run_mesh_job(job_id, SessionLocal, settings)
    db.expire_all()
    job = db.get(Job, job_id)
    assert job.status == ("FAILED" if change == "geometry" else "CANCELLED")
    assert not (
        Path(settings.storage_root) / "meshes" / str(scene.id) / job_id / "mesh.ply"
    ).exists()
