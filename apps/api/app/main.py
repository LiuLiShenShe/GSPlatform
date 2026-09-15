"""GSPlatform API application entry point."""

from __future__ import annotations

import uuid

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

from app.api.v1.router import v1_router
from app.core.config import settings
from app.core.errors import install_error_handlers
from app.db.session import ping_database


def _request_id_middleware() -> type[BaseHTTPMiddleware]:
    """Middleware that injects a ``request_id`` (UUID4) into every request state
    so that error responses can include it as ``requestId``."""

    class _Middleware(BaseHTTPMiddleware):
        async def dispatch(
            self, request: Request, call_next: RequestResponseEndpoint
        ) -> Response:
            request.state.request_id = str(uuid.uuid4())
            return await call_next(request)

    return _Middleware


def create_app() -> FastAPI:
    """Build and return the FastAPI application."""
    app = FastAPI(
        title="GSPlatform API",
        version="0.1.0",
        description="GSPlatform backend API — scene catalogue, job status and health probes.",
        docs_url="/docs",
    )

    # --- CORS (permissive in dev; restrict by deployment in production). ---
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "HEAD", "OPTIONS", "POST", "PATCH", "DELETE"],
        allow_headers=["*"],
    )

    # --- Request-id injection (stability for error requestId). ---
    app.add_middleware(_request_id_middleware())

    # --- Error protocol (install after middleware so requestId is available). ---
    install_error_handlers(app)

    # --- Production identity-bypass guard (checked once at startup). ---
    if settings.env == "production" and settings.dev_identity_enabled:
        raise RuntimeError(
            "GS_DEV_IDENTITY_ENABLED is not permitted in production. "
            "Set GS_ENV=development or disable the flag."
        )

    # --- API v1 routes ---
    app.include_router(v1_router)

    # ------------------------------------------------------------------
    # Health probes (independent of the v1 router; do not touch ORM)
    # ------------------------------------------------------------------
    @app.get("/health/live")
    def health_live() -> JSONResponse:
        """Liveness — process is alive, no dependency checks."""
        return JSONResponse(
            content={"status": "ok", "service": settings.app_name},
            status_code=200,
        )

    @app.get("/health/ready")
    def health_ready() -> JSONResponse:
        """Readiness — real PostgreSQL round-trip. Non-200 on failure."""
        ok = ping_database()
        if not ok:
            return JSONResponse(
                content={"status": "not ready", "database": "unreachable"},
                status_code=503,
            )
        return JSONResponse(
            content={"status": "ready", "service": settings.app_name},
            status_code=200,
        )

    return app


app = create_app()
