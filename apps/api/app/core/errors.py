"""Stable error protocol for GSPlatform API.

Every error response uses the shape ``{code, message, requestId}`` so that
frontends can branch on stable codes instead of HTTP status alone. Status
semantics are fixed in the docs:

- 422 validation errors (RequestValidationError)
- 404 not found
- 409 conflict (state races, unique violations)
- 401/403 identity/permission
- 500 internal errors (never leak details)
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, TypeVar

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.core.config import APP_NAME

# Stable error codes exposed to clients.
ERROR_VALIDATION = "VALIDATION_ERROR"
ERROR_NOT_FOUND = "NOT_FOUND"
ERROR_CONFLICT = "CONFLICT"
ERROR_UNAUTHORIZED = "UNAUTHORIZED"
ERROR_FORBIDDEN = "FORBIDDEN"
ERROR_INTERNAL = "INTERNAL_ERROR"
ERROR_DATABASE_UNAVAILABLE = "DATABASE_UNAVAILABLE"

_CALLABLE = TypeVar("_CALLABLE", bound=Callable[..., Any])


def request_id_of(request: Request) -> str:
    """Return the per-request requestId (set by the request-id middleware)."""
    return str(getattr(request.state, "request_id", "unknown"))


def _error_payload(code: str, message: str, request: Request) -> dict[str, Any]:
    return {
        "code": code,
        "message": message,
        "requestId": request_id_of(request),
    }


class ApiError(Exception):
    """Base class for application errors with a stable code and HTTP status."""

    code = ERROR_INTERNAL
    status_code = status.HTTP_500_INTERNAL_SERVER_ERROR

    def __init__(self, message: str, *, details: Any | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details


class NotFoundError(ApiError):
    """Resource does not exist (or is not visible to the caller)."""

    code = ERROR_NOT_FOUND
    status_code = status.HTTP_404_NOT_FOUND


class ConflictError(ApiError):
    """State conflict — retry with fresh state or satisfy preconditions."""

    code = ERROR_CONFLICT
    status_code = status.HTTP_409_CONFLICT


class UnauthorizedError(ApiError):
    """Caller has no identity / no active session."""

    code = ERROR_UNAUTHORIZED
    status_code = status.HTTP_401_UNAUTHORIZED


class ForbiddenError(ApiError):
    """Caller is identified but lacks permission for this resource."""

    code = ERROR_FORBIDDEN
    status_code = status.HTTP_403_FORBIDDEN


class DatabaseUnavailableError(ApiError):
    """Readiness probe or DB-backed handler could not reach PostgreSQL."""

    code = ERROR_DATABASE_UNAVAILABLE
    status_code = status.HTTP_503_SERVICE_UNAVAILABLE


def install_error_handlers(app: FastAPI) -> None:
    """Register exception handlers mapping errors to the stable JSON shape."""

    @app.exception_handler(RequestValidationError)
    async def _on_validation_error(
        request: Request,
        exc: RequestValidationError,
    ) -> JSONResponse:
        details: list[dict[str, Any]] = []
        for err in exc.errors():
            details.append(
                {
                    "loc": ".".join(str(part) for part in err.get("loc", [])),
                    "msg": err.get("msg", ""),
                    "type": err.get("type", ""),
                }
            )
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={
                **{key: value for key, value in _error_payload(
                    ERROR_VALIDATION,
                    "请求参数校验失败",
                    request,
                ).items()},
                "details": details,
            },
        )

    @app.exception_handler(ApiError)
    async def _on_api_error(request: Request, exc: ApiError) -> JSONResponse:
        body = _error_payload(exc.code, exc.message, request)
        if exc.details is not None:
            body["details"] = exc.details
        return JSONResponse(status_code=exc.status_code, content=body)

    @app.exception_handler(Exception)
    async def _on_unhandled_error(
        request: Request,
        exc: Exception,
    ) -> JSONResponse:
        # Log full detail server-side, return a safe generic message to clients.
        import logging

        logging.getLogger(APP_NAME).exception(
            "Unhandled error on %s %s",
            request.method,
            request.url.path,
            exc_info=exc,
        )
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=_error_payload(
                ERROR_INTERNAL,
                "服务器内部错误，请稍后重试",
                request,
            ),
        )
