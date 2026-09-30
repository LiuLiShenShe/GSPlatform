"""FIX-05 §22-§25 tests — collision STALE semantics + world-transform hash.

Rules:
  - build/rebuild 记录构建时的世界变换 hash（build_params.worldTransformHash）；
  - 描述符 STALE = 记录 hash ≠ 当前 hash（恒等/未记录对恒等/未记录 = 一致）；
  - 官方 runtime 无法可靠重变换碰撞几何 → STALE 时 UI 必须禁用 walk 并要求重建；
  - Authoring 面板经 collision API 的 stale 字段展示「重建」提示。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _attach_collision(
    db,
    scene,
    *,
    build_params=None,
    status="SUCCEEDED",
    world_transform=None,
):
    from app.db.models.asset import Asset
    from app.db.models.collision_asset import CollisionAsset
    from app.db.models.scene_presentation import ScenePresentation

    asset = Asset(
        scene_id=scene.id,
        kind="COLLISION_GLB",
        storage_key=f"collision/{scene.id}/collision.glb",
        mime_type="model/gltf-binary",
        byte_size=1024,
    )
    db.add(asset)
    db.flush()
    db.add(
        CollisionAsset(
            scene_id=scene.id,
            mode="OUTDOOR",
            asset_id=asset.id,
            status=status,
            gravity=9.81,
            slope_limit_degrees=45.0,
            step_offset=0.3,
            player_height=1.8,
            build_params=build_params,
        )
    )
    db.add(
        ScenePresentation(
            scene_id=scene.id,
            collision_enabled=True,
            world_position=(world_transform or {}).get("position"),
            world_rotation=(world_transform or {}).get("rotation"),
            world_scale=(world_transform or {}).get("scale"),
        )
    )
    db.commit()


class TestWorldTransformHash:
    def test_identity_components_yield_none(self):
        from app.services.collision import world_transform_hash

        assert world_transform_hash(None, None, None) is None
        assert world_transform_hash({}, {}, {}) is None

    def test_stable_within_instance_and_different_for_changes(self):
        from app.services.collision import world_transform_hash

        wt_a = {"position": {"x": 1, "y": 0, "z": 0}, "rotation": None, "scale": None}
        h1 = world_transform_hash(
            wt_a["position"], wt_a["rotation"], wt_a["scale"]
        )
        h2 = world_transform_hash(
            wt_a["position"], wt_a["rotation"], wt_a["scale"]
        )
        assert h1 == h2 and h1 is not None
        h3 = world_transform_hash(
            {"x": 2, "y": 0, "z": 0}, None, None
        )
        assert h3 != h1


class TestCollisionStaleDescriptor:
    def test_legacy_identity_not_stale(self, db, public_scene):
        """未记录 hash（存量）+ 恒等 W → 一致 → 不 STALE（零回归）。"""
        _attach_collision(db, public_scene)
        body = client.get(f"/api/v1/scenes/{public_scene.slug}/runtime").json()
        collision = body["collision"]
        assert collision["stale"] is False
        assert collision["worldTransformHash"] is None

    def test_transform_changed_after_build_is_stale(self, db, public_scene):
        """构建时恒等（未记录）→ 构建后加了非恒等 W → STALE。"""
        _attach_collision(
            db, public_scene,
            world_transform={
                "position": {"x": 10, "y": 0, "z": 0},
                "rotation": None,
                "scale": None,
            },
        )
        body = client.get(f"/api/v1/scenes/{public_scene.slug}/runtime").json()
        collision = body["collision"]
        assert collision["stale"] is True
        assert collision["worldTransformHash"] is not None

    def test_rebuild_with_current_transform_not_stale(self, db, public_scene):
        """重建时记录当前非恒等 W 的 hash → 匹配 → 不 STALE。"""
        from app.services.collision import world_transform_hash

        current = {
            "position": {"x": 3, "y": 0, "z": 0},
            "rotation": {"x": 0, "y": 45, "z": 0},
            "scale": {"x": 2, "y": 2, "z": 2},
        }
        recorded = world_transform_hash(
            current["position"], current["rotation"], current["scale"]
        )
        _attach_collision(
            db, public_scene,
            build_params={"worldTransformHash": recorded},
            world_transform=current,
        )
        body = client.get(f"/api/v1/scenes/{public_scene.slug}/runtime").json()
        collision = body["collision"]
        assert collision["stale"] is False
        assert collision["worldTransformHash"] == recorded

    def test_transform_change_with_recorded_hash_is_stale(self, db, public_scene):
        """构建时记录 X → 之后 W 改为 Y（≠X）→ STALE。"""
        from app.services.collision import world_transform_hash

        built_under = {"position": {"x": 3, "y": 0, "z": 0}, "rotation": None, "scale": None}
        recorded = world_transform_hash(
            built_under["position"], built_under["rotation"], built_under["scale"]
        )
        now = {"position": {"x": 9, "y": 0, "z": 0}, "rotation": None, "scale": None}
        _attach_collision(
            db, public_scene,
            build_params={"worldTransformHash": recorded},
            world_transform=now,
        )
        body = client.get(f"/api/v1/scenes/{public_scene.slug}/runtime").json()
        assert body["collision"]["stale"] is True


class TestCollisionStaleApi:
    """Authoring 面板数据源：GET /{slug}/collision 必须带 stale（§25 UI 提示）。"""

    def test_api_reports_stale(self, db, public_scene):
        _attach_collision(
            db, public_scene,
            world_transform={"position": {"x": 1, "y": 0, "z": 0}, "rotation": None, "scale": None},
        )
        resp = client.get(f"/api/v1/scenes/{public_scene.slug}/collision")
        assert resp.status_code == 200
        payload = resp.json()
        assert payload["stale"] is True
        assert payload["worldTransformHash"] is not None

    def test_api_reports_not_stale_for_legacy_identity(self, db, public_scene):
        _attach_collision(db, public_scene)
        payload = client.get(f"/api/v1/scenes/{public_scene.slug}/collision").json()
        assert payload["stale"] is False
