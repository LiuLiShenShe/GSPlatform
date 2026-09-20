"""Scene Presentation DTOs — camera, transform, background, cover settings."""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class Vec3(BaseModel):
    """3D vector for position/rotation/scale."""
    x: float
    y: float
    z: float


class ScenePresentationOut(BaseModel):
    """Scene presentation settings — returned in detail or standalone."""
    worldPosition: Vec3 | None = Field(default=None, alias="worldPosition")
    worldRotation: Vec3 | None = Field(default=None, alias="worldRotation")
    worldScale: Vec3 | None = Field(default=None, alias="worldScale")

    initialCameraPosition: Vec3 | None = Field(default=None, alias="initialCameraPosition")
    initialCameraTarget: Vec3 | None = Field(default=None, alias="initialCameraTarget")
    initialCameraFov: float | None = Field(default=None, alias="initialCameraFov")

    backgroundType: str = Field(default="color", alias="backgroundType")
    backgroundColor: Vec3 | None = Field(default=None, alias="backgroundColor")
    backgroundAssetId: str | None = Field(default=None, alias="backgroundAssetId")
    backgroundMetadata: dict[str, Any] | None = Field(default=None, alias="backgroundMetadata")

    coverAssetId: str | None = Field(default=None, alias="coverAssetId")
    coverUrl: str | None = Field(default=None, alias="coverUrl")

    # Background audio
    backgroundAudioAssetId: str | None = Field(default=None, alias="backgroundAudioAssetId")
    backgroundAudioVolume: float = Field(default=0.5, alias="backgroundAudioVolume")
    backgroundAudioLoop: bool = Field(default=True, alias="backgroundAudioLoop")
    backgroundAudioEnabled: bool = Field(default=False, alias="backgroundAudioEnabled")

    model_config = {"populate_by_name": True}


class ScenePresentationUpdateRequest(BaseModel):
    """Partial update for scene presentation settings."""
    worldPosition: Vec3 | None = Field(default=None, alias="worldPosition")
    worldRotation: Vec3 | None = Field(default=None, alias="worldRotation")
    worldScale: Vec3 | None = Field(default=None, alias="worldScale")

    initialCameraPosition: Vec3 | None = Field(default=None, alias="initialCameraPosition")
    initialCameraTarget: Vec3 | None = Field(default=None, alias="initialCameraTarget")
    initialCameraFov: float | None = Field(default=None, alias="initialCameraFov")

    backgroundType: str | None = Field(default=None, alias="backgroundType")
    backgroundColor: Vec3 | None = Field(default=None, alias="backgroundColor")
    backgroundAssetId: str | None = Field(default=None, alias="backgroundAssetId")
    backgroundMetadata: dict[str, Any] | None = Field(default=None, alias="backgroundMetadata")

    coverAssetId: str | None = Field(default=None, alias="coverAssetId")

    # Background audio
    backgroundAudioAssetId: str | None = Field(default=None, alias="backgroundAudioAssetId")
    backgroundAudioVolume: float | None = Field(default=None, alias="backgroundAudioVolume")
    backgroundAudioLoop: bool | None = Field(default=None, alias="backgroundAudioLoop")
    backgroundAudioEnabled: bool | None = Field(default=None, alias="backgroundAudioEnabled")

    model_config = {"populate_by_name": True}


class SceneViewpointOut(BaseModel):
    """Saved camera viewpoint."""
    id: str
    name: str
    position: Vec3
    target: Vec3
    fov: float
    orderIndex: int = Field(alias="orderIndex")
    enabled: bool

    model_config = {"populate_by_name": True}


class SceneViewpointCreateRequest(BaseModel):
    """Create a new viewpoint from current camera pose."""
    name: str = Field(max_length=200)
    position: Vec3
    target: Vec3
    fov: float


class SceneViewpointUpdateRequest(BaseModel):
    """Update viewpoint properties."""
    name: str | None = Field(default=None, max_length=200)
    position: Vec3 | None = None
    target: Vec3 | None = None
    fov: float | None = None
    orderIndex: int | None = Field(default=None, alias="orderIndex")
    enabled: bool | None = None

    model_config = {"populate_by_name": True}


class SceneViewpointReorderRequest(BaseModel):
    """Reorder viewpoints."""
    viewpointIds: list[str] = Field(alias="viewpointIds")

    model_config = {"populate_by_name": True}


class BackgroundAudioUpdateRequest(BaseModel):
    """Update background audio settings."""
    assetId: str | None = Field(default=None, alias="assetId")
    volume: float | None = Field(default=None, alias="volume")
    loop: bool | None = Field(default=None, alias="loop")
    enabled: bool | None = Field(default=None, alias="enabled")

    model_config = {"populate_by_name": True}


class MessageOut(BaseModel):
    message: str
