"""Real cookie/CSRF authorization and version pinning on isolated PostgreSQL."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update

from app.core.config import settings
from app.core.rate_limit import reset_rate_limits
from app.db.models.scene import SceneVersion
from app.db.models.scene_edit_session import SceneEditSession
from app.main import app
from tests.conftest_scenes import create_scene


@pytest.fixture()
def owner(db, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "dev_identity_enabled", False)
    monkeypatch.setattr(settings, "editor_enabled", True)
    receipt = tmp_path / "editor-build.json"
    receipt.write_text(json.dumps({
        "upstreamCommit": "f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b",
        "basePath": "/gaussian-editor/", "artifactSha256": "a" * 64,
    }))
    monkeypatch.setattr(settings, "editor_build_manifest", str(receipt))
    reset_rate_limits("register", "testclient")
    client = TestClient(app)
    result = client.post("/api/v1/auth/register", json={
        "email": f"edit-{uuid.uuid4().hex}@example.com",
        "password": "editor-test-password", "displayName": "Editor owner",
    })
    assert result.status_code == 200
    scene = create_scene(session=db, owner_id=uuid.UUID(result.json()["userId"]),
                         visibility="PRIVATE")
    version = scene.current_version
    db.execute(update(SceneVersion).where(SceneVersion.id == version.id).values(format="ply"))
    db.commit()
    scene.splat_count = 3
    db.commit()
    root = tmp_path / "storage"
    directory = root / "published" / str(scene.id) / "versions" / version.asset_version
    directory.mkdir(parents=True)
    (directory / "scene.ply").write_bytes(b"ply\nfixture-source\n")
    monkeypatch.setattr(settings, "storage_root", str(root))
    origin = tmp_path / "origin" / scene.slug / "versions"
    origin.mkdir(parents=True)
    (origin / version.asset_version).symlink_to(directory, target_is_directory=True)
    monkeypatch.setattr(settings, "scene_origin_root", str(tmp_path / "origin"))
    yield client, scene, {"X-CSRF-Token": client.cookies.get("gs_csrf")}
    client.close()


def create_edit(owner):
    client, scene, headers = owner
    response = client.post(f"/api/v1/scenes/{scene.slug}/edit-sessions", headers=headers,
                           json={"expectedCurrentVersion": str(scene.current_version_id)})
    assert response.status_code == 201, response.text
    return response.json()


def test_owner_create_private_source_range_and_cookie_no_token(owner):
    client, scene, _ = owner
    edit = create_edit(owner)
    assert edit["sceneId"] == str(scene.id)
    assert edit["sourceVersionId"] == str(scene.current_version_id)
    assert edit["sourceKind"] == "FULL_RESOLUTION_SOURCE"
    assert edit["editorUrl"].startswith("/gaussian-editor/?load=")
    assert all(secret not in edit["editorUrl"] for secret in client.cookies.values())
    response = client.get(edit["sourceUrl"], headers={"Range": "bytes=0-3"})
    assert response.status_code == 206
    assert response.content == b"ply\n"
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["content-type"] == "application/octet-stream"
    status = client.get(f"/api/v1/scenes/{scene.slug}/edit-sessions/{edit['id']}")
    assert status.json()["status"] == "OPENED"


def test_anonymous_share_token_and_csrf_cannot_create(owner):
    client, scene, _ = owner
    url = f"/api/v1/scenes/{scene.slug}/edit-sessions"
    payload = {"expectedCurrentVersion": str(scene.current_version_id)}
    assert client.post(url, json=payload).status_code == 403
    anonymous = TestClient(app)
    assert anonymous.post(url, json=payload).status_code == 401
    assert anonymous.post(url + "?share=read-only", json=payload).status_code == 401


def test_valid_share_grant_remains_read_only_for_editor(owner):
    client, scene, headers = owner
    edit = create_edit(owner)
    result = client.post(f"/api/v1/shares/scenes/{scene.slug}", headers=headers)
    assert result.status_code == 200, result.text
    token = result.json()["token"]
    anonymous = TestClient(app)
    assert anonymous.get(f"/api/v1/shares/resolve/{token}").status_code == 200
    assert anonymous.get(f"/api/v1/scenes/{scene.slug}/runtime").status_code == 200
    assert anonymous.get(edit["sourceUrl"]).status_code == 401
    assert anonymous.post(f"/api/v1/scenes/{scene.slug}/edit-sessions?share={token}",
                          json={"expectedCurrentVersion": str(scene.current_version_id)}
                          ).status_code == 401


@pytest.mark.parametrize("visibility", ["PUBLIC", "PRIVATE"])
def test_other_user_cannot_edit_or_download(owner, visibility, db):
    client, scene, _ = owner
    edit = create_edit(owner)
    scene.visibility = visibility
    db.commit()
    reset_rate_limits("register", "testclient")
    other = TestClient(app)
    result = other.post("/api/v1/auth/register", json={
        "email": f"other-{uuid.uuid4().hex}@example.com", "password": "editor-test-password",
        "displayName": "Other",
    })
    assert result.status_code == 200
    response = other.post(f"/api/v1/scenes/{scene.slug}/edit-sessions",
                          json={"expectedCurrentVersion": str(scene.current_version_id)},
                          headers={"X-CSRF-Token": other.cookies.get("gs_csrf")})
    assert response.status_code == 403
    assert other.get(edit["sourceUrl"]).status_code == 403
    assert TestClient(app).get(edit["sourceUrl"]).status_code == 401


def test_wrong_scene_version_traversal_and_untrusted_fields(owner):
    client, scene, headers = owner
    edit = create_edit(owner)
    source = edit["sourceUrl"]
    assert client.get(source.replace(scene.slug, "wrong-scene")).status_code == 404
    wrong_version = source.replace(edit["sourceAssetVersion"], "wrong-version")
    assert client.get(wrong_version).status_code == 404
    for resource in ["%2e%2e%2Fscene.ply", "%252e%252e/scene.ply", "https://evil.example/a"]:
        assert client.get(source.rsplit("/", 1)[0] + "/" + resource).status_code == 404
    assert client.post(f"/api/v1/scenes/{scene.slug}/edit-sessions", headers=headers,
                       json={"expectedCurrentVersion": str(scene.current_version_id),
                             "editorUrl": "https://evil.example"}).status_code == 422


@pytest.mark.parametrize("terminal", ["EXPIRED", "CANCELLED"])
def test_expired_cancelled_session_cannot_read(owner, db, terminal):
    client, scene, headers = owner
    edit = create_edit(owner)
    if terminal == "CANCELLED":
        url = f"/api/v1/scenes/{scene.slug}/edit-sessions/{edit['id']}/cancel"
        assert client.post(url, headers=headers).status_code == 200
        assert client.post(url, headers=headers).status_code == 200
    else:
        row = db.get(SceneEditSession, uuid.UUID(edit["id"]))
        row.created_at = datetime.now(UTC) - timedelta(hours=5)
        row.expires_at = datetime.now(UTC) - timedelta(hours=1)
        db.commit()
    assert client.get(edit["sourceUrl"]).status_code == 409
    status = client.get(f"/api/v1/scenes/{scene.slug}/edit-sessions/{edit['id']}")
    assert status.json()["status"] == terminal


def test_source_pinning_when_current_changes(owner, db):
    client, scene, headers = owner
    edit = create_edit(owner)
    replacement = SceneVersion(scene_id=scene.id, asset_version="replacement01", format="ply",
                               size_bytes=1, manifest={})
    db.add(replacement)
    db.flush()
    scene.current_version_id = replacement.id
    db.commit()
    assert client.get(edit["sourceUrl"]).status_code == 200
    response = client.post(f"/api/v1/scenes/{scene.slug}/edit-sessions", headers=headers,
                           json={"expectedCurrentVersion": edit["sourceVersionId"]})
    assert response.status_code == 409
    assert response.json()["code"] == "EDIT_BASE_VERSION_CHANGED"


def test_changed_editor_build_cannot_silently_resume_old_session(owner):
    from pathlib import Path

    client, _, _ = owner
    edit = create_edit(owner)
    receipt = Path(settings.editor_build_manifest)
    data = json.loads(receipt.read_text())
    data["artifactSha256"] = "b" * 64
    receipt.write_text(json.dumps(data))
    assert client.get(edit["sourceUrl"]).status_code == 409


def test_streamed_lod_disclosure_and_memory_admission(owner, db):
    client, scene, headers = owner
    version = scene.current_version
    db.execute(update(SceneVersion).where(SceneVersion.id == version.id).values(
        format="streamed-sog", manifest={"stream": {"counts": [13_090_324, 3_927_097, 1_309_032]}}
    ))
    db.commit()
    url = f"/api/v1/scenes/{scene.slug}/edit-sessions"
    payload = {"expectedCurrentVersion": str(version.id)}
    assert client.post(url, json=payload, headers=headers).status_code == 409
    for lod, memory in [(0, True), (2, False), (10, True)]:
        response = client.post(url, headers=headers, json={**payload, "selectedLod": lod,
                              "acknowledgeLodSource": True, "acknowledgeBrowserMemory": memory})
        assert response.status_code == 409
