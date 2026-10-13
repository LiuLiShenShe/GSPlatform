"""Same-scene resumable uploads and PostgreSQL publication compare-and-swap."""

from __future__ import annotations

import hashlib
import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Event

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, inspect, select

from app.core.config import settings
from app.core.errors import ConflictError
from app.core.rate_limit import reset_rate_limits
from app.db.models.asset import Asset
from app.db.models.collision_asset import CollisionAsset
from app.db.models.job import Job
from app.db.models.scene import Scene, SceneVersion
from app.db.models.scene_annotation import SceneAnnotation
from app.db.models.scene_edit_session import SceneEditSession
from app.db.models.scene_presentation import ScenePresentation
from app.db.models.scene_processing import SceneProcessingSettings
from app.db.models.scene_spatial_state import SceneSpatialState
from app.db.models.scene_viewpoint import SceneViewpoint
from app.db.models.upload_session import UploadSession
from app.db.session import SessionLocal
from app.main import app
from app.services.editor_session import EditBaseVersionChanged
from app.services.publish_service import PublishService
from app.storage import LocalDiskStorage
from tests.test_editor_sessions import create_edit
from tests.test_editor_sessions import owner as owner


@pytest.fixture(autouse=True)
def isolated_publication_bridge(tmp_path, monkeypatch):
    (tmp_path / "scenes").mkdir()
    monkeypatch.setattr("app.services.publish_service.get_repo_root", lambda: tmp_path)


@pytest.fixture()
def publication_clock(monkeypatch):
    class PublicationClock(datetime):
        instant = datetime(2026, 10, 11, 12, tzinfo=UTC)

        @classmethod
        def now(cls, tz=None):
            return cls.instant

    monkeypatch.setattr("app.services.publish_service.datetime", PublicationClock)
    return PublicationClock


def publication_edit(owner, db, clock, digest):
    client, scene, headers = owner
    source = db.get(SceneVersion, scene.current_version_id)
    if source.format == "streamed-sog":
        directory = (Path(settings.storage_root) / "published" / str(scene.id)
                     / "versions" / source.asset_version)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "lod-meta.json").write_bytes(b"{}")
        origin = Path(settings.scene_origin_root) / scene.slug / "versions"
        origin.mkdir(parents=True, exist_ok=True)
        (origin / source.asset_version).symlink_to(directory, target_is_directory=True)
    response = client.post(f"/api/v1/scenes/{scene.slug}/edit-sessions", headers=headers,
                           json={"expectedCurrentVersion": str(source.id), "selectedLod": 0,
                                 "acknowledgeLodSource": True})
    assert response.status_code == 201, response.text
    edit = db.get(SceneEditSession, response.json()["id"])
    edit.result_sha256 = digest
    edit.status = "PUBLISHING"
    # created_at and expires_at must come from the SAME controllable clock. The
    # column defaults to database now(), so leaving created_at on wall-clock time
    # makes the frozen publication clock expire the row in the past once real
    # time passes the fixture instant, and ck_scene_edit_sessions_expiry_valid
    # (expires_at > created_at) rejects it. The constraint is production
    # behaviour and stays intact; only the fixture time source is controlled.
    edit.created_at = clock.instant
    edit.expires_at = clock.instant + timedelta(days=1)
    edit.provenance = {"sourceVersionId": str(source.id), "editSessionId": str(edit.id)}
    db.commit()
    return edit


def seed_spatial_history(owner, db, clock, state="VALID"):
    from app.services.collision import world_transform_hash

    _, scene, _ = owner
    assert db.get_bind().dialect.name == "postgresql"
    source = db.get(SceneVersion, scene.current_version_id)
    position = {"x": 1.0, "y": 2.0, "z": 3.0}
    target = {"x": 4.0, "y": 5.0, "z": 6.0}
    rotation = {"x": 0.0, "y": 90.0, "z": 0.0}
    scale = {"x": 2.0, "y": 2.0, "z": 2.0}
    db.add_all([
        SceneSpatialState(scene_id=scene.id, source_version_id=scene.current_version_id,
                          state=state, stale_at=clock.instant - timedelta(days=1)),
        SceneProcessingSettings(scene_id=scene.id, collision_policy="AUTO_WHEN_CALIBRATED"),
        ScenePresentation(scene_id=scene.id, world_position=position, world_rotation=rotation,
                          world_scale=scale, initial_camera_position=position,
                          initial_camera_target=target, initial_camera_fov=72.0,
                          collision_enabled=True),
        SceneViewpoint(scene_id=scene.id, name="Original camera", position=position,
                       target=target, fov=72.0, enabled=True),
        SceneAnnotation(scene_id=scene.id, title="Original annotation", anchor_x=1.0,
                        anchor_y=2.0, anchor_z=3.0, text_content="Historical spatial data"),
    ])
    payload = b"historical-collision"
    asset = Asset(scene_id=scene.id, version_id=scene.current_version_id,
                  kind="COLLISION_GLB", storage_key="private/collision.glb",
                  mime_type="model/gltf-binary", byte_size=len(payload),
                  sha256=hashlib.sha256(payload).hexdigest(), metadata_={})
    LocalDiskStorage(settings.storage_root).write(asset.storage_key, payload)
    db.add(asset)
    db.flush()
    db.add(CollisionAsset(scene_id=scene.id, asset_id=asset.id, mode="OUTDOOR",
                          status="SUCCEEDED", build_params={
                              "sourceVersion": source.asset_version,
                              "worldTransformHash": world_transform_hash(position, rotation, scale),
                          }))
    db.commit()


def historical_spatial_data(db, scene, source_id):
    def columns(record):
        return {column.key: getattr(record, column.key)
                for column in inspect(record).mapper.column_attrs}

    rows = {
        model.__tablename__: [columns(record) for record in
                              db.query(model).filter_by(scene_id=scene.id).order_by(model.id)]
        for model in (ScenePresentation, SceneViewpoint, SceneAnnotation, CollisionAsset)
    }
    rows["source_version"] = columns(db.get(SceneVersion, source_id))
    rows["source_assets"] = [columns(record) for record in
                             db.query(Asset).filter_by(version_id=source_id).order_by(Asset.id)]
    root = Path(settings.storage_root)
    source = db.get(SceneVersion, source_id)
    directory = root / "published" / str(scene.id) / "versions" / source.asset_version
    rows["source_files"] = {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in directory.rglob("*") if path.is_file()
    }
    collision_file = root / "private/collision.glb"
    rows["collision_file"] = collision_file.read_bytes() if collision_file.exists() else None
    return rows


def assert_stale_runtime(owner):
    client, scene, _ = owner
    response = client.get(f"/api/v1/scenes/{scene.slug}/runtime")
    assert response.status_code == 200, response.text
    runtime = response.json()
    assert runtime["presentation"]["initialCamera"] == {
        "position": None, "target": None, "fov": None,
    }
    assert runtime["presentation"]["worldTransform"] == {
        "position": None, "rotation": None, "scale": None,
    }
    assert runtime["viewpoints"] == []
    assert runtime["annotations"] == []
    assert runtime["collision"]["stale"] is True
    assert runtime["collision"]["enabled"] is False
    assert runtime["collision"]["url"] is None


def upload_export(owner, edit, payload=b"export-bytes", *, digest=None):
    client, scene, headers = owner
    url = f"/api/v1/scenes/{scene.slug}/edit-sessions/{edit['id']}"
    response = client.post(url + "/uploads", headers=headers, json={
        "filename": "edited.ply", "format": "ply", "size": len(payload), "sha256": digest,
    })
    assert response.status_code == 200, response.text
    upload = response.json()
    response = client.patch(f"/api/v1/uploads/{upload['uploadId']}",
                            headers={**headers, "Upload-Offset": "0"}, content=payload)
    assert response.status_code == 200, response.text
    return url, upload


def publish_arguments(scene, edit, asset_version):
    return dict(
        scene_id=scene.id, version_id=asset_version,
        manifest={"schemaVersion": 1, "assetVersion": asset_version,
                  "conversionRecipe": {"toolVersion": "3.3.3", "recipeVersion": "2"}},
        entry_bytes=10, entry_url=f"versions/{asset_version}/lod-meta.json",
        counts=[2, 1, 1], source_sha256=edit.result_sha256 if edit else "d" * 64,
        edit_session_id=edit.id if edit else None,
    )


@pytest.mark.parametrize("binding", ["VALID", "VERIFIED"])
def test_existing_valid_spatial_binding_is_invalidated_atomically(
    owner, db, publication_clock, binding,
):
    client, scene, _ = owner
    source_id = scene.current_version_id
    seed_spatial_history(owner, db, publication_clock, binding)
    before = historical_spatial_data(db, scene, source_id)
    runtime = client.get(f"/api/v1/scenes/{scene.slug}/runtime").json()
    assert runtime["presentation"]["initialCamera"]["position"] is not None
    assert runtime["presentation"]["worldTransform"]["scale"] is not None
    assert len(runtime["viewpoints"]) == len(runtime["annotations"]) == 1
    assert runtime["collision"]["url"] is not None
    edit = publication_edit(owner, db, publication_clock, "b" * 64)
    result = PublishService(db, LocalDiskStorage(settings.storage_root)).commit_version(
        **publish_arguments(scene, edit, "spatial000001"),
    )
    db.commit()
    db.expire_all()
    spatial = db.get(SceneSpatialState, scene.id)
    assert spatial.state == "STALE"
    assert spatial.source_version_id == source_id
    assert spatial.stale_at == publication_clock.instant
    assert db.get(Scene, scene.id).current_version_id == result.id
    assert db.get(SceneEditSession, edit.id).status == "COMPLETED"
    assert_stale_runtime(owner)
    assert historical_spatial_data(db, scene, source_id) == before
    assert db.query(Job).filter_by(scene_id=scene.id, kind="BUILD_COLLISION").count() == 0


@pytest.mark.parametrize("replay", ["current", "advanced", "expired"])
def test_completed_publication_replay_is_read_only(owner, db, publication_clock, replay):
    _, scene, _ = owner
    source_id = scene.current_version_id
    seed_spatial_history(owner, db, publication_clock)
    edit = publication_edit(owner, db, publication_clock, "b" * 64)
    service = PublishService(db, LocalDiskStorage(settings.storage_root))
    arguments = publish_arguments(scene, edit, "replay000001")
    first = service.commit_version(**arguments)
    db.commit()
    if replay == "advanced":
        publication_clock.instant += timedelta(hours=1)
        second_edit = publication_edit(owner, db, publication_clock, "c" * 64)
        service.commit_version(**publish_arguments(scene, second_edit, "replay000002"))
        db.commit()
    current_id = scene.current_version_id
    spatial = db.get(SceneSpatialState, scene.id)
    spatial_before = (spatial.state, spatial.source_version_id, spatial.stale_at)
    completed_at = edit.completed_at
    provenance = dict(edit.provenance)
    before = historical_spatial_data(db, scene, source_id)
    version_count = db.query(SceneVersion).filter_by(scene_id=scene.id).count()
    publication_clock.instant += timedelta(days=2) if replay == "expired" else timedelta(hours=1)
    replayed = service.commit_version(**arguments)
    db.commit()
    db.expire_all()
    spatial = db.get(SceneSpatialState, scene.id)
    completed = db.get(SceneEditSession, edit.id)
    assert replayed.id == first.id
    assert db.get(Scene, scene.id).current_version_id == current_id
    assert db.query(SceneVersion).filter_by(scene_id=scene.id).count() == version_count
    assert (spatial.state, spatial.source_version_id, spatial.stale_at) == spatial_before
    assert completed.status == "COMPLETED"
    assert completed.completed_at == completed_at
    assert completed.provenance == provenance
    assert historical_spatial_data(db, scene, source_id) == before
    assert db.query(Job).filter_by(scene_id=scene.id, kind="BUILD_COLLISION").count() == 0
    assert_stale_runtime(owner)


@pytest.mark.parametrize("binding", [None, "VALID", "VERIFIED", "STALE"])
def test_same_content_new_session_does_not_invalidate_spatial_state(
    owner, db, publication_clock, binding,
):
    _, scene, _ = owner
    service = PublishService(db, LocalDiskStorage(settings.storage_root))
    original = service.commit_version(**publish_arguments(scene, None, "samecontent001"))
    db.commit()
    if binding is not None:
        seed_spatial_history(owner, db, publication_clock, binding)
    else:
        db.add(SceneProcessingSettings(scene_id=scene.id,
                                       collision_policy="AUTO_WHEN_CALIBRATED"))
        db.commit()
    spatial = db.get(SceneSpatialState, scene.id)
    spatial_before = ((spatial.state, spatial.source_version_id, spatial.stale_at)
                      if spatial else None)
    publication_clock.instant += timedelta(hours=1)
    edit = publication_edit(owner, db, publication_clock, "d" * 64)
    before = historical_spatial_data(db, scene, original.id)
    reused = service.commit_version(**publish_arguments(scene, edit, "samecontent001"))
    db.commit()
    db.expire_all()
    spatial = db.get(SceneSpatialState, scene.id)
    assert ((spatial.state, spatial.source_version_id, spatial.stale_at)
            if spatial else None) == spatial_before
    assert reused.id == original.id == db.get(Scene, scene.id).current_version_id
    assert db.query(SceneVersion).filter_by(scene_id=scene.id).count() == 2
    assert db.get(SceneProcessingSettings, scene.id).collision_policy == "AUTO_WHEN_CALIBRATED"
    completed = db.get(SceneEditSession, edit.id)
    assert completed.status == "COMPLETED"
    assert completed.completed_at == publication_clock.instant
    assert completed.provenance["publishedVersionId"] == str(original.id)
    assert completed.provenance["invalidatedFromVersionId"] is None
    assert completed.provenance["spatialInvalidationReason"] is None
    assert completed.provenance["spatialBindings"] == binding
    assert historical_spatial_data(db, scene, original.id) == before
    assert db.query(Job).filter_by(scene_id=scene.id, kind="BUILD_COLLISION").count() == 0


@pytest.mark.parametrize("binding", ["VALID", "STALE"])
def test_consecutive_edits_preserve_original_binding_and_latest_invalidation(
    owner, db, publication_clock, binding,
):
    client, scene, _ = owner
    source_id = scene.current_version_id
    seed_spatial_history(owner, db, publication_clock, binding)
    before = historical_spatial_data(db, scene, source_id)
    service = PublishService(db, LocalDiskStorage(settings.storage_root))
    first_edit = publication_edit(owner, db, publication_clock, "b" * 64)
    first_time = publication_clock.instant
    first = service.commit_version(**publish_arguments(scene, first_edit, "sequence0001"))
    db.commit()
    spatial = db.get(SceneSpatialState, scene.id)
    assert spatial.state == "STALE"
    assert spatial.source_version_id == source_id
    assert spatial.stale_at == first_time
    first_provenance = dict(first_edit.provenance)
    assert first_provenance["invalidatedFromVersionId"] == str(source_id)
    assert first_provenance["publishedVersionId"] == str(first.id)
    assert_stale_runtime(owner)
    publication_clock.instant += timedelta(hours=1)
    second_edit = publication_edit(owner, db, publication_clock, "c" * 64)
    first_history = historical_spatial_data(db, scene, first.id)
    arguments = publish_arguments(scene, second_edit, "sequence0002")
    arguments["counts"] = [1, 1, 1]
    second = service.commit_version(**arguments)
    db.commit()
    db.expire_all()
    spatial = db.get(SceneSpatialState, scene.id)
    first_edit = db.get(SceneEditSession, first_edit.id)
    second_edit = db.get(SceneEditSession, second_edit.id)
    assert db.get(Scene, scene.id).current_version_id == second.id
    assert db.query(SceneVersion).filter_by(scene_id=scene.id).count() == 3
    assert first_edit.status == second_edit.status == "COMPLETED"
    assert first_edit.provenance == first_provenance
    assert first_edit.completed_at == first_time
    assert second_edit.source_version_id == first.id
    assert second_edit.provenance["sourceVersionId"] == str(first.id)
    assert second_edit.provenance["invalidatedFromVersionId"] == str(first.id)
    assert second_edit.provenance["publishedVersionId"] == str(second.id)
    assert second_edit.provenance["spatialInvalidationReason"] == "GAUSSIAN_GEOMETRY_CHANGED"
    assert spatial.state == "STALE"
    assert spatial.source_version_id == source_id
    assert spatial.stale_at == second_edit.completed_at == publication_clock.instant
    assert spatial.stale_at > first_time
    assert_stale_runtime(owner)
    runtime = client.get(f"/api/v1/scenes/{scene.slug}/runtime").json()
    assert runtime["content"]["url"].endswith("/versions/sequence0002/lod-meta.json")
    assert historical_spatial_data(db, scene, source_id) == before
    assert historical_spatial_data(db, scene, first.id) == first_history
    assert db.query(Job).filter_by(scene_id=scene.id, kind="BUILD_COLLISION").count() == 0
    print("SPATIAL_SEQUENCE", json.dumps({
        "sceneId": str(scene.id), "A": str(source_id), "B": str(first.id), "C": str(second.id),
        "bindingSource": str(spatial.source_version_id), "firstStaleAt": first_time.isoformat(),
        "latestStaleAt": spatial.stale_at.isoformat(), "firstProvenance": first_edit.provenance,
        "secondProvenance": second_edit.provenance,
    }))


def test_reusing_historical_version_is_a_real_geometry_change(owner, db, publication_clock):
    _, scene, _ = owner
    source_id = scene.current_version_id
    seed_spatial_history(owner, db, publication_clock)
    service = PublishService(db, LocalDiskStorage(settings.storage_root))
    first_edit = publication_edit(owner, db, publication_clock, "b" * 64)
    first = service.commit_version(**publish_arguments(scene, first_edit, "historical001"))
    db.commit()
    publication_clock.instant += timedelta(hours=1)
    second_edit = publication_edit(owner, db, publication_clock, "c" * 64)
    second = service.commit_version(**publish_arguments(scene, second_edit, "historical002"))
    db.commit()
    publication_clock.instant += timedelta(hours=1)
    third_edit = publication_edit(owner, db, publication_clock, "b" * 64)
    reused = service.commit_version(**publish_arguments(scene, third_edit, "historical001"))
    db.commit()
    spatial = db.get(SceneSpatialState, scene.id)
    assert reused.id == first.id == scene.current_version_id
    assert db.query(SceneVersion).filter_by(scene_id=scene.id).count() == 3
    assert spatial.source_version_id == source_id
    assert spatial.state == "STALE"
    assert spatial.stale_at == publication_clock.instant
    assert third_edit.provenance["invalidatedFromVersionId"] == str(second.id)
    assert third_edit.provenance["publishedVersionId"] == str(first.id)
    assert_stale_runtime(owner)


@pytest.mark.parametrize("failure", ["spatial_flush", "final_commit"])
@pytest.mark.parametrize("binding", [None, "VALID", "STALE"])
def test_publication_failure_rolls_back_all_database_changes(
    owner, db, publication_clock, failure, binding,
):
    _, scene, _ = owner
    source_id = scene.current_version_id
    if binding is not None:
        seed_spatial_history(owner, db, publication_clock, binding)
    edit = publication_edit(owner, db, publication_clock, "b" * 64)
    provenance_before = dict(edit.provenance)
    before = historical_spatial_data(db, scene, source_id)
    spatial = db.get(SceneSpatialState, scene.id)
    spatial_before = ((spatial.state, spatial.source_version_id, spatial.stale_at)
                      if spatial else None)

    def fail_after_spatial_flush(session, flush_context):
        if any(isinstance(record, SceneSpatialState) for record in session.new | session.dirty):
            raise RuntimeError("simulated spatial flush failure")

    def fail_final_commit(session):
        raise RuntimeError("simulated final commit failure")

    hook = "after_flush" if failure == "spatial_flush" else "before_commit"
    listener = fail_after_spatial_flush if failure == "spatial_flush" else fail_final_commit
    event.listen(db, hook, listener)
    try:
        with pytest.raises(RuntimeError, match="simulated .* failure"):
            PublishService(db, LocalDiskStorage(settings.storage_root)).commit_version(
                **publish_arguments(scene, edit, "rollback0001"),
            )
            if failure == "final_commit":
                db.flush()
                with SessionLocal() as independent:
                    assert independent.get(Scene, scene.id).current_version_id == source_id
                    assert independent.get(SceneEditSession, edit.id).status == "PUBLISHING"
                    pending_spatial = independent.get(SceneSpatialState, scene.id)
                    assert (
                        (pending_spatial.state, pending_spatial.source_version_id,
                         pending_spatial.stale_at) if pending_spatial else None
                    ) == spatial_before
            db.commit()
    finally:
        event.remove(db, hook, listener)
        db.rollback()
    with SessionLocal() as independent:
        assert independent.get(Scene, scene.id).current_version_id == source_id
        assert independent.query(SceneVersion).filter_by(scene_id=scene.id).count() == 1
        recovered_edit = independent.get(SceneEditSession, edit.id)
        assert recovered_edit.status == "PUBLISHING"
        assert recovered_edit.completed_at is None
        assert recovered_edit.result_version_id is None
        assert recovered_edit.provenance == provenance_before
        spatial = independent.get(SceneSpatialState, scene.id)
        assert ((spatial.state, spatial.source_version_id, spatial.stale_at)
                if spatial else None) == spatial_before
        processing = independent.get(SceneProcessingSettings, scene.id)
        assert (processing.collision_policy if processing else None) == (
            "AUTO_WHEN_CALIBRATED" if binding is not None else None
        )
        assert historical_spatial_data(independent, scene, source_id) == before


@pytest.mark.parametrize("binding", [None, "VALID", "STALE"])
def test_ordinary_publication_does_not_change_editor_spatial_state(
    owner, db, publication_clock, binding,
):
    _, scene, _ = owner
    source_id = scene.current_version_id
    if binding is not None:
        seed_spatial_history(owner, db, publication_clock, binding)
    before = historical_spatial_data(db, scene, source_id)
    spatial = db.get(SceneSpatialState, scene.id)
    spatial_before = ((spatial.state, spatial.source_version_id, spatial.stale_at)
                      if spatial else None)
    service = PublishService(db, LocalDiskStorage(settings.storage_root))
    arguments = publish_arguments(scene, None, "ordinary0001")
    result = service.commit_version(**arguments)
    db.commit()
    publication_clock.instant += timedelta(hours=1)
    assert service.commit_version(**arguments).id == result.id
    db.commit()
    db.expire_all()
    assert db.get(Scene, scene.id).current_version_id == result.id
    assert db.query(SceneVersion).filter_by(scene_id=scene.id).count() == 2
    assert db.query(SceneEditSession).filter_by(scene_id=scene.id).count() == 0
    spatial = db.get(SceneSpatialState, scene.id)
    assert ((spatial.state, spatial.source_version_id, spatial.stale_at)
            if spatial else None) == spatial_before
    processing = db.get(SceneProcessingSettings, scene.id)
    assert (processing.collision_policy if processing else None) == (
        "AUTO_WHEN_CALIBRATED" if binding is not None else None
    )
    assert historical_spatial_data(db, scene, source_id) == before


@pytest.mark.parametrize("change", ["version", "sha", "manifest"])
def test_completed_session_cannot_be_retargeted(owner, db, publication_clock, change):
    _, scene, _ = owner
    seed_spatial_history(owner, db, publication_clock)
    edit = publication_edit(owner, db, publication_clock, "b" * 64)
    service = PublishService(db, LocalDiskStorage(settings.storage_root))
    arguments = publish_arguments(scene, edit, "retarget0001")
    result = service.commit_version(**arguments)
    db.commit()
    provenance = dict(edit.provenance)
    spatial_time = db.get(SceneSpatialState, scene.id).stale_at
    if change == "version":
        arguments["version_id"] = "retarget0002"
    elif change == "sha":
        arguments["source_sha256"] = "c" * 64
    else:
        arguments["manifest"] = {**arguments["manifest"], "schemaVersion": 2}
    publication_clock.instant += timedelta(hours=1)
    with pytest.raises(ConflictError):
        service.commit_version(**arguments)
    db.rollback()
    assert db.get(Scene, scene.id).current_version_id == result.id
    assert db.query(SceneVersion).filter_by(scene_id=scene.id).count() == 2
    assert db.get(SceneSpatialState, scene.id).stale_at == spatial_time
    assert db.get(SceneEditSession, edit.id).provenance == provenance


@pytest.mark.parametrize("reader", ["anonymous", "share", "other"])
def test_spatial_invalidation_does_not_grant_editor_write_access(
    owner, db, publication_clock, reader,
):
    client, scene, headers = owner
    seed_spatial_history(owner, db, publication_clock)
    edit = publication_edit(owner, db, publication_clock, "b" * 64)
    source_id = scene.current_version_id
    before = historical_spatial_data(db, scene, source_id)
    with TestClient(app) as outsider:
        expected = 401
        if reader == "share":
            response = client.post(f"/api/v1/shares/scenes/{scene.slug}", headers=headers)
            assert response.status_code == 200, response.text
            token = response.json()["token"]
            assert outsider.get(f"/api/v1/shares/resolve/{token}").status_code == 200
            assert outsider.get(f"/api/v1/scenes/{scene.slug}/runtime").status_code == 200
        elif reader == "other":
            scene.visibility = "PUBLIC"
            db.commit()
            reset_rate_limits("register", "testclient")
            response = outsider.post("/api/v1/auth/register", json={
                "email": f"spatial-other-{uuid.uuid4().hex}@example.com",
                "password": "editor-test-password", "displayName": "Other spatial user",
            })
            assert response.status_code == 200, response.text
            expected = 403
        csrf = outsider.cookies.get("gs_csrf")
        outside_headers = {"X-CSRF-Token": csrf} if csrf else {}
        base = f"/api/v1/scenes/{scene.slug}/edit-sessions"
        for url, payload in [
            (base, {"expectedCurrentVersion": str(source_id)}),
            (f"{base}/{edit.id}/uploads", {"filename": "edited.ply", "format": "ply", "size": 1}),
            (f"{base}/{edit.id}/complete", {}),
        ]:
            assert outsider.post(url, headers=outside_headers, json=payload).status_code == expected
    db.expire_all()
    assert db.get(Scene, scene.id).current_version_id == source_id
    assert db.query(SceneVersion).filter_by(scene_id=scene.id).count() == 1
    assert db.query(SceneEditSession).filter_by(scene_id=scene.id).count() == 1
    assert db.get(SceneEditSession, edit.id).status == "PUBLISHING"
    spatial = db.get(SceneSpatialState, scene.id)
    assert spatial.state == "VALID"
    assert spatial.source_version_id == source_id
    assert spatial.stale_at == publication_clock.instant - timedelta(days=1)
    assert historical_spatial_data(db, scene, source_id) == before


def test_export_reuses_chunk_protocol_same_scene_sha_and_job(owner, db, monkeypatch):
    client, scene, headers = owner
    source_version = scene.current_version_id
    edit = create_edit(owner)
    calls = []
    monkeypatch.setattr("app.services.celery_client.send_task",
                        lambda *args, **kwargs: calls.append((args, kwargs)))
    payload = b"export-bytes"
    digest = hashlib.sha256(payload).hexdigest()
    url, upload = upload_export(owner, edit, payload, digest=digest)
    response = client.post(url + "/complete", headers=headers, json={
        "expected_size": len(payload), "sha256": digest,
    })
    assert response.status_code == 200, response.text
    completed = response.json()
    assert completed["sceneId"] == str(scene.id)
    assert len(calls) == 1
    db.expire_all()
    assert db.get(Scene, scene.id).current_version_id == source_version
    assert db.get(UploadSession, upload["uploadId"]).scene_id == scene.id
    assert db.get(SceneEditSession, edit["id"]).result_sha256 == digest
    assert db.query(SceneVersion).filter_by(scene_id=scene.id).count() == 1
    repeat = client.post(url + "/complete", headers=headers, json={"sha256": digest})
    assert repeat.status_code == 200
    assert repeat.json()["jobId"] == completed["jobId"]
    assert len(calls) == 1
    status = client.get(f"/api/v1/uploads/{upload['uploadId']}/status").json()
    assert status["collisionRequired"] is False
    assert status["collisionPolicyReason"] == "POLICY_MANUAL_ONLY"


@pytest.mark.parametrize("state", ["CANCELLED", "EXPIRED"])
def test_terminated_session_blocks_generic_protocol_and_keeps_pointer(owner, db, state):
    client, scene, headers = owner
    edit = create_edit(owner)
    url, upload = upload_export(owner, edit)
    record = db.get(SceneEditSession, edit["id"])
    if state == "EXPIRED":
        record.created_at = datetime.now(UTC) - timedelta(hours=1)
        record.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    else:
        record.status = state
    db.commit()
    original_version = scene.current_version_id
    generic = f"/api/v1/uploads/{upload['uploadId']}"
    assert client.post(generic + "/complete", headers=headers, json={}).status_code == 409
    assert client.post(url + "/complete", headers=headers, json={}).status_code == 409
    assert client.patch(generic, headers={**headers, "Upload-Offset": "12"},
                        content=b"x").status_code == 409
    db.expire_all()
    assert db.get(Scene, scene.id).current_version_id == original_version


def test_checksum_offset_bounds_wrong_scene_and_replacement(owner, db):
    client, scene, headers = owner
    edit = create_edit(owner)
    url, upload = upload_export(owner, edit)
    generic = f"/api/v1/uploads/{upload['uploadId']}"
    assert client.post(url + "/complete", headers=headers,
                       json={"sha256": "0" * 64}).status_code == 409
    assert client.patch(generic, headers={**headers, "Upload-Offset": "0"},
                        content=b"wrong offset").status_code == 409
    assert client.post(url + "/uploads", headers=headers, json={
        "filename": "other.ply", "format": "ply", "size": 3,
    }).status_code == 409
    assert client.post(url.replace(scene.slug, "wrong-scene") + "/complete",
                       headers=headers, json={}).status_code == 404
    assert db.query(Job).filter_by(scene_id=scene.id, kind="PUBLISH").count() == 0


def test_publication_keeps_source_immutable_records_provenance_and_stale(
    owner, db, publication_clock,
):
    client, scene, headers = owner
    source_id = scene.current_version_id
    original = db.get(SceneVersion, source_id)
    from app.db.models.scene_processing import SceneProcessingSettings

    db.add(SceneProcessingSettings(scene_id=scene.id, collision_policy="AUTO_WHEN_CALIBRATED"))
    source_sha = original.sha256
    source_file = (Path(settings.storage_root) / "published" / str(scene.id)
                   / "versions" / original.asset_version / "scene.ply")
    before = hashlib.sha256(source_file.read_bytes()).hexdigest()
    edit = create_edit(owner)
    record = db.get(SceneEditSession, edit["id"])
    record.result_sha256 = "b" * 64
    record.provenance = {"sourceVersionId": str(source_id), "editSessionId": edit["id"]}
    db.flush()
    service = PublishService(db, LocalDiskStorage(settings.storage_root))
    result = service.commit_version(**publish_arguments(scene, record, "edited000001"))
    db.commit()
    assert result.scene_id == scene.id
    assert scene.current_version_id == result.id
    assert record.status == "COMPLETED"
    assert record.completed_at == publication_clock.instant
    assert record.provenance["conversionRecipe"]["toolVersion"] == "3.3.3"
    assert record.provenance["sourceVersionId"] == str(source_id)
    assert record.provenance["invalidatedFromVersionId"] == str(source_id)
    assert record.provenance["publishedVersionId"] == str(result.id)
    assert record.provenance["resultVersionId"] == str(result.id)
    assert record.provenance["spatialInvalidationReason"] == "GAUSSIAN_GEOMETRY_CHANGED"
    assert record.provenance["collisionPolicy"] == "MANUAL_ONLY"
    assert record.provenance["previousCollisionPolicy"] == "AUTO_WHEN_CALIBRATED"
    assert db.get(SceneProcessingSettings, scene.id).collision_policy == "MANUAL_ONLY"
    spatial = db.get(SceneSpatialState, scene.id)
    assert spatial.state == "STALE"
    assert spatial.source_version_id == source_id
    assert spatial.stale_at == publication_clock.instant
    assert db.get(SceneVersion, source_id).sha256 == source_sha
    assert hashlib.sha256(source_file.read_bytes()).hexdigest() == before
    assert db.query(SceneVersion).filter_by(scene_id=scene.id).count() == 2
    source_info = client.get(f"/api/v1/scenes/{scene.slug}/edit-source").json()
    assert source_info["spatialState"] == "STALE"
    assert client.post(f"/api/v1/scenes/{scene.slug}/edit-sessions/{edit['id']}/cancel",
                       headers=headers).status_code == 409


@pytest.mark.parametrize("same_content", [False, True])
def test_two_sessions_final_scene_lock_and_cas_prevent_lost_update(
    owner, db, publication_clock, same_content,
):
    _, scene, _ = owner
    source_id = scene.current_version_id
    seed_spatial_history(owner, db, publication_clock)
    before = historical_spatial_data(db, scene, source_id)
    first_record = publication_edit(owner, db, publication_clock, "a" * 64)
    second_record = publication_edit(owner, db, publication_clock,
                                     "a" * 64 if same_content else "b" * 64)
    second_provenance = dict(second_record.provenance)
    first_arguments = publish_arguments(scene, first_record, "edited000002")
    second_arguments = publish_arguments(scene, second_record,
                                         "edited000002" if same_content else "edited000003")
    started = Event()
    db.execute(select(Scene).where(Scene.id == scene.id).with_for_update(of=Scene))

    def concurrent_publish():
        with SessionLocal() as concurrent:
            started.set()
            with pytest.raises(EditBaseVersionChanged) as conflict:
                PublishService(concurrent, LocalDiskStorage(settings.storage_root)).commit_version(
                    **second_arguments,
                )
            concurrent.rollback()
            return conflict.value.code

    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(concurrent_publish)
        assert started.wait(5)
        result = PublishService(db, LocalDiskStorage(settings.storage_root)).commit_version(
            **first_arguments,
        )
        first_time = first_record.completed_at
        first_provenance = dict(first_record.provenance)
        assert not pending.done()
        publication_clock.instant += timedelta(hours=1)
        db.commit()
        assert pending.result(timeout=10) == "EDIT_BASE_VERSION_CHANGED"
    db.expire_all()
    assert db.get(Scene, scene.id).current_version_id == result.id
    assert db.query(SceneVersion).filter_by(scene_id=scene.id).count() == 2
    spatial = db.get(SceneSpatialState, scene.id)
    assert spatial.state == "STALE"
    assert spatial.source_version_id == source_id
    assert spatial.stale_at == first_time
    assert first_time < publication_clock.instant
    assert db.get(SceneEditSession, first_record.id).provenance == first_provenance
    rejected = db.get(SceneEditSession, second_record.id)
    assert rejected.status == "PUBLISHING"
    assert rejected.result_version_id is None
    assert rejected.completed_at is None
    assert rejected.provenance == second_provenance
    assert historical_spatial_data(db, scene, source_id) == before
    assert_stale_runtime(owner)


def test_changed_base_rejects_complete_but_retains_valid_uploaded_bytes(owner, db):
    client, scene, headers = owner
    edit = create_edit(owner)
    url, upload = upload_export(owner, edit)
    new_version = SceneVersion(scene_id=scene.id, asset_version=uuid.uuid4().hex[:12],
                               format="sog", size_bytes=10, sha256="a" * 64, manifest={})
    db.add(new_version)
    db.flush()
    scene.current_version_id = new_version.id
    db.commit()
    response = client.post(url + "/complete", headers=headers, json={})
    assert response.status_code == 409
    assert response.json()["code"] == "EDIT_BASE_VERSION_CHANGED"
    assert (Path(settings.storage_root) / "staging" / upload["uploadId"]
            / "upload.bin").read_bytes() == b"export-bytes"
    db.expire_all()
    assert db.get(Scene, scene.id).current_version_id == new_version.id


def test_export_retention_preserves_current_and_history(owner, db):
    from app.services.editor_session import EditorSessionService

    _, scene, _ = owner
    edit = create_edit(owner)
    _, upload = upload_export(owner, edit)
    record = db.get(SceneEditSession, edit["id"])
    record.created_at = datetime.now(UTC) - timedelta(days=10)
    record.expires_at = datetime.now(UTC) - timedelta(days=8)
    db.commit()
    current = scene.current_version_id
    assert EditorSessionService(db, settings).cleanup_exports() == 1
    assert record.status == "EXPIRED"
    assert not (Path(settings.storage_root) / "staging" / upload["uploadId"]).exists()
    assert db.get(Scene, scene.id).current_version_id == current
    assert db.get(SceneVersion, current) is not None


def test_stale_spatial_history_is_preserved_but_not_used_by_runtime(owner, db):
    from app.db.models.asset import Asset
    from app.db.models.collision_asset import CollisionAsset
    from app.db.models.scene_presentation import ScenePresentation
    from app.services.collision import world_transform_hash

    client, scene, _ = owner
    position = {"x": 1.0, "y": 2.0, "z": 3.0}
    presentation = ScenePresentation(scene_id=scene.id, world_position=position,
                                     initial_camera_position=position, collision_enabled=True)
    db.add(presentation)
    db.add(SceneSpatialState(scene_id=scene.id, source_version_id=scene.current_version_id,
                             state="STALE", stale_at=datetime.now(UTC)))
    asset = Asset(scene_id=scene.id, version_id=scene.current_version_id,
                  kind="COLLISION_GLB", storage_key="private/collision.glb",
                  mime_type="model/gltf-binary", byte_size=3, sha256="a" * 64, metadata_={})
    db.add(asset)
    db.flush()
    collision = CollisionAsset(scene_id=scene.id, asset_id=asset.id, mode="OUTDOOR",
                               status="SUCCEEDED", build_params={
                                   "sourceVersion": scene.current_version.asset_version,
                                   "worldTransformHash": world_transform_hash(position, None, None),
                               })
    db.add(collision)
    db.commit()
    runtime = client.get(f"/api/v1/scenes/{scene.slug}/runtime").json()
    assert runtime["presentation"]["initialCamera"]["position"] is None
    assert runtime["presentation"]["worldTransform"]["position"] is None
    assert runtime["viewpoints"] == []
    assert runtime["annotations"] == []
    assert runtime["collision"]["stale"] is True
    assert runtime["collision"]["enabled"] is False
    assert runtime["collision"]["url"] is None
    db.refresh(presentation)
    assert presentation.world_position == position
    assert presentation.initial_camera_position == position
    assert db.get(CollisionAsset, collision.id).status == "SUCCEEDED"
