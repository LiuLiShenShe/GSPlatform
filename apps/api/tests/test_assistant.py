"""Phase 08 — "Ask AI" (SceneAssistantService) endpoint tests.

The model service is mocked so tests are deterministic: we verify the request
shape sent to the model (context gating, untrusted-data delimiting) and the
response contract — a REAL model-shaped response, never fixed text.
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _dev_auth_headers() -> dict:
    # Dev-identity bypass: identity is injected automatically.
    return {}


class _FakeResponse:
    """Fake httpx.Response with a controllable body/status."""

    def __init__(self, status_code: int = 200, body: dict | None = None) -> None:
        self.status_code = status_code
        self._body = body or {
            "choices": [{"message": {"content": "这是一个真实的模型回答。"}}]
        }

    def json(self) -> dict:
        return self._body

    @property
    def text(self) -> str:
        return json.dumps(self._body)


def _mock_httpx(response: _FakeResponse | None = None):
    """Patch httpx.Client.post to return a canned response.

    ``with httpx.Client(...) as client`` must hand back the SAME mock, so
    ``__enter__`` returns self — otherwise ``client.post`` is a fresh mock.
    """
    fake = response or _FakeResponse()
    mock_client = MagicMock()
    mock_client.__enter__.return_value = mock_client
    mock_client.post.return_value = fake
    return patch(
        "app.services.scene_assistant.httpx.Client",
        return_value=mock_client,
    )


# ─── happy path ───────────────────────────────────────────────────────────────
class TestAsk:
    def test_ask_public_scene_returns_real_answer(self, public_scene):
        settings_mock = patch(
            "app.services.scene_assistant.get_settings",
            return_value=type(
                "S",
                (),
                {
                    "ai_api_key": "test-key",
                    "ai_base_url": "https://example.test/v1",
                    "ai_model": "test-model",
                    "ai_timeout_seconds": 10,
                    "ai_max_question_chars": 2000,
                    "ai_max_answer_chars": 4000,
                },
            )(),
        )
        with _mock_httpx(), settings_mock:
            resp = client.post(
                "/api/v1/assistant/ask",
                json={"sceneSlug": public_scene.slug, "question": "这是什么场景？"},
                headers=_dev_auth_headers(),
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["answer"] == "这是一个真实的模型回答。"
        assert body["model"] == "test-model"
        assert "标题" in body["sources"]
        assert body["durationMs"] >= 0

    def test_ask_empty_question_422(self, public_scene):
        resp = client.post(
            "/api/v1/assistant/ask",
            json={"sceneSlug": public_scene.slug, "question": ""},
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 422

    def test_ask_missing_scene_404(self):
        resp = client.post(
            "/api/v1/assistant/ask",
            json={"sceneSlug": "not-here", "question": "h"},
            headers=_dev_auth_headers(),
        )
        assert resp.status_code == 404

    def test_ask_invisible_scene_403(self):
        """Asking about another owner's private scene → 403 (no context leak)."""
        import uuid

        from app.db.models.user import User
        from app.db.session import SessionLocal
        from tests.conftest_scenes import create_scene

        db2 = SessionLocal()
        try:
            other = User(
                email=f"ai-owner-{uuid.uuid4().hex[:8]}@example.com",
                display_name="他人",
            )
            db2.add(other)
            db2.flush()
            scene = create_scene(
                session=db2,
                owner_id=other.id,
                visibility="PRIVATE",
                status="PUBLISHED",
            )
        finally:
            db2.close()

        with _mock_httpx():
            resp = client.post(
                "/api/v1/assistant/ask",
                json={"sceneSlug": scene.slug, "question": "hi"},
                headers=_dev_auth_headers(),
            )
        assert resp.status_code == 403

    def test_ask_own_private_scene_ok(self, private_scene):
        settings_mock = patch(
            "app.services.scene_assistant.get_settings",
            return_value=type(
                "S",
                (),
                {
                    "ai_api_key": "test-key",
                    "ai_base_url": "https://example.test/v1",
                    "ai_model": "test-model",
                    "ai_timeout_seconds": 10,
                    "ai_max_question_chars": 2000,
                    "ai_max_answer_chars": 4000,
                },
            )(),
        )
        with _mock_httpx(), settings_mock:
            resp = client.post(
                "/api/v1/assistant/ask",
                json={"sceneSlug": private_scene.slug, "question": "我的场景"},
                headers=_dev_auth_headers(),
            )
        assert resp.status_code == 200


# ─── failure modes ────────────────────────────────────────────────────────────
class TestAskFailures:
    def test_model_unconfigured_conflict(self, public_scene):
        settings_mock = patch(
            "app.services.scene_assistant.get_settings",
            return_value=type(
                "S",
                (),
                {
                    "ai_api_key": "",  # not configured
                    "ai_base_url": "https://example.test/v1",
                    "ai_model": "test-model",
                    "ai_timeout_seconds": 10,
                    "ai_max_question_chars": 2000,
                    "ai_max_answer_chars": 4000,
                },
            )(),
        )
        with _mock_httpx(), settings_mock:
            resp = client.post(
                "/api/v1/assistant/ask",
                json={"sceneSlug": public_scene.slug, "question": "hi"},
                headers=_dev_auth_headers(),
            )
        assert resp.status_code == 409

    def test_model_http_500_becomes_conflict(self, public_scene):
        settings_mock = patch(
            "app.services.scene_assistant.get_settings",
            return_value=type(
                "S",
                (),
                {
                    "ai_api_key": "test-key",
                    "ai_base_url": "https://example.test/v1",
                    "ai_model": "test-model",
                    "ai_timeout_seconds": 10,
                    "ai_max_question_chars": 2000,
                    "ai_max_answer_chars": 4000,
                },
            )(),
        )
        fake = _FakeResponse(status_code=500, body={})
        with _mock_httpx(fake), settings_mock:
            resp = client.post(
                "/api/v1/assistant/ask",
                json={"sceneSlug": public_scene.slug, "question": "hi"},
                headers=_dev_auth_headers(),
            )
        assert resp.status_code == 409

    def test_model_timeout_becomes_conflict(self, public_scene):
        import httpx

        settings_mock = patch(
            "app.services.scene_assistant.get_settings",
            return_value=type(
                "S",
                (),
                {
                    "ai_api_key": "test-key",
                    "ai_base_url": "https://example.test/v1",
                    "ai_model": "test-model",
                    "ai_timeout_seconds": 10,
                    "ai_max_question_chars": 2000,
                    "ai_max_answer_chars": 4000,
                },
            )(),
        )
        mock_client = MagicMock()
        mock_client.__enter__.return_value = mock_client
        mock_client.post.side_effect = httpx.TimeoutException("timed out")
        with patch(
            "app.services.scene_assistant.httpx.Client",
            return_value=mock_client,
        ), settings_mock:
            resp = client.post(
                "/api/v1/assistant/ask",
                json={"sceneSlug": public_scene.slug, "question": "hi"},
                headers=_dev_auth_headers(),
            )
        assert resp.status_code == 409

    def test_empty_model_answer_conflict(self, public_scene):
        settings_mock = patch(
            "app.services.scene_assistant.get_settings",
            return_value=type(
                "S",
                (),
                {
                    "ai_api_key": "test-key",
                    "ai_base_url": "https://example.test/v1",
                    "ai_model": "test-model",
                    "ai_timeout_seconds": 10,
                    "ai_max_question_chars": 2000,
                    "ai_max_answer_chars": 4000,
                },
            )(),
        )
        fake = _FakeResponse(status_code=200, body={"choices": [{"message": {"content": "  "}}]})
        with _mock_httpx(fake), settings_mock:
            resp = client.post(
                "/api/v1/assistant/ask",
                json={"sceneSlug": public_scene.slug, "question": "hi"},
                headers=_dev_auth_headers(),
            )
        assert resp.status_code == 409

    def test_question_too_long_conflict(self, public_scene):
        """Pydantic caps the wire at 2000 chars; the service cap (ai_max_question_chars)
        is a separate, lower guard — set it below the wire cap to reach the service 409."""
        settings_mock = patch(
            "app.services.scene_assistant.get_settings",
            return_value=type(
                "S",
                (),
                {
                    "ai_api_key": "test-key",
                    "ai_base_url": "https://example.test/v1",
                    "ai_model": "test-model",
                    "ai_timeout_seconds": 10,
                    "ai_max_question_chars": 10,
                    "ai_max_answer_chars": 4000,
                },
            )(),
        )
        with _mock_httpx(), settings_mock:
            resp = client.post(
                "/api/v1/assistant/ask",
                json={"sceneSlug": public_scene.slug, "question": "x" * 100},
                headers=_dev_auth_headers(),
            )
        assert resp.status_code == 409


# ─── context safety ───────────────────────────────────────────────────────────
class TestContextSafety:
    def test_context_delimited_and_sources_reported(self, public_scene):
        """The scene metadata is wrapped in delimiters in the *user* turn —
        never placed in the system prompt — and sources are explicit."""
        captured: dict = {}

        class RecordingClient:
            def __init__(self, *args, **kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def post(self, url, headers=None, json=None):
                captured["url"] = url
                captured["messages"] = json["messages"] if json else None
                return _FakeResponse()

        settings_mock = patch(
            "app.services.scene_assistant.get_settings",
            return_value=type(
                "S",
                (),
                {
                    "ai_api_key": "test-key",
                    "ai_base_url": "https://example.test/v1",
                    "ai_model": "test-model",
                    "ai_timeout_seconds": 10,
                    "ai_max_question_chars": 2000,
                    "ai_max_answer_chars": 4000,
                },
            )(),
        )
        with patch(
            "app.services.scene_assistant.httpx.Client",
            RecordingClient,
        ), settings_mock:
            resp = client.post(
                "/api/v1/assistant/ask",
                json={"sceneSlug": public_scene.slug, "question": "内容是什么？"},
                headers=_dev_auth_headers(),
            )
        assert resp.status_code == 200
        assert resp.json()["sources"]  # explicit source list

        # system prompt must NOT contain the scene text
        system_msg = captured["messages"][0]
        user_msg = captured["messages"][1]
        assert system_msg["role"] == "system"
        assert "title:" not in system_msg["content"]
        # the scene block is in the user turn, delimited
        assert "BEGIN_SCENE_CONTEXT" in user_msg["content"]
        assert public_scene.title in user_msg["content"]
