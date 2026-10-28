"""GS-UI-01 — scene cards show the REAL original upload time and file format.

The catalogue must derive ``uploadedAt`` / ``originalFormat`` from the
``UploadSession`` that produced the scene (earliest session wins), never from
``Scene.updated_at`` / ``published_at`` / the converted SceneVersion format.
Scenes with no recorded upload session must expose null so the UI hides the
metadata instead of inventing it.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _add_upload_session(
    db,
    *,
    owner_id: uuid.UUID,
    scene_id: uuid.UUID,
    fmt: str,
    created_at: datetime,
) -> None:
    from app.db.models.upload_session import UploadSession

    session = UploadSession(
        owner_id=owner_id,
        scene_id=scene_id,
        status="SUCCEEDED",
        storage_key=f"uploads/{uuid.uuid4().hex}.{fmt}",
        mime_type="application/octet-stream",
        upload_format=fmt,
        total_size=1024,
        expires_at=datetime.now(UTC) + timedelta(hours=1),
        title="上传原始作品",
        description=None,
        visibility="PUBLIC",
        category="experiment",
    )
    session.created_at = created_at
    db.add(session)
    db.commit()


def _list_item(slug: str) -> dict:
    resp = client.get("/api/v1/scenes", params={"limit": 100})
    assert resp.status_code == 200, resp.text
    items = resp.json()["items"]
    return next(item for item in items if item["id"] == slug)


def _publish_now(db, scene) -> None:
    """Pin the catalogue order so the scene is inside the first list page."""
    scene.published_at = datetime.now(UTC)
    db.commit()


def test_list_exposes_upload_time_and_original_format(public_scene, db):
    uploaded = datetime(2026, 3, 4, 5, 6, tzinfo=UTC)
    _publish_now(db, public_scene)
    _add_upload_session(
        db,
        owner_id=public_scene.owner_id,
        scene_id=public_scene.id,
        fmt="ply",
        created_at=uploaded,
    )

    item = _list_item(public_scene.slug)
    assert item["originalFormat"] == "ply"
    assert item["uploadedAt"].startswith("2026-03-04T05:06")
    # Provenance is the upload, never the (mutable) catalogue timestamps.
    assert item["uploadedAt"] != item["publishedAt"]


def test_detail_exposes_same_provenance(public_scene, db):
    _add_upload_session(
        db,
        owner_id=public_scene.owner_id,
        scene_id=public_scene.id,
        fmt="zip",
        created_at=datetime(2026, 1, 2, 3, 4, tzinfo=UTC),
    )
    detail = client.get(f"/api/v1/scenes/{public_scene.slug}")
    assert detail.status_code == 200
    body = detail.json()
    assert body["originalFormat"] == "zip"
    assert body["uploadedAt"].startswith("2026-01-02T03:04")


def test_earliest_upload_wins_over_republish(public_scene, db):
    _publish_now(db, public_scene)
    _add_upload_session(
        db,
        owner_id=public_scene.owner_id,
        scene_id=public_scene.id,
        fmt="ply",
        created_at=datetime(2025, 1, 1, tzinfo=UTC),
    )
    _add_upload_session(
        db,
        owner_id=public_scene.owner_id,
        scene_id=public_scene.id,
        fmt="zip",
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
    )

    item = _list_item(public_scene.slug)
    # The original bytes are the PLY; the later ZIP edit export must not win.
    assert item["originalFormat"] == "ply"
    assert item["uploadedAt"].startswith("2025-01-01")


def test_scene_without_upload_session_is_null_not_guessed(public_scene, db):
    _publish_now(db, public_scene)
    item = _list_item(public_scene.slug)
    assert item["originalFormat"] is None
    assert item["uploadedAt"] is None
