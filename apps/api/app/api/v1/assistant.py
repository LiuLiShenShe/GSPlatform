"""Assistant endpoints — server-side "Ask AI" (Phase 08).

Routes:
  POST /assistant/ask — ask a question about a scene.

No conversation persistence (spec: default = minimal retention; saving
conversations requires an explicit product decision).

CSRF note: this is a read-model endpoint from the model service, but it *does*
act on behalf of the authenticated user (rate-limited, context-gated), so we
still enforce CSRF for session-based callers.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DBSession

from app.core.config import get_settings
from app.core.errors import RateLimitError
from app.core.identity import CurrentUser, require_csrf
from app.core.rate_limit import check_rate_limit
from app.db.session import get_db_session
from app.services.scene_assistant import SceneAssistantService

router = APIRouter()


class AskRequest(BaseModel):
    sceneSlug: str = Field(..., alias="sceneSlug", min_length=1, max_length=200)
    question: str = Field(..., min_length=1, max_length=2000)

    model_config = {"populate_by_name": True}


class AskResponse(BaseModel):
    answer: str
    sources: list[str]
    model: str
    durationMs: int = Field(alias="durationMs")
    contextSkipped: list[str] = Field(default_factory=list, alias="contextSkipped")

    model_config = {"populate_by_name": True}


def _client_ip(request: Request) -> str:
    try:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return request.client.host if request.client else ""
    except Exception:
        return ""


@router.post("/ask", response_model=AskResponse)
def ask_ai(
    body: AskRequest,
    request: Request,
    identity: CurrentUser = Depends(require_csrf),
    db: DBSession = Depends(get_db_session),
) -> AskResponse:
    settings = get_settings()

    rl = check_rate_limit(
        "assistant",
        str(identity.user_id),
        limit=settings.rate_limit_assistant_per_minute,
        window_seconds=60,
    )
    if not rl.allowed:
        raise RateLimitError(rl.reason)

    service = SceneAssistantService(db)
    result = service.ask(
        scene_slug=body.sceneSlug,
        question=body.question,
        identity_user_id=identity.user_id,
        _client_ip=_client_ip(request),
    )
    return AskResponse(
        answer=result.answer,
        sources=result.sources,
        model=result.model,
        durationMs=result.durationMs,
        contextSkipped=result.contextSkipped,
    )
