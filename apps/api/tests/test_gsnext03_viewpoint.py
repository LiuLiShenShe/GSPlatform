"""GS-NEXT-03 — 视点（SceneViewpoint）写入的「保存→立即回读」一致性。

背景：与 GS-NEXT-02 的 presentation 路径同一类缺陷。视点的增/改/删/重排原本只
`flush()`，事务提交交给请求作用域依赖的 teardown —— 而 `get_db_session` 是 `yield`
依赖，teardown 在响应**发出之后**才跑。于是：

  POST /viewpoints → 201（响应体里带着新视点）
  紧接着 GET /viewpoints → **看不到它**

创作页刷新、Desktop 的 Saved Views、以及运行时描述符重建都恰好是「写完立刻读」，
因此这条竞态会表现成「刚建的视点不出现 / 点击切换没反应」。

本文件锁定：四个写操作返回时**已提交**，另一个独立会话立即可见。
"""

from __future__ import annotations

from app.db.session import SessionLocal
from app.schemas.scene_presentation import (
    SceneViewpointCreateRequest,
    SceneViewpointUpdateRequest,
    Vec3,
)
from app.services.authoring import AuthoringService
from app.storage import LocalDiskStorage
from tests.conftest_scenes import create_scene


def _service(db) -> AuthoringService:
    from app.core.config import settings

    return AuthoringService(db, LocalDiskStorage(root=settings.storage_root))


def _fresh_viewpoints(scene_id) -> list:
    """另一个独立会话读取 —— 只有已提交的数据才看得见。"""
    from app.db.models.scene_viewpoint import SceneViewpoint

    session = SessionLocal()
    try:
        return (
            session.query(SceneViewpoint)
            .filter(SceneViewpoint.scene_id == scene_id)
            .order_by(SceneViewpoint.order_index)
            .all()
        )
    finally:
        session.close()


def test_create_viewpoint_commits_before_returning(db):
    scene = create_scene(session=db, visibility="PRIVATE", status="PUBLISHED")
    db.commit()

    service = _service(db)
    created = service.create_viewpoint(
        scene.slug,
        scene.owner_id,
        SceneViewpointCreateRequest(
            name="入口",
            position=Vec3(x=1.0, y=1.6, z=2.0),
            target=Vec3(x=0.0, y=1.4, z=0.0),
            fov=55,
        ),
    )

    # 独立会话立即可见（仅 flush 时这里会是空列表）
    rows = _fresh_viewpoints(scene.id)
    assert [str(r.id) for r in rows] == [created.id]
    assert rows[0].name == "入口"
    assert float(rows[0].position["x"]) == 1.0
    assert rows[0].enabled is True


def test_update_viewpoint_commits_before_returning(db):
    scene = create_scene(session=db, visibility="PRIVATE", status="PUBLISHED")
    db.commit()
    service = _service(db)
    vp = service.create_viewpoint(
        scene.slug,
        scene.owner_id,
        SceneViewpointCreateRequest(
            name="A", position=Vec3(x=0, y=0, z=0), target=Vec3(x=0, y=0, z=1), fov=60
        ),
    )

    service.update_viewpoint(
        scene.slug, scene.owner_id, vp.id, SceneViewpointUpdateRequest(name="B", enabled=False)
    )

    rows = _fresh_viewpoints(scene.id)
    assert rows[0].name == "B"
    assert rows[0].enabled is False


def test_delete_viewpoint_commits_before_returning(db):
    scene = create_scene(session=db, visibility="PRIVATE", status="PUBLISHED")
    db.commit()
    service = _service(db)
    vp = service.create_viewpoint(
        scene.slug,
        scene.owner_id,
        SceneViewpointCreateRequest(
            name="待删", position=Vec3(x=0, y=0, z=0), target=Vec3(x=0, y=0, z=1), fov=60
        ),
    )
    assert len(_fresh_viewpoints(scene.id)) == 1

    service.delete_viewpoint(scene.slug, scene.owner_id, vp.id)

    # 独立会话不得再看到（仅 flush 时这里仍是 1 行）
    assert _fresh_viewpoints(scene.id) == []


def test_created_viewpoint_is_visible_to_the_runtime_descriptor_immediately(db):
    """创作页保存后立刻重建描述符（Desktop/XR 的真实路径）必须带上新视点。"""
    from app.core.identity import RequestIdentity
    from app.services.scene_runtime import SceneRuntimeService

    scene = create_scene(session=db, visibility="PRIVATE", status="PUBLISHED")
    db.commit()
    service = _service(db)
    service.create_viewpoint(
        scene.slug,
        scene.owner_id,
        SceneViewpointCreateRequest(
            name="近景",
            position=Vec3(x=0.5, y=1.2, z=0.8),
            target=Vec3(x=0.0, y=1.0, z=0.0),
            fov=62,
        ),
    )

    fresh = SessionLocal()
    try:
        identity = RequestIdentity(
            user_id=scene.owner_id,
            email="test@invalid.local",
            display_name="regression",
            source="dev",
        )
        descriptor = SceneRuntimeService(fresh).get_descriptor(scene.slug, identity)
        assert len(descriptor.viewpoints) == 1
        assert descriptor.viewpoints[0].name == "近景"
        assert abs(descriptor.viewpoints[0].position.x - 0.5) < 1e-9
    finally:
        fresh.close()
