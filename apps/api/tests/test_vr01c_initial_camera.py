from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.core.config import settings
from app.core.rate_limit import reset_rate_limits
from app.db.models.scene import SceneVersion
from app.main import app
from tests.conftest_scenes import create_scene


def test_authored_camera_owner_csrf_runtime_and_immutable_version(db, monkeypatch):
    monkeypatch.setattr(settings, "dev_identity_enabled", False)
    reset_rate_limits("register", "testclient")
    with TestClient(app) as owner, TestClient(app) as other, TestClient(app) as anonymous:
        identities = []
        for client in [owner, other]:
            response = client.post("/api/v1/auth/register", json={
                "email": f"vr01c-{uuid.uuid4().hex}@example.invalid",
                "password": "vr01c-regression-password",
                "displayName": "VR-01C regression",
            })
            assert response.status_code == 200
            identities.append(uuid.UUID(response.json()["userId"]))
        scene = create_scene(session=db, owner_id=identities[0], visibility="PRIVATE")
        version = db.get(SceneVersion, scene.current_version_id)
        before = (version.id, version.asset_version, version.manifest, version.sha256)
        patch = {
            "initialCameraPosition": {"x": 12, "y": -34, "z": 56},
            "initialCameraTarget": {"x": 10, "y": -34, "z": 50},
            "initialCameraFov": 60,
            "worldPosition": {"x": 3, "y": 4, "z": 5},
            "worldRotation": {"x": 0, "y": 90, "z": 0},
            "worldScale": {"x": 2, "y": 2, "z": 2},
        }
        path = f"/api/v1/scenes/{scene.slug}"
        assert anonymous.patch(path + "/presentation", json=patch).status_code == 401
        assert owner.patch(path + "/presentation", json=patch).status_code == 403
        assert other.patch(path + "/presentation", json=patch, headers={
            "X-CSRF-Token": other.cookies["gs_csrf"],
        }).status_code == 403
        response = owner.patch(path + "/presentation", json=patch, headers={
            "X-CSRF-Token": owner.cookies["gs_csrf"],
        })
        assert response.status_code == 200
        runtime = owner.get(path + "/runtime").json()
        assert runtime["presentation"]["initialCamera"] == {
            "position": patch["initialCameraPosition"],
            "target": patch["initialCameraTarget"], "fov": 60,
        }
        assert runtime["presentation"]["worldTransform"]["position"] == patch["worldPosition"]
        assert anonymous.get(path + "/runtime?diagnostics=1").status_code == 401
        assert anonymous.get(path + "/assets/manifest.json?diagnostics=1").status_code == 401
        db.refresh(scene)
        db.refresh(version)
        assert scene.current_version_id == before[0]
        assert (version.id, version.asset_version, version.manifest, version.sha256) == before
    reset_rate_limits("register", "testclient")
