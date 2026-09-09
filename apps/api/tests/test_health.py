"""Tests for the /health/live liveness endpoint."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_live_returns_200() -> None:
    """GET /health/live must return HTTP 200."""
    response = client.get("/health/live")
    assert response.status_code == 200


def test_health_live_returns_expected_json() -> None:
    """GET /health/live must return stable JSON body."""
    response = client.get("/health/live")
    body = response.json()
    assert body == {"status": "ok", "service": "gsplatform-api"}


def test_openapi_docs_available() -> None:
    """OpenAPI schema must be reachable at /docs."""
    response = client.get("/docs")
    assert response.status_code == 200


def test_openapi_json_available() -> None:
    """OpenAPI JSON must be reachable at /openapi.json."""
    response = client.get("/openapi.json")
    assert response.status_code == 200
    assert response.json()["info"]["title"] == "GSPlatform API"
