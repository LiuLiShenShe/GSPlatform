"""Tests for upload session API endpoints (Phase 06)."""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

# ─── helpers ────────────────────────────────────────────────────────────────
def _create_upload(**overrides) -> dict:
    payload = {
        "filename": "test.sog",
        "mime_type": "application/octet-stream",
        "size": 1024,
        "format": "sog",
        "title": "测试场景",
        "category": "experiment",
        "visibility": "PRIVATE",
    }
    payload.update(overrides)
    return payload


def _auth_headers() -> dict:
    # dev identity bypass injects the user automatically; headers are optional.
    return {}


# ─── create session ─────────────────────────────────────────────────────────
class TestCreateUpload:
    def test_returns_201_and_session(self):
        body = _create_upload()
        resp = client.post("/api/v1/uploads", json=body, headers=_auth_headers())
        assert resp.status_code == 201
        data = resp.json()
        assert "uploadId" in data
        assert data["status"] == "CREATED"
        assert data["totalSize"] == 1024
        assert data["chunkMaxBytes"] > 0

    def test_rejects_unsupported_format(self):
        body = _create_upload(format="xyz")
        resp = client.post("/api/v1/uploads", json=body)
        # expects 409 (ConflictError)
        assert resp.status_code == 409

    def test_rejects_oversized(self):
        body = _create_upload(size=10 * 1024 * 1024 * 1024)  # 10 GB
        resp = client.post("/api/v1/uploads", json=body)
        assert resp.status_code == 409

    def test_missing_title_rejected(self):
        body = _create_upload()
        del body["title"]
        resp = client.post("/api/v1/uploads", json=body)
        assert resp.status_code == 422


# ─── head / query status ────────────────────────────────────────────────────
class TestHeadUpload:
    def test_returns_offset_headers(self):
        body = _create_upload(size=2048)
        create_resp = client.post("/api/v1/uploads", json=body)
        uid = create_resp.json()["uploadId"]
        resp = client.head(f"/api/v1/uploads/{uid}", headers=_auth_headers())
        assert resp.status_code == 200
        assert int(resp.headers["Upload-Length"]) == 2048
        assert int(resp.headers["Upload-Offset"]) == 0

    def test_nonexistent_returns_404(self):
        fake_id = str(uuid.uuid4())
        resp = client.head(f"/api/v1/uploads/{fake_id}", headers=_auth_headers())
        assert resp.status_code == 404


# ─── patch / chunk upload ───────────────────────────────────────────────────
class TestPatchUpload:
    def test_chunk_advances_offset(self):
        body = _create_upload(size=1024)
        create_resp = client.post("/api/v1/uploads", json=body)
        uid = create_resp.json()["uploadId"]
        chunk = b"\x00" * 512
        resp = client.patch(
            f"/api/v1/uploads/{uid}",
            content=chunk,
            headers={"Upload-Offset": "0", "Content-Type": "application/octet-stream"},
        )
        assert resp.status_code == 200
        assert resp.json()["offset"] == 512

    def test_mismatched_offset_returns_409(self):
        body = _create_upload(size=1024)
        create_resp = client.post("/api/v1/uploads", json=body)
        uid = create_resp.json()["uploadId"]
        chunk = b"\x00" * 128
        resp = client.patch(
            f"/api/v1/uploads/{uid}",
            content=chunk,
            headers={"Upload-Offset": "100", "Content-Type": "application/octet-stream"},
        )
        assert resp.status_code == 409

    def test_exact_complete_sets_uploaded_status(self):
        body = _create_upload(size=256)
        create_resp = client.post("/api/v1/uploads", json=body)
        uid = create_resp.json()["uploadId"]
        chunk = b"\x00" * 256
        resp = client.patch(
            f"/api/v1/uploads/{uid}",
            content=chunk,
            headers={"Upload-Offset": "0", "Content-Type": "application/octet-stream"},
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "UPLOADED"


# ─── complete ────────────────────────────────────────────────────────────────
class TestCompleteUpload:
    def test_complete_succeeds_and_creates_job(self, monkeypatch):
        """complete should create a Job + enqueue when the upload is full."""
        # Replace the celery dispatcher with a spy so the test doesn't depend
        # on a live broker (and can assert the task is dispatched by name).

        sent: list[dict] = []
        def _spy(name: str, args=None) -> MagicMock:
            sent.append({"name": name, "args": args})
            return MagicMock()
        # The v1/uploads module imported send_task at load time; patch there.
        monkeypatch.setattr("app.api.v1.uploads.send_task", _spy)

        body = _create_upload(size=100)
        create_resp = client.post("/api/v1/uploads", json=body)
        uid = create_resp.json()["uploadId"]
        client.patch(
            f"/api/v1/uploads/{uid}",
            content=b"\x00" * 100,
            headers={"Upload-Offset": "0", "Content-Type": "application/octet-stream"},
        )
        resp = client.post(
            f"/api/v1/uploads/{uid}/complete",
            json={"expected_size": 100},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "QUEUED"
        assert data["jobId"] is not None
        # the publish task must be dispatched with upload/scene/job ids
        assert len(sent) == 1
        assert sent[0]["name"] == "tasks.publish_scene"
        assert len(sent[0]["args"]) == 3

    def test_size_mismatch_returns_409(self):
        body = _create_upload(size=512)
        create_resp = client.post("/api/v1/uploads", json=body)
        uid = create_resp.json()["uploadId"]
        client.patch(
            f"/api/v1/uploads/{uid}",
            content=b"\x00" * 256,
            headers={"Upload-Offset": "0", "Content-Type": "application/octet-stream"},
        )
        resp = client.post(
            f"/api/v1/uploads/{uid}/complete",
            json={"expected_size": 512},
        )
        assert resp.status_code == 409


# ─── cancel ──────────────────────────────────────────────────────────────────
class TestCancelUpload:
    def test_cancel_returns_cancelled_status(self):
        body = _create_upload(size=1024)
        create_resp = client.post("/api/v1/uploads", json=body)
        uid = create_resp.json()["uploadId"]
        resp = client.delete(f"/api/v1/uploads/{uid}", headers=_auth_headers())
        assert resp.status_code == 200
        assert resp.json()["status"] == "CANCELLED"

    def test_head_after_cancel_returns_404(self):
        body = _create_upload(size=1024)
        create_resp = client.post("/api/v1/uploads", json=body)
        uid = create_resp.json()["uploadId"]
        client.delete(f"/api/v1/uploads/{uid}", headers=_auth_headers())
        resp = client.head(f"/api/v1/uploads/{uid}", headers=_auth_headers())
        assert resp.status_code == 404
