"""Share schemas — DTOs for share link management and resolution."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.scene import SceneDetailOut


class CreateShareRequest(BaseModel):
    hours: int | None = Field(
        default=None,
        ge=1,
        le=24 * 30,
        description="过期小时数；不传则不自动过期",
    )


class ShareLinkOut(BaseModel):
    id: str
    sceneSlug: str = Field(alias="sceneSlug")
    createdAt: datetime | None = Field(default=None, alias="createdAt")
    expiresAt: datetime | None = Field(default=None, alias="expiresAt")
    revoked: bool = False

    model_config = {"populate_by_name": True}


class CreateShareOut(BaseModel):
    """Response of share creation — the ONLY place the raw token appears."""

    token: str | None
    shareUrl: str = Field(alias="shareUrl")
    expiresAt: datetime | None = Field(default=None, alias="expiresAt")
    revoked: bool = False

    model_config = {"populate_by_name": True}


class ShareResolutionOut(BaseModel):
    """Visitor access via a share link: the scene + share meta."""

    scene: SceneDetailOut
    shareId: str = Field(alias="shareId")
    expiresAt: datetime | None = Field(default=None, alias="expiresAt")

    model_config = {"populate_by_name": True}


class ShareListPage(BaseModel):
    items: list[ShareLinkOut]
