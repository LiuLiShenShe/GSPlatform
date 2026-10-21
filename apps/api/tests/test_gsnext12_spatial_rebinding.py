"""GS-NEXT-12 §A — spatial re-authoring closure after a version switch.

The P1: once ``scene_spatial_states.state`` became ``STALE``, nothing ever
re-confirmed anything, so a freshly saved initial camera was still suppressed
by the runtime descriptor forever.  These tests pin the corrected contract:

* re-saving the initial camera on the current version makes it effective;
* re-creating / explicitly re-posing a viewpoint or annotation makes *that*
  record effective on the current version;
* old, unconfirmed records stay disabled (and are never deleted);
* saving one feature never wholesale-restores the others (world transform,
  collision, calibration stay gated);
* the version list reports exactly which features are pending.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.db.models.asset import Asset
from app.db.models.collision_asset import CollisionAsset
from app.db.models.scene import Scene, SceneVersion
from app.db.models.scene_annotation import SceneAnnotation
from app.db.models.scene_presentation import ScenePresentation
from app.db.models.scene_processing import SceneProcessingSettings
from app.db.models.scene_spatial_state import SceneSpatialState
from app.db.models.scene_viewpoint import SceneViewpoint
from app.main import app
from tests.conftest_scenes import create_scene

client = TestClient(app)
H: dict[str, str] = {}

CAM_A = {"x": 1.0, "y": 2.0, "z": 9.0}
TGT_A = {"x": 0.0, "y": 0.5, "z": 0.0}
CAM_B = {"x": -4.0, "y": 1.2, "z": 3.5}
TGT_B = {"x": 0.1, "y": 0.8, "z": -0.2}


@pytest.fixture()
def isolated_roots(tmp_path, monkeypatch):
    origin = tmp_path / "scene-origin"
    origin.mkdir()
    storage = tmp_path / "storage"
    storage.mkdir()
    monkeypatch.setattr(settings, "storage_root", str(storage))
    monkeypatch.setattr(settings, "scene_origin_root", str(origin))
    monkeypatch.setattr("app.services.publish_service.get_repo_root", lambda: tmp_path)
    return storage, origin


_SEQ = {"n": 0}


def _make_version(db, scene: Scene, *, fmt: str = "streamed-sog") -> SceneVersion:
    av = uuid.uuid4().hex[:24]
    directory = Path(settings.storage_root) / "published" / str(scene.id) / "versions" / av
    directory.mkdir(parents=True, exist_ok=True)
    if fmt == "streamed-sog":
        (directory / "lod-meta.json").write_text(json.dumps({"counts": [100, 30]}))
        manifest = {
            "format": "streamed-sog",
            "stream": {"entryUrl": f"versions/{av}/lod-meta.json", "counts": [100, 30]},
        }
        entry_name, version_format = "lod-meta.json", "streamed-sog"
    else:
        (directory / "scene.sog").write_bytes(b"SOG" + av.encode())
        payload = b"SOG" + av.encode()
        manifest = {
            "format": "sog",
            "assetUrl": f"versions/{av}/scene.sog",
            "content": {
                "entryUrl": f"versions/{av}/scene.sog",
                "counts": [100],
                "sha256": hashlib.sha256(payload).hexdigest(),
            },
        }
        entry_name, version_format = "scene.sog", "sog"
    (directory / "manifest.json").write_text(json.dumps(manifest))
    _SEQ["n"] += 1
    version = SceneVersion(
        scene_id=scene.id,
        asset_version=av,
        format=version_format,
        size_bytes=(directory / entry_name).stat().st_size,
        sha256=hashlib.sha256(av.encode()).hexdigest(),
        manifest=manifest,
        created_at=datetime(2026, 10, 21, 12, 0, tzinfo=UTC) + timedelta(seconds=_SEQ["n"]),
    )
    db.add(version)
    db.flush()
    db.add(
        Asset(
            scene_id=scene.id,
            version_id=version.id,
            kind="SOG",
            storage_key=f"published/{scene.id}/versions/{av}/{entry_name}",
            mime_type="application/octet-stream",
            byte_size=version.size_bytes,
            sha256="",
            metadata_={"counts": [100]},
        )
    )
    db.commit()
    db.refresh(version)
    return version


def _scene_with_versions(db, *, fmt: str = "streamed-sog"):
    scene = create_scene(
        session=db,
        title="空间重新绑定",
        slug=f"gsnext12-{uuid.uuid4().hex[:8]}",
        with_version=False,
    )
    a = _make_version(db, scene, fmt=fmt)
    b = _make_version(db, scene, fmt=fmt)
    scene.current_version_id = a.id
    scene.splat_count = 100
    scene.size_bytes = a.size_bytes
    db.add(scene)
    db.commit()
    db.refresh(scene)
    return scene, a, b


def _activate(slug: str, version_id, expected):
    return client.post(
        f"/api/v1/scenes/{slug}/versions/{version_id}/activate",
        headers=H,
        json={"expectedCurrentVersionId": str(expected) if expected else None},
    )


def _runtime(slug: str) -> dict:
    response = client.get(f"/api/v1/scenes/{slug}/runtime", headers=H)
    assert response.status_code == 200, response.text
    return response.json()


def _save_camera(slug: str, position: dict, target: dict, fov: float = 55.0):
    response = client.patch(
        f"/api/v1/scenes/{slug}/presentation",
        headers=H,
        json={
            "initialCameraPosition": position,
            "initialCameraTarget": target,
            "initialCameraFov": fov,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _create_viewpoint(slug: str, name: str, position: dict, target: dict) -> dict:
    response = client.post(
        f"/api/v1/scenes/{slug}/viewpoints",
        headers=H,
        json={"name": name, "position": position, "target": target, "fov": 50.0},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _create_annotation(slug: str, title: str, anchor: dict) -> dict:
    response = client.post(
        f"/api/v1/scenes/{slug}/annotations",
        headers=H,
        json={
            "title": title,
            "description": "说明",
            "anchorX": anchor["x"],
            "anchorY": anchor["y"],
            "anchorZ": anchor["z"],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


class TestSpatialReauthoringClosure:
    def test_scene_without_current_version_serves_no_unbound_rows(
        self, db, isolated_roots
    ):
        """Safety edge: no current version must never re-enable legacy rows.

        ``NULL == NULL`` would otherwise look like "bound", which would serve
        every legacy (never confirmed) viewpoint/annotation on a scene whose
        current pointer was cleared.
        """
        scene, a, _b = _scene_with_versions(db)
        _save_camera(scene.slug, CAM_A, TGT_A)
        vp = _create_viewpoint(scene.slug, "旧观察点", CAM_A, TGT_A)
        ann = _create_annotation(scene.slug, "旧标注", {"x": 0.5, "y": 1.0, "z": 0.5})
        # Simulate pre-GS-NEXT-12 rows: author data with no version binding.
        pres = (
            db.query(ScenePresentation)
            .filter(ScenePresentation.scene_id == scene.id)
            .one()
        )
        pres.initial_camera_version_id = None
        db.get(SceneViewpoint, uuid.UUID(vp["id"])).source_version_id = None
        db.get(SceneAnnotation, uuid.UUID(ann["id"])).source_version_id = None
        db.add(
            SceneSpatialState(
                scene_id=scene.id,
                source_version_id=a.id,
                state="STALE",
                stale_at=datetime.now(UTC),
            )
        )
        scene.current_version_id = None
        db.commit()

        descriptor = _runtime(scene.slug)
        assert descriptor["viewpoints"] == []
        assert descriptor["annotations"] == []
        assert descriptor["presentation"]["initialCamera"].get("position") is None

        listing = client.get(f"/api/v1/scenes/{scene.slug}/versions", headers=H).json()
        assert "viewpoints" in listing["spatial"]["pendingFeatures"]
        assert "annotations" in listing["spatial"]["pendingFeatures"]
        assert "initialCamera" in listing["spatial"]["pendingFeatures"]
        assert listing["spatial"]["confirmedFeatures"] == []
    def test_resaved_initial_camera_is_served_on_the_new_version(self, db, isolated_roots):
        """The P1: A → B → re-save B's camera → descriptor adopts it."""
        scene, a, b = _scene_with_versions(db)

        # Author on A.
        _save_camera(scene.slug, CAM_A, TGT_A)
        _create_viewpoint(scene.slug, "A 入口", CAM_A, TGT_A)
        _create_annotation(scene.slug, "A 标注", {"x": 0.5, "y": 1.0, "z": 0.5})

        before = _runtime(scene.slug)
        assert before["presentation"]["initialCamera"]["position"]["z"] == 9.0
        assert len(before["viewpoints"]) == 1
        assert len(before["annotations"]) == 1

        # Switch A → B: the old spatial authoring is conservatively disabled.
        switched = _activate(scene.slug, b.id, a.id)
        assert switched.status_code == 200, switched.text
        after_switch = _runtime(scene.slug)
        assert after_switch["presentation"]["initialCamera"].get("position") is None
        assert after_switch["viewpoints"] == []
        assert after_switch["annotations"] == []

        # Re-author ONLY the initial camera on B.
        _save_camera(scene.slug, CAM_B, TGT_B, fov=63.0)

        after = _runtime(scene.slug)
        assert after["presentation"]["initialCamera"]["position"] == CAM_B
        assert after["presentation"]["initialCamera"]["target"] == TGT_B
        assert after["presentation"]["initialCamera"]["fov"] == 63.0
        # Old A viewpoints / annotations are NOT re-enabled by this.
        assert after["viewpoints"] == []
        assert after["annotations"] == []

        # Nothing was deleted from the database.
        db.expire_all()
        assert db.query(SceneViewpoint).filter_by(scene_id=scene.id).count() == 1
        assert db.query(SceneAnnotation).filter_by(scene_id=scene.id).count() == 1

        # The list API tells the owner exactly what is still pending.
        listing = client.get(f"/api/v1/scenes/{scene.slug}/versions", headers=H).json()
        assert listing["spatial"]["state"] == "STALE"
        assert listing["spatial"]["requiresConfirmation"] is True
        assert "initialCamera" not in listing["spatial"]["pendingFeatures"]
        assert "initialCamera" in listing["spatial"]["confirmedFeatures"]
        assert set(listing["spatial"]["pendingFeatures"]) >= {"viewpoints", "annotations"}

        # Re-loading the descriptor (page reload / XR diagnostics) is stable.
        reloaded = _runtime(scene.slug)
        assert reloaded["presentation"]["initialCamera"]["position"] == CAM_B
        assert reloaded["viewpoints"] == []

    def test_recreated_records_bind_to_current_version_only(self, db, isolated_roots):
        scene, a, b = _scene_with_versions(db)
        old_vp = _create_viewpoint(scene.slug, "A 视点", CAM_A, TGT_A)
        _create_annotation(scene.slug, "A 标注", {"x": 1.0, "y": 2.0, "z": 3.0})
        assert _activate(scene.slug, b.id, a.id).status_code == 200

        new_vp = _create_viewpoint(scene.slug, "B 视点", CAM_B, TGT_B)
        new_ann = _create_annotation(scene.slug, "B 标注", {"x": -1.0, "y": 0.2, "z": 0.7})

        descriptor = _runtime(scene.slug)
        assert [vp["id"] for vp in descriptor["viewpoints"]] == [new_vp["id"]]
        assert [ann["id"] for ann in descriptor["annotations"]] == [new_ann["id"]]

        # An explicit pose edit of the OLD viewpoint re-confirms it for B.
        edited = client.patch(
            f"/api/v1/scenes/{scene.slug}/viewpoints/{old_vp['id']}",
            headers=H,
            json={"position": CAM_B, "target": TGT_B, "fov": 48.0},
        )
        assert edited.status_code == 200, edited.text
        descriptor = _runtime(scene.slug)
        assert {vp["id"] for vp in descriptor["viewpoints"]} == {
            new_vp["id"],
            old_vp["id"],
        }

        # Renaming alone is not a spatial confirmation: clear the B viewpoint's
        # binding, rename it, and verify it stays unconfirmed.
        db.expire_all()
        db.query(SceneViewpoint).filter_by(id=uuid.UUID(new_vp["id"])).update(
            {"source_version_id": None}
        )
        db.commit()
        renamed = client.patch(
            f"/api/v1/scenes/{scene.slug}/viewpoints/{new_vp['id']}",
            headers=H,
            json={"name": "改名"},
        )
        assert renamed.status_code == 200, renamed.text
        db.expire_all()
        row = db.get(SceneViewpoint, uuid.UUID(new_vp["id"]))
        assert row.source_version_id is None
        assert [vp["id"] for vp in _runtime(scene.slug)["viewpoints"]] == [old_vp["id"]]


    def test_saving_camera_never_restores_transform_or_collision(self, db, isolated_roots):
        scene, a, b = _scene_with_versions(db)
        _save_camera(scene.slug, CAM_A, TGT_A)
        # World transform + a succeeded collision authored on A.
        response = client.patch(
            f"/api/v1/scenes/{scene.slug}/presentation",
            headers=H,
            json={"worldScale": {"x": 2.0, "y": 2.0, "z": 2.0}},
        )
        assert response.status_code == 200, response.text
        coll = CollisionAsset(
            scene_id=scene.id,
            mode="INDOOR",
            status="SUCCEEDED",
            build_params={"sourceVersion": a.asset_version, "spatialRevision": 0},
        )
        db.add(coll)
        db.flush()
        asset = Asset(
            scene_id=scene.id,
            version_id=a.id,
            kind="COLLISION_GLB",
            storage_key="private/collision.glb",
            mime_type="model/gltf-binary",
            byte_size=1,
            sha256="0" * 64,
            metadata_={},
        )
        db.add(asset)
        db.flush()
        coll.asset_id = asset.id
        db.commit()

        assert _activate(scene.slug, b.id, a.id).status_code == 200
        _save_camera(scene.slug, CAM_B, TGT_B)

        descriptor = _runtime(scene.slug)
        assert descriptor["presentation"]["initialCamera"]["position"] == CAM_B
        # World transform was NOT re-saved → stays disabled.
        assert descriptor["presentation"]["worldTransform"].get("scale") is None
        # Collision was NOT rebuilt → stays disabled/stale.
        if descriptor.get("collision"):
            assert descriptor["collision"]["enabled"] is False
            assert descriptor["collision"]["stale"] is True
            assert descriptor["collision"]["url"] is None


    def test_b_rows_do_not_survive_switching_back_to_a(self, db, isolated_roots):
        scene, a, b = _scene_with_versions(db)
        assert _activate(scene.slug, b.id, a.id).status_code == 200
        vp_b = _create_viewpoint(scene.slug, "B 视点", CAM_B, TGT_B)
        assert [v["id"] for v in _runtime(scene.slug)["viewpoints"]] == [vp_b["id"]]

        assert _activate(scene.slug, a.id, b.id).status_code == 200
        descriptor = _runtime(scene.slug)
        # B-bound data is not current anymore; A has no confirmed data.
        assert descriptor["viewpoints"] == []
        assert descriptor["presentation"]["initialCamera"].get("position") is None

        # Switching back to B again makes the B-bound record visible again —
        # the bytes are identical (immutable version), so this is version-safe.
        assert _activate(scene.slug, b.id, a.id).status_code == 200
        assert [v["id"] for v in _runtime(scene.slug)["viewpoints"]] == [vp_b["id"]]

    def test_legacy_unbound_rows_stay_disabled_after_round_trip(self, db, isolated_roots):
        """Rows authored before this feature (NULL binding) must not resurrect."""
        scene, a, b = _scene_with_versions(db)
        db.add_all(
            [
                SceneViewpoint(
                    scene_id=scene.id,
                    name="存量视点",
                    position=CAM_A,
                    target=TGT_A,
                    fov=50.0,
                    enabled=True,
                ),
                SceneAnnotation(
                    scene_id=scene.id,
                    title="存量标注",
                    anchor_x=0.1,
                    anchor_y=0.2,
                    anchor_z=0.3,
                    enabled=True,
                ),
                ScenePresentation(scene_id=scene.id),
            ]
        )
        db.commit()
        # The pre-migration active scene serves them (no spatial state row).
        assert len(_runtime(scene.slug)["viewpoints"]) == 1

        assert _activate(scene.slug, b.id, a.id).status_code == 200
        assert _activate(scene.slug, a.id, b.id).status_code == 200
        descriptor = _runtime(scene.slug)
        assert descriptor["viewpoints"] == []
        assert descriptor["annotations"] == []

    def test_collision_revision_gate(self, db, isolated_roots):
        """A collision built before a switch is never re-enabled by A→B→A."""
        scene, a, b = _scene_with_versions(db)
        coll = CollisionAsset(
            scene_id=scene.id,
            mode="INDOOR",
            status="SUCCEEDED",
            build_params={"sourceVersion": a.asset_version, "spatialRevision": 0},
        )
        db.add(coll)
        db.flush()
        asset = Asset(
            scene_id=scene.id,
            version_id=a.id,
            kind="COLLISION_GLB",
            storage_key="private/collision.glb",
            mime_type="model/gltf-binary",
            byte_size=1,
            sha256="0" * 64,
            metadata_={},
        )
        db.add(asset)
        db.flush()
        coll.asset_id = asset.id
        db.add(ScenePresentation(scene_id=scene.id, collision_enabled=True))
        db.add(
            SceneProcessingSettings(
                scene_id=scene.id,
                calibration_state="VERIFIED",
                meters_per_scene_unit=1.0,
                reference_method="MEASURED_DISTANCE",
                reference_value=4.2,
                calibration_source_version=a.asset_version,
                calibration_transform_identity="identity",
                calibration_evidence={
                    "provenance": "test",
                    "verifiedBy": "gsnext12-test",
                    "evidenceSha256": "a" * 64,
                },
            )
        )
        db.commit()

        # Never invalidated → the collision is exposed.
        before = _runtime(scene.slug)
        assert before["collision"] is not None
        assert before["collision"]["url"] is not None

        assert _activate(scene.slug, b.id, a.id).status_code == 200
        after_switch = _runtime(scene.slug)
        assert after_switch["collision"]["url"] is None
        assert after_switch["collision"]["stale"] is True

        # A→B→A must not resurrect it.
        assert _activate(scene.slug, a.id, b.id).status_code == 200
        after_round_trip = _runtime(scene.slug)
        assert after_round_trip["collision"]["url"] is None
        assert after_round_trip["collision"]["enabled"] is False

        # An explicit rebuild pinned to the new revision is served again.
        db.expire_all()
        row = db.query(CollisionAsset).filter_by(scene_id=scene.id).one()
        rev = db.get(SceneSpatialState, scene.id).revision
        row.build_params = {**(row.build_params or {}), "spatialRevision": rev}
        db.commit()
        rebuilt = _runtime(scene.slug)
        assert rebuilt["collision"]["url"] is not None
        assert rebuilt["collision"]["stale"] is False
