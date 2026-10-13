"""GS-NEXT-02 — 初始视角「保存→立即回读」的一致性。

背景（PICO 复测暴露）：创作页保存初始视角后立刻重新解析运行时描述符
（`setInitialView` → `settingsRevision` → `resolveSceneRuntimeDescriptor`）。
若保存事务只在请求作用域依赖的 teardown 里提交（`get_db_session` 是 `yield`
依赖，teardown 在响应发送**之后**才跑），紧接着的读请求可能仍看到旧值。

本文件锁定：`AuthoringService.update_presentation` 必须**在返回前**提交，
使得**另一个独立会话**在方法返回后立即读到新值。仅 `flush()` 无法做到这一点。
"""

from __future__ import annotations

from app.core.config import settings
from app.db.session import SessionLocal
from app.schemas.scene_presentation import ScenePresentationUpdateRequest
from app.services.authoring import AuthoringService
from app.storage import LocalDiskStorage
from tests.conftest_scenes import create_scene


def _storage() -> LocalDiskStorage:
    return LocalDiskStorage(root=settings.storage_root)


def test_update_presentation_commits_before_returning(db):
    """服务返回时写入已提交 —— 独立会话立即可见（read-your-write）。"""
    scene = create_scene(session=db, visibility="PRIVATE", status="PUBLISHED")
    db.commit()

    pose = {"x": 0.0439, "y": -0.4176, "z": 0.1422}
    target = {"x": 0.0, "y": -0.5, "z": -1.0}

    service = AuthoringService(db, _storage())
    service.update_presentation(
        scene.slug,
        scene.owner_id,
        ScenePresentationUpdateRequest(
            initialCameraPosition=pose,
            initialCameraTarget=target,
            initialCameraFov=72,
        ),
    )

    # 关键断言：服务已返回 = 事务已提交 —— 另一个会话（自己的连接）必须看到。
    observer = SessionLocal()
    try:
        from app.db.models.scene_presentation import ScenePresentation

        row = (
            observer.query(ScenePresentation)
            .filter(ScenePresentation.scene_id == scene.id)
            .one()
        )
        assert row.initial_camera_position is not None
        assert float(row.initial_camera_position["x"]) == pose["x"]
        assert float(row.initial_camera_target["z"]) == target["z"]
        assert row.initial_camera_fov == 72
    finally:
        observer.close()


def test_runtime_descriptor_reflects_saved_view_from_fresh_session(db):
    """保存后新建会话构建的描述符带上该视角（创作页二次读的真实路径）。"""
    scene = create_scene(session=db, visibility="PRIVATE", status="PUBLISHED")
    db.commit()

    service = AuthoringService(db, _storage())
    service.update_presentation(
        scene.slug,
        scene.owner_id,
        ScenePresentationUpdateRequest(
            initialCameraPosition={"x": 1.5, "y": 1.6, "z": 2.5},
            initialCameraTarget={"x": 0.0, "y": 1.6, "z": 0.0},
            initialCameraFov=65,
        ),
    )

    from app.core.identity import RequestIdentity
    from app.services.scene_runtime import SceneRuntimeService

    fresh = SessionLocal()
    try:
        identity = RequestIdentity(
            user_id=scene.owner_id, email="test@invalid.local",
            display_name="regression", source="dev",
        )
        descriptor = SceneRuntimeService(fresh).get_descriptor(
            scene.slug, identity,
        )
        camera = descriptor.presentation.initialCamera
        assert camera.position is not None
        assert abs(camera.position.x - 1.5) < 1e-9
        assert abs(camera.position.z - 2.5) < 1e-9
        assert camera.target is not None
        assert camera.fov == 65
    finally:
        fresh.close()
