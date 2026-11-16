"""Session authorization and CPU conversion lifecycle on isolated database."""

import json
from pathlib import Path
import uuid
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from app.core.config import settings
from app.core.rate_limit import reset_rate_limits
from app.db.models.mesh_asset_variant import MeshAssetVariant
from app.db.models.mesh_model import MeshModel
from app.db.session import SessionLocal
from app.main import app
from tests import test_mesh_models as library
from workers.tests.test_standard_mesh_assets import make_mesh
from workers.meshing.standard_asset import digest

owner = library.owner
mesh_source = library.mesh_source


@pytest.fixture
def asset(mesh_source, db, monkeypatch, tmp_path):
    model, path = library.completed_model(mesh_source, db, monkeypatch)
    source, _, _ = make_mesh(tmp_path)
    path.write_bytes(source.read_bytes())
    model.sha256 = digest(path)
    model.size_bytes = path.stat().st_size
    model.vertices = 4
    model.faces = 4
    db.commit()
    calls = []
    monkeypatch.setattr(
        "app.services.celery_client.send_task", lambda *args, **kw: calls.append((args, kw))
    )
    return mesh_source[0], mesh_source[2], model, path, calls


def submit(asset, **overrides):
    client, headers, model, _, _ = asset
    return client.post(
        f"/api/v1/mesh-models/{model.id}/glb",
        headers=headers,
        json={
            "sourcePlySha256": model.sha256,
            "upAxis": "-Y",
            "confirmOrientation": True,
            **overrides,
        },
    )


def test_auth_csrf_units_and_rigid_confirmation(asset, db):
    client, headers, model, path, calls = asset
    endpoint = f"/api/v1/mesh-models/{model.id}"
    assert TestClient(app).get(endpoint + "/glb").status_code == 401
    assert client.post(endpoint + "/glb", json={}).status_code == 403
    assert submit(asset, confirmOrientation=False).status_code == 422
    assert submit(asset, upAxis="auto").status_code == 422
    assert submit(asset, scale=2).status_code == 422
    assert submit(asset, sourcePlySha256="0" * 64).status_code == 409
    model.units = "scene"
    db.commit()
    assert client.get(endpoint + "/glb").json()["eligible"] is False
    assert submit(asset).status_code == 409 and calls == []
    reset_rate_limits("register", "testclient")
    other = TestClient(app)
    assert (
        other.post(
            "/api/v1/auth/register",
            json={
                "email": f"{uuid.uuid4()}@example.com",
                "password": "asset-other-password",
                "displayName": "Other",
            },
        ).status_code
        == 200
    )
    assert other.get(endpoint + "/glb").status_code == 404
    assert other.get(endpoint + "/files/glb").status_code == 404
    assert (
        other.post(
            endpoint + "/glb",
            headers={"X-CSRF-Token": other.cookies.get("gs_csrf")},
            json={"sourcePlySha256": model.sha256, "upAxis": "-Y", "confirmOrientation": True},
        ).status_code
        == 404
    )


def test_cpu_worker_publishes_immutable_reusable_glb(asset, db):
    from workers.meshing.asset_job import run_asset_job

    client, _, model, path, calls = asset
    before = path.read_bytes()
    source_version = model.source_version_id
    first = submit(asset)
    second = submit(asset)
    assert first.status_code == second.status_code == 202
    identifier = first.json()["id"]
    assert second.json()["id"] == identifier and len(calls) == 1
    assert calls[0][0] == ("tasks.convert_mesh_asset",)
    run_asset_job(identifier, SessionLocal, settings)
    run_asset_job(identifier, SessionLocal, settings)
    db.expire_all()
    row = db.get(MeshAssetVariant, identifier)
    assert row.status == "READY", row.error_code
    assert row.generation == 1 and row.result["scaleApplied"] == 1
    assert row.result["validator"]["issues"]["numErrors"] == 0
    assert path.read_bytes() == before and model.source_version_id == source_version
    downloaded = client.get(
        f"/api/v1/mesh-models/{model.id}/files/glb", params={"variantId": identifier}
    )
    assert (
        downloaded.status_code == 200 and downloaded.headers["content-type"] == "model/gltf-binary"
    )
    assert downloaded.headers["cache-control"] == "private, no-store"
    assert len(downloaded.content) == row.size_bytes
    assert client.get(f"/api/v1/mesh-models/{model.id}/file").content == before
    assert submit(asset).json()["id"] == identifier and len(calls) == 1
    another = submit(asset, upAxis="+Z").json()
    assert another["id"] != identifier
    assert (
        client.get(
            f"/api/v1/mesh-models/{model.id}/files/glb", params={"variantId": identifier}
        ).content
        == downloaded.content
    )


def test_failure_retry_preserves_ply_and_ready_variants(asset, db, monkeypatch):
    from workers.meshing.asset_job import run_asset_job

    client, _, model, path, calls = asset
    identifier = submit(asset).json()["id"]
    before = path.read_bytes()
    path.write_bytes(before + b"corruption")
    run_asset_job(identifier, SessionLocal, settings)
    db.expire_all()
    assert db.get(MeshAssetVariant, identifier).status == "FAILED"
    assert client.get(f"/api/v1/mesh-models/{model.id}/files/glb").status_code == 404
    path.write_bytes(before)
    assert submit(asset).json()["id"] == identifier
    run_asset_job(identifier, SessionLocal, settings)
    db.expire_all()
    row = db.get(MeshAssetVariant, identifier)
    assert row.status == "READY" and row.generation == 2
    assert path.read_bytes() == before


def test_old_execution_cannot_publish(asset, db, monkeypatch):
    from workers.meshing.asset_job import run_asset_job
    from workers.reconstruction.command_runner import RunResult

    identifier = submit(asset).json()["id"]

    def obsolete(runner, command):
        output = Path(command[-1])
        output.write_bytes(b"not-a-glb")
        output.with_suffix(".result.json").write_text(
            json.dumps({"sha256": "0" * 64, "sizeBytes": 9})
        )
        with SessionLocal() as concurrent:
            row = concurrent.get(MeshAssetVariant, identifier)
            row.generation += 1
            concurrent.commit()
        return RunResult(command=command, returncode=0)

    monkeypatch.setattr("workers.meshing.asset_job.CommandRunner.run", obsolete)
    run_asset_job(identifier, SessionLocal, settings)
    db.expire_all()
    row = db.get(MeshAssetVariant, identifier)
    assert row.generation == 2 and row.status != "READY" and row.storage_key is None
