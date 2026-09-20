"""Collision DTOs — explicit fields only, no ORM leakage.

Defines request/response schemas for collision asset management.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class Vec3(BaseModel):
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0


class CollisionAssetCreateRequest(BaseModel):
    """Request to create or start building a collision asset."""
    mode: str = Field(description="INDOOR or OUTDOOR")
    gravity: float = Field(default=9.81, description="Gravity in m/s²")
    slope_limit_degrees: float = Field(default=45.0, description="Max walkable slope in degrees")
    step_offset: float = Field(default=0.3, description="Max step height in meters")
    player_height: float = Field(default=1.8, description="Player eye height in meters")


class CollisionAssetUpdateRequest(BaseModel):
    """Partial update for collision physics params."""
    gravity: float | None = None
    slope_limit_degrees: float | None = None
    step_offset: float | None = None
    player_height: float | None = None
    collision_enabled: bool | None = None


class CollisionAssetOut(BaseModel):
    """Response DTO for collision asset."""
    id: str
    scene_id: str
    mode: str
    status: str
    asset_id: str | None = None
    job_id: str | None = None
    gravity: float
    slope_limit_degrees: float
    step_offset: float
    player_height: float
    collision_enabled: bool
    error_message: str | None = None
    attempt: int
    created_at: datetime
    updated_at: datetime

    model_config = {"populate_by_name": True}


class CollisionBuildResponse(BaseModel):
    """Response after triggering a collision build."""
    job_id: str
    status: str
    message: str
