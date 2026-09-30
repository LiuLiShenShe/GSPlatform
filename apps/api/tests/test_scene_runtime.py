"""SSV-01 — SceneRuntimeDescriptorV1 endpoint tests.

Covers: existing scene → 200, not found → 404, SOG / PLY / lod-meta formats,
presentation serialization, annotations serialization, collision null /
populated, authorization (public / private owner / private other / anon 401).
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _make_scene(db, *, slug=None, status="PUBLISHED", visibility="PUBLIC", owner_id=None):
    """Create a scene without a current version (for full control)."""
    from app.core.config import settings
    from app.core.identity import _resolve_dev_user_id
    from app.db.models.scene import Scene

    scene = Scene(
        owner_id=owner_id or _resolve_dev_user_id(settings),
        slug=slug or f"rt-{uuid.uuid4().hex[:8]}",
        title="运行时测试场景",
        description="runtime contract test",
        category="experiment",
        visibility=visibility,
        status=status,
        views=0,
        likes=0,
    )
    db.add(scene)
    db.flush()
    db.commit()
    db.refresh(scene)
    return scene


def _attach_version(db, scene, *, fmt, manifest):
    """Attach a current version to the scene and commit."""
    from app.db.models.scene import SceneVersion

    version = SceneVersion(
        scene_id=scene.id,
        asset_version=uuid.uuid4().hex[:40],
        format=fmt,
        size_bytes=1024,
        manifest=manifest,
    )
    db.add(version)
    db.flush()
    scene.current_version_id = version.id
    db.commit()
    db.refresh(scene)
    return version


def _get(slug_or_id: str):
    return client.get(f"/api/v1/scenes/{slug_or_id}/runtime")


# ─── 1. existing scene → 200 ────────────────────────────────────────────────
class TestBasic:
    def test_existing_public_scene_returns_200(self, public_scene):
        resp = _get(public_scene.slug)
        assert resp.status_code == 200
        body = resp.json()
        assert body["schemaVersion"] == 1
        assert body["scene"]["id"] == public_scene.slug
        assert body["scene"]["name"] == "测试场景"
        assert (
            body["scene"]["posterUrl"]
            == f"/api/v1/scenes/{public_scene.slug}/assets/poster.webp"
        )
        # default fixture version is streamed-sog without entryUrl → lod-meta
        # fallback. FIX-05 §8：优先不可变版本化 URL（versions/<asset_version>/）
        # —— current 是可重指向别名，只用于无法获得版本段时兜底。
        expected_url = (
            f"/api/v1/scenes/{public_scene.slug}/assets/versions/"
            f"{public_scene.current_version.asset_version}/lod-meta.json"
        )
        assert body["content"]["url"] == expected_url
        assert body["content"]["format"] == "lod-meta"

    def test_not_found_returns_404(self):
        resp = _get("no-such-scene-xyz")
        assert resp.status_code == 404

    def test_content_null_when_no_version(self, db):
        scene = _make_scene(db, status="DRAFT", visibility="PRIVATE")
        resp = _get(scene.slug)
        assert resp.status_code == 200
        assert resp.json()["content"]["url"] is None
        assert resp.json()["content"]["format"] is None


# ─── 3-5. content formats ──────────────────────────────────────────────────
class TestContentFormats:
    def test_sog_format(self, db):
        from tests.conftest_scenes import create_scene

        scene = create_scene(session=db, with_version=False)
        _attach_version(
            db,
            scene,
            fmt="sog",
            manifest={"format": "sog", "assetUrl": f"/local-scenes/{scene.slug}/scene.sog"},
        )
        body = _get(scene.slug).json()
        # FIX-01: a legacy absolute /local-scenes/ reference must NOT survive —
        # it is re-homed through the authorized /assets endpoint so the
        # descriptor never emits an unauthenticated gaussian URL.
        assert body["content"]["url"] == f"/api/v1/scenes/{scene.slug}/assets/scene.sog"
        assert body["content"]["format"] == "sog"

    def test_ply_format_relative_asset_url(self, db):
        from tests.conftest_scenes import create_scene

        scene = create_scene(session=db, with_version=False)
        _attach_version(
            db,
            scene,
            fmt="ply",
            manifest={"format": "ply", "assetUrl": "./model.ply"},
        )
        body = _get(scene.slug).json()
        assert body["content"]["url"] == f"/api/v1/scenes/{scene.slug}/assets/model.ply"
        assert body["content"]["format"] == "ply"

    def test_lod_meta_format_streamed_entry(self, db):
        from tests.conftest_scenes import create_scene

        scene = create_scene(session=db, with_version=False)
        _attach_version(
            db,
            scene,
            fmt="streamed-sog",
            manifest={
                "format": "streamed-sog",
                "schemaVersion": 1,  # must NOT influence the format decision
                "stream": {
                    "entryUrl": f"versions/{uuid.uuid4().hex[:8]}/lod-meta.json",
                    "counts": [179, 536, 1788],
                },
            },
        )
        body = _get(scene.slug).json()
        assert body["content"]["format"] == "lod-meta"
        assert body["content"]["url"].endswith("/lod-meta.json")
        assert body["content"]["url"].startswith(f"/api/v1/scenes/{scene.slug}/assets/versions/")

    def test_compressed_ply_extension_recognised(self):
        from app.services.scene_runtime import content_format_from_filename

        assert content_format_from_filename("model.compressed.ply") == "compressed-ply"
        assert content_format_from_filename("model.lod-meta.json") == "lod-meta"
        assert content_format_from_filename("chunk.meta.json") == "meta"
        assert content_format_from_filename("scene.sog") == "sog"
        assert content_format_from_filename("scene.ply") == "ply"
        assert content_format_from_filename("scene.jpg") is None


# ─── 6. presentation serialization ─────────────────────────────────────────
class TestPresentation:
    def test_presentation_serialized_from_db(self, db, public_scene):
        from app.db.models.asset import Asset
        from app.db.models.scene_presentation import ScenePresentation

        bg_asset = Asset(
            scene_id=public_scene.id,
            kind="SOURCE",
            storage_key=f"presentation/{public_scene.id}/bg.jpg",
            mime_type="image/jpeg",
            byte_size=2048,
        )
        db.add(bg_asset)
        db.flush()
        db.add(
            ScenePresentation(
                scene_id=public_scene.id,
                world_position={"x": 1.0, "y": 2.0, "z": 3.0},
                world_rotation={"x": 0.0, "y": 0.0, "z": 0.0},
                world_scale={"x": 1.0, "y": 1.0, "z": 1.0},
                initial_camera_position={"x": 0.0, "y": 1.2, "z": 3.5},
                initial_camera_target={"x": 0.0, "y": 0.8, "z": 0.0},
                initial_camera_fov=55.0,
                background_type="equirectangular",
                background_color={"x": 0.1, "y": 0.2, "z": 0.3},
                background_asset_id=bg_asset.id,
            )
        )
        db.commit()
        body = _get(public_scene.slug).json()
        pres = body["presentation"]
        assert pres["worldTransform"]["position"] == {"x": 1.0, "y": 2.0, "z": 3.0}
        assert pres["worldTransform"]["scale"] == {"x": 1.0, "y": 1.0, "z": 1.0}
        assert pres["initialCamera"]["fov"] == 55.0
        assert pres["initialCamera"]["position"]["z"] == 3.5
        assert pres["background"]["type"] == "equirectangular"
        assert pres["background"]["color"] == {"x": 0.1, "y": 0.2, "z": 0.3}
        assert pres["background"]["url"] == (
            f"/api/v1/scenes/{public_scene.slug}/presentation/background"
        )

    def test_presentation_defaults_when_no_row(self, public_scene):
        body = _get(public_scene.slug).json()
        pres = body["presentation"]
        assert pres["worldTransform"]["position"] is None
        assert pres["initialCamera"]["position"] is None
        assert pres["background"]["type"] == "color"
        assert pres["background"]["url"] is None


# ─── 6b. experience settings v2 (SSV-05) ───────────────────────────────────
class TestExperienceSettings:
    def test_old_scene_without_settings_returns_official_defaults(self, public_scene):
        """A scene that never authored experience settings must still expose
        legal defaults (never break the runtime contract)."""
        pres = _get(public_scene.slug).json()["presentation"]
        assert pres["tonemapping"] == "aces"
        assert pres["highPrecisionRendering"] is False
        assert pres["postEffects"] is None

    def test_settings_serialized_from_db(self, db, public_scene):
        from app.db.models.scene_presentation import ScenePresentation

        db.add(
            ScenePresentation(
                scene_id=public_scene.id,
                tonemapping="neutral",
                high_precision_rendering=True,
                post_effects={
                    "sharpness": {"enabled": True, "amount": 0.6},
                    "bloom": {"enabled": True, "intensity": 0.02, "blurLevel": 3},
                    "grading": {"enabled": False, "brightness": 1.0},
                    "vignette": {"enabled": True, "intensity": 0.4},
                    "fringing": {"enabled": False, "intensity": 0.1},
                },
            )
        )
        db.commit()

        pres = _get(public_scene.slug).json()["presentation"]
        assert pres["tonemapping"] == "neutral"
        assert pres["highPrecisionRendering"] is True
        fx = pres["postEffects"]
        assert fx["sharpness"] == {"enabled": True, "amount": 0.6}
        assert fx["bloom"] == {"enabled": True, "intensity": 0.02, "blurLevel": 3.0}
        assert fx["fringing"] == {"enabled": False, "intensity": 0.1}
        # Missing fields in a partially authored doc are filled with the
        # official defaults so the result always validates.
        assert fx["grading"]["contrast"] == 1.0
        assert fx["vignette"]["outer"] == 0.75

    def test_partial_post_effects_document_is_normalized(self, db, public_scene):
        from app.db.models.scene_presentation import ScenePresentation

        db.add(
            ScenePresentation(
                scene_id=public_scene.id,
                post_effects={"vignette": {"enabled": True}},  # only one key
            )
        )
        db.commit()

        fx = _get(public_scene.slug).json()["presentation"]["postEffects"]
        assert set(fx) == {
            "sharpness",
            "bloom",
            "grading",
            "vignette",
            "fringing",
        }
        assert fx["vignette"]["enabled"] is True
        assert fx["vignette"]["intensity"] == 0.5
        assert fx["sharpness"]["enabled"] is False

    def test_settings_survive_save_and_reload(self, db, public_scene):
        """PATCH presentation → runtime descriptor reflects the saved values."""
        resp = client.patch(
            f"/api/v1/scenes/{public_scene.slug}/presentation",
            json={
                "tonemapping": "hejl",
                "highPrecisionRendering": True,
                "postEffects": {"bloom": {"enabled": True, "intensity": 0.05}},
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["tonemapping"] == "hejl"
        assert body["highPrecisionRendering"] is True

        pres = _get(public_scene.slug).json()["presentation"]
        assert pres["tonemapping"] == "hejl"
        assert pres["highPrecisionRendering"] is True
        assert pres["postEffects"]["bloom"]["enabled"] is True
        assert pres["postEffects"]["bloom"]["intensity"] == 0.05

    def test_invalid_tonemapping_rejected(self, public_scene):
        resp = client.patch(
            f"/api/v1/scenes/{public_scene.slug}/presentation",
            json={"tonemapping": "not-a-curve"},
        )
        assert resp.status_code == 422

    def test_post_effect_out_of_range_rejected(self, public_scene):
        resp = client.patch(
            f"/api/v1/scenes/{public_scene.slug}/presentation",
            json={"postEffects": {"sharpness": {"enabled": True, "amount": 99}}},
        )
        assert resp.status_code == 422


# ─── 7. annotations serialization ──────────────────────────────────────────
class TestAnnotations:
    def test_annotations_serialized_from_db(self, db, public_scene):
        from app.db.models.scene_annotation import SceneAnnotation

        db.add_all(
            [
                SceneAnnotation(
                    scene_id=public_scene.id,
                    title="入口",
                    description="大门",
                    anchor_x=1.0,
                    anchor_y=2.0,
                    anchor_z=3.0,
                    style="LEADER_TEXT",
                    content_type="TEXT",
                    text_content="正门",
                    text_color="#00FF00",
                    text_size=18,
                    fov=60.0,
                    order_index=0,
                    enabled=True,
                ),
                SceneAnnotation(
                    scene_id=public_scene.id,
                    title="水井",
                    anchor_x=-1.0,
                    anchor_y=0.0,
                    anchor_z=0.0,
                    style="NUMBER_POPUP",
                    content_type="IMAGE",
                    order_index=1,
                    enabled=True,
                ),
            ]
        )
        db.commit()
        body = _get(public_scene.slug).json()
        annotations = body["annotations"]
        assert len(annotations) == 2
        first = annotations[0]
        assert first["title"] == "入口"
        assert first["anchor"] == {"x": 1.0, "y": 2.0, "z": 3.0}
        assert first["style"] == "LEADER_TEXT"
        assert first["contentType"] == "TEXT"
        assert first["textContent"] == "正门"
        assert first["mediaAssetUrl"] is None  # media serving wired in SSV-06
        assert first["textColor"] == "#00FF00"
        assert first["orderIndex"] == 0
        assert annotations[1]["contentType"] == "IMAGE"
        assert annotations[1]["orderIndex"] == 1

    def test_annotations_empty_default(self, public_scene):
        assert _get(public_scene.slug).json()["annotations"] == []


# ─── FIX-02. per-annotation camera（作者拾取时保存的相机 pose）────────────
class TestAnnotationCamera:
    """FIX-02 §12-§15 — 每条标注有自己的相机；runtime 描述符逐条透出。"""

    @staticmethod
    def _create(slug: str, **camera) -> dict:
        payload = {"title": "标注", "anchorX": 1.0, "anchorY": 2.0, "anchorZ": 3.0}
        if "cameraPosition" in camera:
            payload["cameraPosition"] = camera["cameraPosition"]
        if "cameraTarget" in camera:
            payload["cameraTarget"] = camera["cameraTarget"]
        if "cameraFov" in camera:
            payload["cameraFov"] = camera["cameraFov"]
        resp = client.post(f"/api/v1/scenes/{slug}/annotations", json=payload)
        assert resp.status_code == 201, resp.text
        return resp.json()

    def test_create_persists_camera_pose(self, public_scene):
        ann = self._create(
            public_scene.slug,
            cameraPosition={"x": 1.5, "y": 2.5, "z": 3.5},
            cameraTarget={"x": 0.0, "y": 0.5, "z": -1.0},
            cameraFov=42.0,
        )
        assert ann["cameraPosition"] == {"x": 1.5, "y": 2.5, "z": 3.5}
        assert ann["cameraTarget"] == {"x": 0.0, "y": 0.5, "z": -1.0}
        assert ann["cameraFov"] == 42.0
        # list 端点同样回显（作者面板二次读取不失真）。
        listed = client.get(f"/api/v1/scenes/{public_scene.slug}/annotations").json()
        found = next(a for a in listed if a["id"] == ann["id"])
        assert found["cameraPosition"] == {"x": 1.5, "y": 2.5, "z": 3.5}
        assert found["cameraFov"] == 42.0

    def test_create_without_camera_emits_null(self, public_scene):
        ann = self._create(public_scene.slug)
        assert ann["cameraPosition"] is None
        assert ann["cameraTarget"] is None
        assert ann["cameraFov"] is None

    def test_update_camera_pose(self, public_scene):
        ann = self._create(public_scene.slug)
        resp = client.patch(
            f"/api/v1/scenes/{public_scene.slug}/annotations/{ann['id']}",
            json={
                "cameraPosition": {"x": -2.0, "y": 1.0, "z": 0.5},
                "cameraTarget": {"x": 0.0, "y": 0.0, "z": 0.0},
                "cameraFov": 38.0,
            },
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["cameraPosition"] == {"x": -2.0, "y": 1.0, "z": 0.5}
        assert body["cameraFov"] == 38.0

    def test_runtime_descriptor_emits_three_distinct_cameras(self, public_scene):
        """§15 —— 3 条标注位于不同位置、相机明显不同 → runtime 逐条透出。"""
        poses = [
            ({"x": 1.0, "y": 1.0, "z": 1.0}, {"x": 0.0, "y": 1.0, "z": 0.0}, 40.0),
            ({"x": 2.0, "y": 2.0, "z": 2.0}, {"x": 0.0, "y": 1.0, "z": -1.0}, 50.0),
            ({"x": 3.0, "y": 0.0, "z": 3.0}, {"x": 0.0, "y": 1.0, "z": 1.0}, 60.0),
        ]
        for i, (pos, target, fov) in enumerate(poses):
            self._create(
                public_scene.slug,
                cameraPosition=pos,
                cameraTarget=target,
                cameraFov=fov,
            )
            assert i < 3  # 三条全部创建
        annotations = _get(public_scene.slug).json()["annotations"]
        assert len(annotations) == 3
        # 逐条 camera 独立：3 组互不相同（无共享 settings.cameras[0] 的情况）。
        positions = {tuple(a["cameraPosition"].values()) for a in annotations}
        targets = {tuple(a["cameraTarget"].values()) for a in annotations}
        fovs = {a["cameraFov"] for a in annotations}
        assert len(positions) == 3
        assert len(targets) == 3
        assert len(fovs) == 3

    def test_runtime_descriptor_marks_unauthored_camera_null(self, public_scene):
        self._create(public_scene.slug)
        ann = _get(public_scene.slug).json()["annotations"][0]
        assert ann["cameraPosition"] is None
        assert ann["cameraTarget"] is None
        assert ann["cameraFov"] is None


# ─── SSV-06. annotation media upload / serve ────────────────────────────────
class TestAnnotationMedia:
    """SSV-06 — per-annotation media upload, replace, MIME gate, serve."""

    @staticmethod
    def _create(slug: str, *, content_type: str) -> dict:
        resp = client.post(
            f"/api/v1/scenes/{slug}/annotations",
            json={
                "title": "媒体标注",
                "anchorX": 1.0,
                "anchorY": 2.0,
                "anchorZ": 3.0,
                "contentType": content_type,
            },
        )
        assert resp.status_code == 201
        return resp.json()

    def test_upload_and_serve_image_media(self, db, public_scene):
        ann = self._create(public_scene.slug, content_type="IMAGE")
        media = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
        resp = client.post(
            f"/api/v1/scenes/{public_scene.slug}/annotations/{ann['id']}/media",
            files={"file": ("shot.png", media, "image/png")},
        )
        assert resp.status_code == 200
        assert resp.json()["mediaAssetId"] is not None

        descriptor = _get(public_scene.slug).json()
        runtime_ann = descriptor["annotations"][0]
        assert runtime_ann["mediaAssetUrl"] == (
            f"/api/v1/scenes/{public_scene.slug}/annotations/{ann['id']}/media"
        )
        serve = client.get(runtime_ann["mediaAssetUrl"])
        assert serve.status_code == 200
        assert serve.content == media
        assert serve.headers["content-type"] == "image/png"

    def test_upload_replaces_previous_asset(self, db, public_scene):
        ann = self._create(public_scene.slug, content_type="AUDIO")
        r1 = client.post(
            f"/api/v1/scenes/{public_scene.slug}/annotations/{ann['id']}/media",
            files={"file": ("a.wav", b"\xff\xf3" + b"\x01" * 32, "audio/wav")},
        )
        assert r1.status_code == 200
        second = b"\xff\xf3" + b"\x02" * 32
        r2 = client.post(
            f"/api/v1/scenes/{public_scene.slug}/annotations/{ann['id']}/media",
            files={"file": ("b.wav", second, "audio/wav")},
        )
        assert r2.status_code == 200
        assert r2.json()["mediaAssetId"] != r1.json()["mediaAssetId"]
        serve = client.get(
            f"/api/v1/scenes/{public_scene.slug}/annotations/{ann['id']}/media"
        )
        assert serve.status_code == 200
        assert serve.content == second

    def test_video_media_accepted(self, db, public_scene):
        ann = self._create(public_scene.slug, content_type="VIDEO")
        media = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64
        resp = client.post(
            f"/api/v1/scenes/{public_scene.slug}/annotations/{ann['id']}/media",
            files={"file": ("clip.mp4", media, "video/mp4")},
        )
        assert resp.status_code == 200
        assert resp.json()["mediaAssetId"] is not None

    def test_mime_mismatch_rejected(self, db, public_scene):
        ann = self._create(public_scene.slug, content_type="IMAGE")
        resp = client.post(
            f"/api/v1/scenes/{public_scene.slug}/annotations/{ann['id']}/media",
            files={"file": ("song.mp3", b"\xff\xf3" * 16, "audio/mpeg")},
        )
        assert resp.status_code == 409

    def test_text_annotation_media_rejected(self, db, public_scene):
        ann = self._create(public_scene.slug, content_type="TEXT")
        resp = client.post(
            f"/api/v1/scenes/{public_scene.slug}/annotations/{ann['id']}/media",
            files={"file": ("pic.png", b"png-bytes", "image/png")},
        )
        assert resp.status_code == 409

    def test_oversized_media_rejected(self, db, public_scene):
        ann = self._create(public_scene.slug, content_type="IMAGE")
        resp = client.post(
            f"/api/v1/scenes/{public_scene.slug}/annotations/{ann['id']}/media",
            files={"file": ("big.png", b"\x00" * (50 * 1024 * 1024 + 1), "image/png")},
        )
        assert resp.status_code == 422

    def test_serve_404_without_media(self, db, public_scene):
        ann = self._create(public_scene.slug, content_type="PANORAMA")
        resp = client.get(
            f"/api/v1/scenes/{public_scene.slug}/annotations/{ann['id']}/media"
        )
        assert resp.status_code == 404


# ─── 8-9. collision ─────────────────────────────────────────────────────────
class TestCollision:
    def test_collision_null_by_default(self, public_scene):
        assert _get(public_scene.slug).json()["collision"] is None

    def test_collision_populated(self, db, public_scene):
        from app.db.models.asset import Asset
        from app.db.models.collision_asset import CollisionAsset
        from app.db.models.scene_presentation import ScenePresentation

        asset = Asset(
            scene_id=public_scene.id,
            kind="COLLISION_GLB",
            storage_key=f"collision/{public_scene.id}/collision.glb",
            mime_type="model/gltf-binary",
            byte_size=1024,
        )
        db.add(asset)
        db.flush()
        db.add(
            CollisionAsset(
                scene_id=public_scene.id,
                mode="OUTDOOR",
                asset_id=asset.id,
                status="SUCCEEDED",
                gravity=9.81,
                slope_limit_degrees=45.0,
                step_offset=0.3,
                player_height=1.8,
            )
        )
        db.add(
            ScenePresentation(
                scene_id=public_scene.id, collision_enabled=True
            )
        )
        db.commit()

        body = _get(public_scene.slug).json()
        collision = body["collision"]
        assert collision is not None
        # SSV-07: the url must end in .glb so the official viewer routes it to
        # its mesh loader (it decides mesh-vs-voxel by url extension).
        assert collision["url"] == f"/api/v1/scenes/{public_scene.slug}/collision/collision.glb"
        assert collision["format"] == "glb"
        assert collision["mode"] == "OUTDOOR"
        assert collision["gravity"] == 9.81
        assert collision["slopeLimitDegrees"] == 45.0
        assert collision["stepOffset"] == 0.3
        assert collision["playerHeight"] == 1.8
        assert collision["enabled"] is True

    def test_collision_prefers_voxel(self, db, public_scene):
        """SSV-07: when both artifacts exist, the voxel octree is preferred and
        the url ends in .voxel.json (official VoxelCollision loader derives the
        .bin url by string replace)."""
        from app.db.models.asset import Asset
        from app.db.models.collision_asset import CollisionAsset

        glb = Asset(
            scene_id=public_scene.id,
            kind="COLLISION_GLB",
            storage_key=f"collision/{public_scene.id}/collision.glb",
            mime_type="model/gltf-binary",
            byte_size=1024,
        )
        voxel = Asset(
            scene_id=public_scene.id,
            kind="COLLISION_VOXEL",
            storage_key=f"collision/{public_scene.id}/collision.voxel.json",
            mime_type="application/json",
            byte_size=618,
            metadata_={"binStorageKey": f"collision/{public_scene.id}/collision.voxel.bin"},
        )
        db.add_all([glb, voxel])
        db.flush()
        db.add(
            CollisionAsset(
                scene_id=public_scene.id,
                mode="INDOOR",
                asset_id=voxel.id,
                status="SUCCEEDED",
            )
        )
        db.commit()

        collision = _get(public_scene.slug).json()["collision"]
        assert collision is not None
        assert collision["format"] == "voxel"
        assert collision["url"] == (
            f"/api/v1/scenes/{public_scene.slug}/collision/collision.voxel.json"
        )
        assert collision["mode"] == "INDOOR"

    def test_collision_not_succeeded_is_null(self, db, public_scene):
        """SSV-07: descriptor stays null unless status == SUCCEEDED (an empty /
        placeholder indoor GLB from the old builders must not leak)."""
        from app.db.models.asset import Asset
        from app.db.models.collision_asset import CollisionAsset

        asset = Asset(
            scene_id=public_scene.id,
            kind="COLLISION_GLB",
            storage_key=f"collision/{public_scene.id}/collision.glb",
            mime_type="model/gltf-binary",
            byte_size=0,
        )
        db.add(asset)
        db.flush()
        db.add(
            CollisionAsset(
                scene_id=public_scene.id,
                mode="INDOOR",
                asset_id=asset.id,
                status="FAILED",
            )
        )
        db.commit()

        assert _get(public_scene.slug).json()["collision"] is None


class TestCollisionServe:
    """SSV-07 — the runtime descriptor url is served with the official
    extension the viewer routes on (.glb → mesh, .voxel.json → voxel)."""

    @staticmethod
    def _write(rel: str, data: bytes) -> None:
        from app.core.config import settings
        from app.storage import LocalDiskStorage

        LocalDiskStorage(settings.storage_root).write(rel, data)

    @staticmethod
    def _delete(rel: str) -> None:
        from app.core.config import settings
        from app.storage import LocalDiskStorage

        try:
            LocalDiskStorage(settings.storage_root).delete(rel)
        except Exception:  # noqa: S110 - cleanup is best-effort
            pass

    def test_serve_voxel_pair_and_glb(self, db, public_scene):
        import json as _json

        from app.db.models.asset import Asset
        from app.db.models.collision_asset import CollisionAsset

        cid = public_scene.id
        glb_data = b"\x67\x6C\x54\x46" + b"\x00" * 40
        voxel_json = _json.dumps(
            {
                "version": "1.1",
                "gridBounds": {"min": [0, 0, 0], "max": [1, 1, 1]},
                "voxelResolution": 0.05,
                "leafSize": 4,
                "treeDepth": 0,
                "nodeCount": 0,
                "leafDataCount": 0,
            }
        ).encode()
        voxel_bin = b"\x01\x02\x03\x04" * 8

        rels = [
            f"collision/{cid}/collision.glb",
            f"collision/{cid}/collision.voxel.json",
            f"collision/{cid}/collision.voxel.bin",
        ]
        for rel, data in zip(rels, (glb_data, voxel_json, voxel_bin), strict=False):
            self._write(rel, data)

        glb_asset = Asset(
            scene_id=public_scene.id,
            kind="COLLISION_GLB",
            storage_key=rels[0],
            mime_type="model/gltf-binary",
            byte_size=len(glb_data),
        )
        voxel_asset = Asset(
            scene_id=public_scene.id,
            kind="COLLISION_VOXEL",
            storage_key=rels[1],
            mime_type="application/json",
            byte_size=len(voxel_json),
            metadata_={"binStorageKey": rels[2]},
        )
        db.add_all([glb_asset, voxel_asset])
        db.flush()
        db.add(
            CollisionAsset(
                scene_id=public_scene.id,
                mode="OUTDOOR",
                asset_id=voxel_asset.id,
                status="SUCCEEDED",
            )
        )
        db.commit()
        try:
            base = f"/api/v1/scenes/{public_scene.slug}/collision"
            glb = client.get(f"{base}/collision.glb")
            assert glb.status_code == 200
            assert glb.content == glb_data
            assert glb.headers["content-type"] == "model/gltf-binary"

            vj = client.get(f"{base}/collision.voxel.json")
            assert vj.status_code == 200
            assert vj.content == voxel_json
            assert vj.headers["content-type"] == "application/json"

            vb = client.get(f"{base}/collision.voxel.bin")
            assert vb.status_code == 200
            assert vb.content == voxel_bin
            assert vb.headers["content-type"] == "application/octet-stream"

            # The legacy /mesh contract route still serves the GLB.
            legacy = client.get(f"{base}/mesh")
            assert legacy.status_code == 200
            assert legacy.content == glb_data
        finally:
            for rel in rels:
                self._delete(rel)


# ─── 10. authorization ─────────────────────────────────────────────────────
class TestAuthorization:
    def test_public_scene_ok_without_login(self, db):
        # anonymous: TestClient without the dev cookie; dev bypass is on in
        # tests so identity == dev user; public + published is readable anyway.
        from tests.conftest_scenes import create_scene

        scene = create_scene(session=db, visibility="PUBLIC", status="PUBLISHED")
        assert _get(scene.slug).status_code == 200

    def test_private_owner_ok(self, private_scene):
        assert _get(private_scene.slug).status_code == 200

    def test_private_other_user_returns_403(self, db, dev_user_id):
        from app.db.models.user import User

        other = User(email=f"rt-other-{uuid.uuid4().hex[:8]}@example.com", display_name="他人")
        db.add(other)
        db.flush()
        scene = _make_scene(
            db,
            visibility="PRIVATE",
            status="PUBLISHED",
            owner_id=other.id,
        )
        _attach_version(
            db,
            scene,
            fmt="streamed-sog",
            manifest={"format": "streamed-sog", "stream": {}},
        )
        assert _get(scene.slug).status_code == 403

    def test_unlisted_other_user_returns_403(self, db, dev_user_id):
        from app.db.models.user import User

        other = User(email=f"rt-ul-{uuid.uuid4().hex[:8]}@example.com", display_name="他人")
        db.add(other)
        db.flush()
        scene = _make_scene(
            db,
            visibility="UNLISTED",
            status="PUBLISHED",
            owner_id=other.id,
        )
        _attach_version(db, scene, fmt="sog", manifest={"format": "sog"})
        assert _get(scene.slug).status_code == 403

    def test_anon_private_returns_401_service_level(self, db):
        """HTTP dev bypass always authenticates; the 401 path is exercised at
        the service boundary where identity is explicitly None."""
        from app.core.errors import UnauthorizedError
        from app.db.models.user import User
        from app.services.scene_runtime import SceneRuntimeService

        other = User(email=f"rt-anon-{uuid.uuid4().hex[:8]}@example.com", display_name="他人")
        db.add(other)
        db.flush()
        scene = _make_scene(db, visibility="PRIVATE", status="PUBLISHED", owner_id=other.id)
        _attach_version(db, scene, fmt="sog", manifest={"format": "sog"})

        svc = SceneRuntimeService(db)
        with pytest.raises(UnauthorizedError):
            svc.get_descriptor(scene.slug, None)

    def test_private_other_returns_403_service_level(self, db):
        from app.core.config import settings
        from app.core.errors import ForbiddenError
        from app.core.identity import RequestIdentity
        from app.db.models.user import User
        from app.services.scene_runtime import SceneRuntimeService

        other = User(email=f"rt-403-{uuid.uuid4().hex[:8]}@example.com", display_name="他人")
        db.add(other)
        db.flush()
        scene = _make_scene(db, visibility="PRIVATE", status="PUBLISHED", owner_id=other.id)
        _attach_version(db, scene, fmt="sog", manifest={"format": "sog"})

        from app.core.identity import _resolve_dev_user_id

        identity = RequestIdentity(
            user_id=_resolve_dev_user_id(settings),
            email="dev@gsplatform.local",
            display_name="dev",
        )
        svc = SceneRuntimeService(db)
        with pytest.raises(ForbiddenError):
            svc.get_descriptor(scene.slug, identity)
