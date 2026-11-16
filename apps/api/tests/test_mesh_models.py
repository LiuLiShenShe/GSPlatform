"""Mesh library isolation, durable completion and saved-edit provenance."""

import json
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.config import settings
from app.core.rate_limit import reset_rate_limits
from app.db.models.job import Job
from app.db.models.mesh_model import MeshModel
from app.db.models.scene import SceneVersion
from app.db.models.scene_edit_session import SceneEditSession
from app.db.session import SessionLocal
from app.main import app
from app.services.mesh_models import register_mesh
from tests import test_surface_mesh

owner = test_surface_mesh.owner
mesh_source = test_surface_mesh.mesh_source
post_mesh = test_surface_mesh.post_mesh


def saved_edit(db, scene, *, status="COMPLETED", source=None):
    previous = scene.current_version_id
    version = SceneVersion(
        scene_id=scene.id, asset_version=uuid.uuid4().hex, format="ply", size_bytes=32
    )
    db.add(version)
    db.flush()
    db.add(
        SceneEditSession(
            scene_id=scene.id,
            owner_id=scene.owner_id,
            source_version_id=source or previous,
            source_asset_version="previous",
            source_kind="FULL_RESOLUTION_SOURCE",
            source_entry="scene.ply",
            source_counts=[3],
            editor_upstream_commit="a" * 40,
            editor_build_identity="b" * 64,
            status=status,
            result_version_id=version.id if status == "COMPLETED" else None,
            completed_at=datetime.now(UTC) if status == "COMPLETED" else None,
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
    )
    if status == "COMPLETED":
        scene.current_version_id = version.id
    db.commit()
    path = (
        Path(settings.storage_root)
        / "published"
        / str(scene.id)
        / "versions"
        / version.asset_version
        / "scene.ply"
    )
    path.parent.mkdir(parents=True)
    path.write_bytes(b"ply\nconfirmed edited geometry\n")
    return version, path


def completed_model(mesh_source, db, monkeypatch):
    monkeypatch.setattr("app.services.celery_client.send_task", lambda *a, **kw: None)
    job_id = post_mesh(mesh_source).json()["job"]["id"]
    job = db.get(Job, job_id)
    job.status = "SUCCEEDED"
    metadata = {"vertices": 3, "faces": 1, "units": "m"}
    job.task_parameters = {**job.task_parameters, "result": metadata}
    path = Path(settings.storage_root) / "meshes" / str(job.scene_id) / job_id / "mesh.ply"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"ply\ncompleted immutable mesh\n")
    model = register_mesh(db, settings, mesh_source[1], job, metadata)
    assert register_mesh(db, settings, mesh_source[1], job, metadata).id == model.id
    db.commit()
    return model, path


def test_library_auth_filters_and_history_remain_version_bound(mesh_source, db, monkeypatch):
    client, scene, _, _ = mesh_source
    model, path = completed_model(mesh_source, db, monkeypatch)
    endpoint = f"/api/v1/mesh-models/{model.id}"
    assert TestClient(app).get("/api/v1/mesh-models").status_code == 401
    assert TestClient(app).get(endpoint + "/file").status_code == 401
    result = client.get("/api/v1/mesh-models").json()
    assert result["total"] == 1
    item = result["items"][0]
    assert item["sourceVersionId"] == str(scene.current_version_id)
    assert item["isCurrentSource"] and item["units"] == "m"
    assert "storage" not in json.dumps(result) and "provenance" not in item
    assert client.get("/api/v1/mesh-models", params={"algorithm": "2dgs-tsdf"}).json()["total"] == 0
    assert client.get("/api/v1/mesh-models", params={"q": "nomatchingmesh"}).json()["total"] == 0
    assert client.get("/api/v1/mesh-models", params={"page": 0}).status_code == 422
    download = client.get(endpoint + "/file")
    assert download.content == path.read_bytes()
    assert download.headers["cache-control"] == "private, no-store"
    saved_edit(db, scene)
    item = client.get(endpoint).json()
    assert not item["isCurrentSource"] and item["sourceVersionId"] == str(model.source_version_id)
    assert client.get(endpoint + "/file").content == path.read_bytes()
    reset_rate_limits("register", "testclient")
    other = TestClient(app)
    assert (
        other.post(
            "/api/v1/auth/register",
            json={
                "email": f"mesh-{uuid.uuid4()}@example.com",
                "password": "independent-mesh-password",
                "displayName": "Other",
            },
        ).status_code
        == 200
    )
    assert other.get("/api/v1/mesh-models").json()["total"] == 0
    assert other.get(endpoint).status_code == other.get(endpoint + "/file").status_code == 404
    other.close()
    scene.deleted_at = datetime.now(UTC)
    db.commit()
    assert client.get("/api/v1/mesh-models").json()["total"] == 0
    assert client.get(endpoint + "/file").status_code == 404


@pytest.mark.parametrize("algorithm", ["gsplat", "2dgs"])
def test_saved_cleanup_chain_uses_current_geometry_and_registers_once(
    mesh_source, db, monkeypatch, algorithm
):
    from workers.meshing.job import run_mesh_job
    from workers.reconstruction.command_runner import RunResult

    client, scene, _, reconstruction = mesh_source
    reconstruction.task_parameters = {**reconstruction.task_parameters, "algorithm": algorithm}
    db.commit()
    saved_edit(db, scene)
    version, path = saved_edit(db, scene)  # Follow more than one saved cleanup.
    monkeypatch.setattr("app.services.celery_client.send_task", lambda *a, **kw: None)
    job_data = post_mesh(mesh_source).json()["job"]
    calls = []

    def run(runner, command):
        calls.append(command)
        assert not runner._is_cancelled()
        if "workers.meshing.confirmed_geometry" in command:
            assert Path(command[command.index("--input") + 1]) == path
            assert command[-1] == "0.08"
        else:
            assert "--gaussian-ply" in command
            if "workers.meshing.extract" in command:
                target = Path(command[command.index("--output") + 1])
                (target / "mesh.ply").write_bytes(b"ply\nnew cleaned mesh\n")
                (target / "result.json").write_text(
                    json.dumps({"vertices": 3, "faces": 1, "units": "m"})
                )
        return RunResult(command=command, returncode=0)

    monkeypatch.setattr("workers.meshing.job.CommandRunner.run", run)
    run_mesh_job(job_data["id"], SessionLocal, settings)
    run_mesh_job(job_data["id"], SessionLocal, settings)
    db.expire_all()
    job = db.get(Job, job_data["id"])
    assert job.status == "SUCCEEDED", job.error_message_safe
    assert len(calls) == (3 if algorithm == "gsplat" else 2)
    models = db.scalars(select(MeshModel).where(MeshModel.job_id == job.id)).all()
    assert len(models) == 1 and models[0].source_version_id == version.id
    assert models[0].provenance["editedGeometry"] is True
    data = client.get(f"/api/v1/scenes/{scene.slug}/mesh").json()
    assert data["job"]["result"]["previewUrl"] == f"/meshes/{models[0].id}"


@pytest.mark.parametrize("problem", ["unrelated", "pending"])
def test_unrelated_or_unfinished_cleanup_is_not_meshed(mesh_source, db, monkeypatch, problem):
    scene = mesh_source[1]
    if problem == "unrelated":
        # A valid version in this scene, but before its metric version.
        from app.db.models.scene_processing import SceneProcessingSettings

        original = db.get(SceneProcessingSettings, scene.id).calibration_evidence["sourceVersionId"]
        saved_edit(db, scene, source=uuid.UUID(original))
    else:
        saved_edit(db, scene, status="CONVERTING")
    calls = []
    monkeypatch.setattr("app.services.celery_client.send_task", lambda *a, **kw: calls.append(a))
    assert post_mesh(mesh_source).status_code == 409
    assert calls == []
