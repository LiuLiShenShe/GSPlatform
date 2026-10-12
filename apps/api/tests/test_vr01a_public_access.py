from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.core.config import Settings, settings
from app.core.rate_limit import reset_rate_limits
from app.db.models.upload_session import UploadSession
from app.main import app
from app.schemas.compute import CreateReconstructionRequest
from app.schemas.uploads import CreateUploadRequest
from tests.conftest_scenes import create_scene


def _upload_body(purpose="PUBLISH"):
    return {
        "filename": "vr01a.sog" if purpose == "PUBLISH" else "vr01a.mp4",
        "mime_type": "application/octet-stream" if purpose == "PUBLISH" else "video/mp4",
        "format": "sog" if purpose == "PUBLISH" else "mp4",
        "size": 64,
        "title": "VR-01A visibility regression",
        "purpose": purpose,
    }


@pytest.mark.parametrize("default", ["PRIVATE", "PUBLIC", "UNLISTED"])
@pytest.mark.parametrize("explicit", [None, "PRIVATE", "PUBLIC", "UNLISTED"])
def test_upload_and_reconstruction_share_configured_default(monkeypatch, default, explicit):
    monkeypatch.setattr(settings, "default_upload_visibility", default)
    upload = _upload_body()
    reconstruction = {"uploadIds": [uuid.uuid4()], "sceneTitle": "VR-01A"}
    if explicit is not None:
        upload["visibility"] = explicit
        reconstruction["visibility"] = explicit
    expected = default if explicit is None else explicit
    assert CreateUploadRequest(**upload).visibility == expected
    assert CreateReconstructionRequest(**reconstruction).visibility == expected


def test_unconfigured_environment_keeps_safe_private_default(monkeypatch):
    monkeypatch.delenv("GS_DEFAULT_UPLOAD_VISIBILITY", raising=False)
    assert Settings(_env_file=None).default_upload_visibility == "PRIVATE"


def test_invalid_environment_visibility_is_rejected(monkeypatch):
    monkeypatch.setenv("GS_DEFAULT_UPLOAD_VISIBILITY", "EVERYONE")
    with pytest.raises(ValidationError):
        Settings(_env_file=None)


@pytest.mark.parametrize("visibility", [None, "EVERYONE", "public"])
def test_invalid_client_visibility_is_rejected(visibility):
    with pytest.raises(ValidationError):
        CreateUploadRequest(**_upload_body(), visibility=visibility)
    with pytest.raises(ValidationError):
        CreateReconstructionRequest(
            uploadIds=[uuid.uuid4()], sceneTitle="VR-01A", visibility=visibility,
        )


@pytest.fixture
def real_clients(monkeypatch):
    monkeypatch.setattr(settings, "dev_identity_enabled", False)
    monkeypatch.setattr(settings, "session_secure_cookie", False)
    reset_rate_limits("register", "testclient")
    with TestClient(app) as owner, TestClient(app) as other, TestClient(app) as anonymous:
        identities = []
        for client in [owner, other]:
            response = client.post("/api/v1/auth/register", json={
                "email": f"vr01a-{uuid.uuid4().hex}@example.invalid",
                "password": "vr01a-regression-password",
                "displayName": "VR-01A regression",
            })
            assert response.status_code == 200
            identities.append(uuid.UUID(response.json()["userId"]))
        yield owner, other, anonymous, identities[0]
    reset_rate_limits("register", "testclient")


@pytest.mark.parametrize("purpose", ["PUBLISH", "RECONSTRUCT"])
@pytest.mark.parametrize("default,explicit,expected", [
    ("PUBLIC", None, "PUBLIC"),
    ("PRIVATE", None, "PRIVATE"),
    ("PUBLIC", "PRIVATE", "PRIVATE"),
    ("PRIVATE", "PUBLIC", "PUBLIC"),
    ("PUBLIC", "UNLISTED", "UNLISTED"),
])
def test_upload_session_persists_visibility(
    monkeypatch, db, real_clients, purpose, default, explicit, expected,
):
    monkeypatch.setattr(settings, "default_upload_visibility", default)
    owner, _, _, _ = real_clients
    body = _upload_body(purpose)
    if explicit is not None:
        body["visibility"] = explicit
    response = owner.post("/api/v1/uploads", json=body, headers={
        "X-CSRF-Token": owner.cookies["gs_csrf"],
    })
    assert response.status_code == 201
    upload = db.get(UploadSession, uuid.UUID(response.json()["uploadId"]))
    assert upload is not None
    assert upload.visibility == expected
    assert upload.purpose == purpose


@pytest.mark.parametrize("visibility,status,actor,expected", [
    ("PUBLIC", "PUBLISHED", "anonymous", 200),
    ("PUBLIC", "PROCESSING", "anonymous", 401),
    ("PRIVATE", "PUBLISHED", "owner", 200),
    ("PRIVATE", "PUBLISHED", "anonymous", 401),
    ("PRIVATE", "PUBLISHED", "other", 403),
])
def test_real_session_scene_access_matrix(db, real_clients, visibility, status, actor, expected):
    owner, other, anonymous, owner_id = real_clients
    scene = create_scene(session=db, owner_id=owner_id, visibility=visibility, status=status)
    client = {"owner": owner, "other": other, "anonymous": anonymous}[actor]
    path = f"/api/v1/scenes/{scene.slug}"
    for suffix in ["", "/runtime"]:
        assert client.get(path + suffix).status_code == expected
    if expected != 200:
        assert client.get(path + "/assets/manifest.json").status_code == expected


def test_deleted_scene_is_404_for_every_actor(db, real_clients):
    owner, other, anonymous, owner_id = real_clients
    scene = create_scene(session=db, owner_id=owner_id)
    scene.deleted_at = datetime.now(UTC)
    db.commit()
    for client in [owner, other, anonymous]:
        for suffix in ["", "/runtime", "/assets/manifest.json"]:
            assert client.get(f"/api/v1/scenes/{scene.slug}" + suffix).status_code == 404


def test_upload_and_visibility_mutations_keep_auth_csrf_and_owner_checks(db, real_clients):
    owner, other, anonymous, owner_id = real_clients
    scene = create_scene(session=db, owner_id=owner_id, visibility="PRIVATE")
    path = f"/api/v1/scenes/{scene.slug}"
    assert anonymous.post("/api/v1/uploads", json=_upload_body()).status_code == 401
    assert owner.post("/api/v1/uploads", json=_upload_body()).status_code == 403
    assert anonymous.patch(path, json={"visibility": "PUBLIC"}).status_code == 401
    assert owner.patch(path, json={"visibility": "PUBLIC"}).status_code == 403
    assert other.patch(path, json={"visibility": "PUBLIC"}, headers={
        "X-CSRF-Token": other.cookies["gs_csrf"],
    }).status_code == 403
    db.refresh(scene)
    assert scene.visibility == "PRIVATE"


def test_owner_visibility_update_preserves_version_and_checks_concurrency(db, real_clients):
    owner, _, anonymous, owner_id = real_clients
    scene = create_scene(session=db, owner_id=owner_id, visibility="PRIVATE")
    version_id = scene.current_version_id
    path = f"/api/v1/scenes/{scene.slug}"
    seen = owner.get(path).json()["updatedAt"]
    headers = {"X-CSRF-Token": owner.cookies["gs_csrf"]}
    response = owner.patch(path, json={"visibility": "PUBLIC", "expectedUpdatedAt": seen},
                           headers=headers)
    assert response.status_code == 200
    assert owner.patch(path, json={"visibility": "PRIVATE", "expectedUpdatedAt": seen},
                       headers=headers).status_code == 409
    db.refresh(scene)
    assert scene.visibility == "PUBLIC"
    assert scene.status == "PUBLISHED"
    assert scene.current_version_id == version_id
    assert anonymous.get(path + "/runtime").status_code == 200


def test_private_share_grant_and_revocation_still_work(db, real_clients):
    owner, _, anonymous, owner_id = real_clients
    scene = create_scene(session=db, owner_id=owner_id, visibility="PRIVATE")
    headers = {"X-CSRF-Token": owner.cookies["gs_csrf"]}
    share_path = f"/api/v1/shares/scenes/{scene.slug}"
    assert owner.post(share_path).status_code == 403
    response = owner.post(share_path, headers=headers)
    assert response.status_code == 200
    share = response.json()
    runtime_path = f"/api/v1/scenes/{scene.slug}/runtime"
    assert anonymous.get(runtime_path).status_code == 401
    assert anonymous.get(runtime_path, params={"share": share["token"]}).status_code == 200
    resolved = anonymous.get(f"/api/v1/shares/resolve/{share['token']}").json()
    revoked = owner.delete(
        f"/api/v1/shares/{resolved['shareId']}/scenes/{scene.slug}", headers=headers,
    )
    assert revoked.status_code == 200
    anonymous.cookies.clear()
    assert anonymous.get(runtime_path, params={"share": share["token"]}).status_code == 401
