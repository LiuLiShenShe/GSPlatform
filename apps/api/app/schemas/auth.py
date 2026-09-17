"""Auth schemas — request/response DTOs for authentication endpoints."""

from __future__ import annotations

from pydantic import BaseModel, Field


class RegisterRequest(BaseModel):
    email: str = Field(
        ..., min_length=3, max_length=320, description="邮箱地址"
    )
    password: str = Field(..., min_length=8, max_length=128, description="密码")
    displayName: str = Field(
        ..., alias="displayName", min_length=1, max_length=120,
        description="显示名称"
    )

    model_config = {"populate_by_name": True}


class LoginRequest(BaseModel):
    email: str
    password: str


class SessionOut(BaseModel):
    userId: str = Field(description="用户 ID")
    email: str
    displayName: str = Field(alias="displayName")

    model_config = {"populate_by_name": True}


class MessageOut(BaseModel):
    message: str
