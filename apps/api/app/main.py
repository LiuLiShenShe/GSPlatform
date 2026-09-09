"""GSPlatform API application entry point."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from app.config import settings


def create_app() -> FastAPI:
    """Build and return the FastAPI application."""
    app = FastAPI(
        title="GSPlatform API",
        version="0.1.0",
        description="GSPlatform backend API",
        docs_url="/docs",
    )

    @app.get("/health/live")
    def health_live() -> JSONResponse:
        """Liveness probe — process is up and serving requests.

        Deliberately does not probe PostgreSQL/Redis, which are not yet
        wired in this phase.
        """
        return JSONResponse(
            content={"status": "ok", "service": settings.app_name},
            status_code=200,
        )

    return app


app = create_app()
