"""FIX-UPLOAD-01.1 §F — collision build/rebuild 端点安全回归。

新派发入口（``POST /{slug}/collision/build``、``POST /{slug}/collision/rebuild``）
必须与既有的统一策略一致：

- 会话用户 + 正确 ``X-CSRF-Token`` → 场景属主可创建/重建；
- 会话用户但非属主 → 403（越权防护，沿用 FIX-01 属主校验）；
- 匿名（无会话）→ 401；
- 带错误 CSRF → 403（state-changing 路由强制双提交校验）；
- ``sourceVersion`` 一律取自 DB 中场景的当前 SceneVersion —— 请求体无从注入
  任意 worker 路径/任意版本（派发层不读客户端传入的版本参数）。

一律使用真实注册会话（dev bypass 关闭），不依赖 dev identity 依赖覆盖。
"""

from __future__ import annotations

import uuid
from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _clean_rate_limits():
    """Drop in-memory register/login rate-limit buckets after every test.

    Without this, the suite's many real registrations accumulate against the
    same ``testclient`` key and start returning 429 mid-run (observed in the
    clean-checkout gate run).
    """
    from app.core.rate_limit import reset_rate_limits

    yield
    reset_rate_limits("login", "testclient")
    reset_rate_limits("register", "testclient")


@pytest.fixture()
def client() -> Generator[TestClient, None, None]:
    """TestClient wired to real session auth (no dev bypass)."""
    import app.core.config as config_mod

    original = config_mod.settings.dev_identity_enabled
    config_mod.settings.dev_identity_enabled = False
    try:
        from app.main import app

        with TestClient(app) as c:
            yield c
    finally:
        config_mod.settings.dev_identity_enabled = original


def _register(client: TestClient, email: str | None = None):
    resp = client.post(
        "/api/v1/auth/register",
        json={
            "email": email or f"sec{uuid.uuid4().hex[:12]}@example.com",
            "password": "password-123",
            "displayName": "安全回归用户",
        },
    )
    assert resp.status_code == 200
    return resp


def _session_login(client: TestClient) -> tuple[uuid.UUID, str]:
    """Register a fresh real user and carry session + CSRF cookies on client."""
    reg = _register(client)
    client.cookies.set("gs_session", reg.cookies.get("gs_session"))
    client.cookies.set("gs_csrf", reg.cookies.get("gs_csrf"))
    csrf = reg.cookies.get("gs_csrf") or ""
    assert csrf
    return uuid.UUID(reg.json()["userId"]), csrf


def _scene_owned_by(db, user_id: uuid.UUID):
    from app.db.models.enums import SceneStatus
    from app.db.models.scene import Scene

    scene = Scene(
        owner_id=user_id,
        slug=f"sec-u011-{uuid.uuid4().hex[:10]}",
        title="安全回归场景",
        category="experiment",
        visibility="PRIVATE",
        status=SceneStatus.PUBLISHED.value,
    )
    db.add(scene)
    db.commit()
    db.refresh(scene)
    return scene


def _real_user(db) -> uuid.UUID:
    """Create a real User row (FK scenes.owner_id → users.id)."""
    from app.db.models.user import User

    user = User(
        email=f"sec-owner-{uuid.uuid4().hex[:12]}@example.com",
        display_name="属主",
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user.id


class TestCollisionBuildOwnerAuth:
    def test_anonymous_build_401(self, db, client) -> None:
        """无会话匿名调用碰撞构建 → 401（不泄露场景存在性之外的任何信息）。"""
        other = _scene_owned_by(db, _real_user(db))
        resp = client.post(f"/api/v1/scenes/{other.slug}/collision/build")
        assert resp.status_code == 401, resp.text

    def test_non_owner_build_403(self, db, client) -> None:
        """他人（会话用户）构建他人场景的碰撞 → 403 越权拒绝。"""
        owner_id, _csrf = _session_login(client)
        scene = _scene_owned_by(db, owner_id)
        intruder_reg = _register(client)
        # 换一个全新会话冒充非属主
        client.cookies.set("gs_session", intruder_reg.cookies.get("gs_session"))
        client.cookies.set("gs_csrf", intruder_reg.cookies.get("gs_csrf"))
        resp = client.post(
            f"/api/v1/scenes/{scene.slug}/collision/build",
            json={"mode": "OUTDOOR"},
            headers={"X-CSRF-Token": intruder_reg.cookies.get("gs_csrf") or ""},
        )
        assert resp.status_code == 403, resp.text

    def test_non_owner_rebuild_403(self, db, client) -> None:
        """他人重建碰撞 → 403。"""
        owner_id, _csrf = _session_login(client)
        scene = _scene_owned_by(db, owner_id)
        intruder_reg = _register(client)
        client.cookies.set("gs_session", intruder_reg.cookies.get("gs_session"))
        client.cookies.set("gs_csrf", intruder_reg.cookies.get("gs_csrf"))
        resp = client.post(
            f"/api/v1/scenes/{scene.slug}/collision/rebuild",
            headers={"X-CSRF-Token": intruder_reg.cookies.get("gs_csrf") or ""},
        )
        assert resp.status_code == 403, resp.text

    def test_bad_csrf_403(self, db, client) -> None:
        """错误 CSRF 双提交 token → 403（state-changing 强制校验）。"""
        owner_id, csrf = _session_login(client)
        scene = _scene_owned_by(db, owner_id)
        resp = client.post(
            f"/api/v1/scenes/{scene.slug}/collision/build",
            json={"mode": "OUTDOOR"},
            headers={"X-CSRF-Token": "forged-token"},
        )
        assert resp.status_code == 403, resp.text

    def test_missing_csrf_header_403(self, db, client) -> None:
        """已登录但缺 X-CSRF-Token 头 → 403。"""
        owner_id, _csrf = _session_login(client)
        scene = _scene_owned_by(db, owner_id)
        resp = client.post(
            f"/api/v1/scenes/{scene.slug}/collision/build",
            json={"mode": "OUTDOOR"},
        )
        assert resp.status_code == 403, resp.text

    def test_owner_build_accepted_200(self, db, client, monkeypatch) -> None:
        """属主 + 正确 CSRF → 200 并派发任务（不调用真实 broker）。"""
        from app.services.collision import CollisionService

        owner_id, csrf = _session_login(client)
        scene = _scene_owned_by(db, owner_id)
        # 派发走 send_task —— 测试中打桩，不真正投递。FIX-UPLOAD-01.3: 手动创建
        # 与自动派发共用 ``_dispatch_build``（契约唯一化），桩必须返回合法响应。
        def _stub_dispatch(self, job, collision, scene, current_version, *, success_message=None):
            from app.schemas.collision import CollisionBuildResponse

            return CollisionBuildResponse(
                job_id=str(job.id), status="QUEUED",
                message=success_message or "碰撞构建任务已创建 (模式: OUTDOOR)",
            )

        monkeypatch.setattr(CollisionService, "_dispatch_build", _stub_dispatch)
        resp = client.post(
            f"/api/v1/scenes/{scene.slug}/collision/build",
            json={"mode": "OUTDOOR"},
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 200, resp.text

    def test_body_source_version_rejected(self, db, client, monkeypatch) -> None:
        """请求体不得影响版本绑定 —— 派发层只读 DB 当前 SceneVersion。

        攻击者若能把任意 ``../../..`` 串或版本 UUID 注入派发层，worker 输出
        就可能被写到任意 ``versions/<注入串>/jobs/<任意 id>`` 路径。真实
        ``_dispatch_build`` 的版本绑定只来自场景当前 SceneVersion；伪造请求
        体字段被模式层静默忽略 —— 注入值绝不出现在发往 broker 的任务参数里。
        """
        owner_id, csrf = _session_login(client)
        scene = _scene_owned_by(db, owner_id)
        from app.db.models.scene import SceneVersion

        current_version = (
            db.query(SceneVersion)
            .filter(SceneVersion.scene_id == scene.id)
            .order_by(SceneVersion.created_at.desc())
            .first()
        )
        if current_version is None:  # pragma: no cover - 无版本时派发无意义
            pytest.skip("场景尚无发布版本")

        sent: list[list[str]] = []

        def _fake_send(task_name: str, **kwargs: object) -> object:
            sent.append(kwargs["args"])  # type: ignore[arg-type]
            return type("R", (), {"id": "real-broker-id"})()

        import app.api.v1.collision as collision_router

        monkeypatch.setattr(collision_router, "send_task", _fake_send)
        resp = client.post(
            f"/api/v1/scenes/{scene.slug}/collision/build",
            json={
                "mode": "OUTDOOR",
                "sourceVersion": "../../../../etc/passwd",
                "sourceVersionId": "11111111-1111-1111-1111-111111111111",
            },
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 200, resp.text
        assert len(sent) == 1
        args = sent[0]
        # 第 6 个参数 = 钉扎的 sourceVersion（SceneVersion UUID），必须等于
        # 场景当前版本，而不是请求体注入的任意 UUID。
        assert args[5] == str(current_version.id)
