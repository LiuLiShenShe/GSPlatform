from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.core.config import settings
from app.db.models.job import Job
from app.db.models.scene import Scene
from app.db.models.upload_session import UploadSession
from app.db.models.user import User
from app.db.session import SessionLocal
from workers.pipeline.convert_scene import ConvertResult
from workers.tasks.publish_scene import publish_scene
from workers.tests.test_convert_scene_formats import _gaussian_ply_bytes


def _queued_upload(source_quarantined=False):
    session = SessionLocal()
    owner = User(
        email=f"convert-{uuid.uuid4().hex}@test.local", display_name="Convert test"
    )
    session.add(owner)
    session.flush()
    scene = Scene(
        owner_id=owner.id,
        title="Convert test",
        slug=f"convert-{uuid.uuid4().hex[:12]}",
        category="experiment",
        visibility="PRIVATE",
        status="PROCESSING",
    )
    session.add(scene)
    session.flush()
    upload_id = uuid.uuid4()
    payload = _gaussian_ply_bytes(64)
    upload = UploadSession(
        id=upload_id,
        owner_id=owner.id,
        scene_id=scene.id,
        purpose="PUBLISH",
        status="QUEUED",
        upload_format="ply",
        mime_type="application/octet-stream",
        storage_key=f"staging/{upload_id}/upload.bin",
        total_size=len(payload),
        offset=len(payload),
        expires_at=datetime.now(timezone.utc) + timedelta(days=1),
        title="Convert test",
        visibility="PRIVATE",
        category="experiment",
    )
    session.add(upload)
    job = Job(
        scene_id=scene.id,
        owner_id=owner.id,
        kind="PUBLISH",
        status="QUEUED",
        progress=0,
        attempt=0,
    )
    session.add(job)
    session.commit()
    base = "quarantine" if source_quarantined else "staging"
    source = Path(settings.storage_root) / base / str(upload_id) / "upload.bin"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(payload)
    session.close()
    return upload, scene, job, source


def test_failed_conversion_preserves_source_and_old_staging(monkeypatch):
    upload, scene, job, source = _queued_upload()
    old_staging = (
        Path(settings.storage_root)
        / "published"
        / str(scene.id)
        / ".staging"
        / "preserved"
    )
    old_staging.parent.mkdir(parents=True)
    old_staging.write_bytes(b"old output")
    monkeypatch.setattr(
        "workers.pipeline.convert_scene.convert_to_streamed_sog",
        lambda *arguments, **keywords: ConvertResult(False, reason="stack failed"),
    )
    result = publish_scene(str(upload.id), str(scene.id), str(job.id))
    assert result["ok"] is False
    assert source.is_file()
    assert old_staging.read_bytes() == b"old output"
    with SessionLocal() as session:
        updated = session.get(Job, job.id)
        assert updated.status == "FAILED"
        assert updated.execution_generation == 1


def test_retry_safely_reads_quarantined_source(monkeypatch):
    upload, scene, job, source = _queued_upload(source_quarantined=True)
    seen = []

    def failed_conversion(source_path, staging, **keywords):
        seen.append(source_path)
        return ConvertResult(False, reason="stack failed")

    monkeypatch.setattr(
        "workers.pipeline.convert_scene.convert_to_streamed_sog", failed_conversion
    )
    publish_scene(str(upload.id), str(scene.id), str(job.id))
    assert seen == [source]
    assert source.is_file()


def test_terminal_publish_delivery_does_not_execute(monkeypatch):
    upload, scene, job, source = _queued_upload()
    with SessionLocal() as session:
        stored = session.get(Job, job.id)
        stored.status = "FAILED"
        session.commit()
    calls = []
    monkeypatch.setattr(
        "workers.pipeline.convert_scene.convert_to_streamed_sog",
        lambda *arguments, **keywords: calls.append(arguments),
    )
    result = publish_scene(str(upload.id), str(scene.id), str(job.id))
    assert result["duplicate"]
    assert not calls
    assert source.is_file()


def test_busy_duplicate_publish_is_fenced_by_live_lease(monkeypatch):
    upload, scene, job, source = _queued_upload()
    with SessionLocal() as session:
        stored = session.get(Job, job.id)
        stored.status = "RUNNING"
        stored.started_at = datetime.now(timezone.utc)
        stored.lease_expires_at = datetime.now(timezone.utc) + timedelta(minutes=5)
        stored.execution_generation = 3
        session.commit()
    calls = []
    monkeypatch.setattr(
        "workers.pipeline.convert_scene.convert_to_streamed_sog",
        lambda *arguments, **keywords: calls.append(arguments),
    )
    result = publish_scene(str(upload.id), str(scene.id), str(job.id))
    assert result["status"] == "BUSY"
    assert not calls
    assert source.is_file()
