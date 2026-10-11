from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from app.api.v1.shares import create_share, revoke_share
from app.core.config import settings
from app.core.identity import RequestIdentity
from app.db.models.share_link import ShareLink
from app.db.session import SessionLocal
from app.main import app
from app.services.share_service import ShareService
from tests.conftest_scenes import create_scene


@pytest.mark.parametrize("jobs", [False, True])
def test_owner_reads_require_session_without_mutation_csrf(monkeypatch, jobs):
    monkeypatch.setattr(settings, "dev_identity_enabled", False)
    monkeypatch.setattr(settings, "session_secure_cookie", False)
    with TestClient(app) as client:
        assert client.get("/api/v1/me/scenes").status_code == 401
        registered = client.post("/api/v1/auth/register", json={
            "email": f"vr00-owner-read-{uuid.uuid4().hex}@example.com",
            "password": "vr00-regression-password",
            "displayName": "VR-00 owner reads",
        })
        assert registered.status_code == 200
        with SessionLocal() as database:
            scene = create_scene(
                session=database,
                owner_id=uuid.UUID(registered.json()["userId"]),
                visibility="PRIVATE",
            )
        path = f"/api/v1/me/scenes/{scene.slug}/jobs" if jobs else "/api/v1/me/scenes"
        response = client.get(path)
        assert response.status_code == 200
        if jobs:
            assert response.json() == []
        else:
            assert [item["id"] for item in response.json()["items"]] == [scene.slug]
        assert client.post(f"/api/v1/shares/scenes/{scene.slug}").status_code == 403


def test_share_is_persisted_before_returning_its_url(private_scene):
    identity = RequestIdentity(
        user_id=private_scene.owner_id,
        email="vr00-share-regression@example.com",
        display_name="VR-00 share regression",
    )
    request = Request({"type": "http", "headers": [], "client": ("127.0.0.1", 1)})
    with SessionLocal() as database:
        created = create_share(private_scene.slug, request, None, identity, database)
        assert created.token is not None
        with SessionLocal() as independent:
            resolved, _ = ShareService(independent).resolve_share(created.token)
            assert resolved.id == private_scene.slug


def test_share_revocation_is_persisted_before_success(private_scene):
    identity = RequestIdentity(
        user_id=private_scene.owner_id,
        email="vr00-share-regression@example.com",
        display_name="VR-00 share regression",
    )
    with SessionLocal() as database:
        service = ShareService(database)
        created = service.create_share(
            owner_id=identity.user_id, scene_slug=private_scene.slug,
        )
        database.commit()
        _, link = service.resolve_share(str(created["token"]))
        response = revoke_share(str(link.id), private_scene.slug, identity, database)
        assert response == {"revoked": True}
        with SessionLocal() as independent:
            persisted = independent.get(ShareLink, link.id)
            assert persisted is not None
            assert persisted.revoked_at is not None
