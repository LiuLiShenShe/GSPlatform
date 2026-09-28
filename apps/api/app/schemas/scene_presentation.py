"""Scene Presentation DTOs — camera, transform, background, cover settings."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class Vec3(BaseModel):
    """3D vector for position/rotation/scale."""
    x: float
    y: float
    z: float


# ------------------------------------------------------------------ #
# Experience settings v2 (SSV-05)
#
# The official SuperSplat ExperienceSettings v2 is the single runtime schema.
# These types mirror the parts of it that GSPlatform authors, with explicit
# Pydantic validation (types + official ranges) so a malformed value is
# rejected at the API boundary rather than surfacing as a viewer error.
# ------------------------------------------------------------------ #

# Official `tonemapping` enum (ExperienceSettings.tonemapping).
Tonemapping = Literal[
    "none", "linear", "filmic", "hejl", "aces", "aces2", "neutral"
]

# ------------------------------------------------------------------ #
# Post effects — one structured JSONB field, validated with the exact
# official POST_EFFECT_RANGES so whatever is persisted here always survives
# the official validateSettings(settings, { limits: true }).
# ------------------------------------------------------------------ #
class SharpnessSettings(BaseModel):
    enabled: bool = False
    amount: float = Field(default=0.0, ge=0.0, le=1.0)


class BloomSettings(BaseModel):
    enabled: bool = False
    intensity: float = Field(default=1.0, ge=0.0, le=0.1)
    blurLevel: float = Field(default=2.0, ge=1.0, le=16.0)


class GradingSettings(BaseModel):
    enabled: bool = False
    brightness: float = Field(default=1.0, ge=0.0, le=3.0)
    contrast: float = Field(default=1.0, ge=0.5, le=1.5)
    saturation: float = Field(default=1.0, ge=0.0, le=2.0)
    tint: tuple[float, float, float] = (1.0, 1.0, 1.0)


class VignetteSettings(BaseModel):
    enabled: bool = False
    intensity: float = Field(default=0.5, ge=0.0, le=1.0)
    inner: float = Field(default=0.3, ge=0.0, le=3.0)
    outer: float = Field(default=0.75, ge=0.0, le=3.0)
    curvature: float = Field(default=1.0, ge=0.01, le=10.0)


class FringingSettings(BaseModel):
    enabled: bool = False
    intensity: float = Field(default=0.5, ge=0.0, le=100.0)


class PostEffects(BaseModel):
    """Structured post-processing document, mirroring the official
    `postEffectSettings` object. Stored as ONE JSONB column."""

    sharpness: SharpnessSettings = Field(default_factory=SharpnessSettings)
    bloom: BloomSettings = Field(default_factory=BloomSettings)
    grading: GradingSettings = Field(default_factory=GradingSettings)
    vignette: VignetteSettings = Field(default_factory=VignetteSettings)
    fringing: FringingSettings = Field(default_factory=FringingSettings)


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

    # Experience settings v2 (SSV-05)
    tonemapping: Tonemapping = Field(default="aces", alias="tonemapping")
    highPrecisionRendering: bool = Field(default=False, alias="highPrecisionRendering")
    postEffects: PostEffects | None = Field(default=None, alias="postEffects")

    # Collision settings (Phase 12)
    collisionMode: str | None = Field(default=None, alias="collisionMode")
    collisionAssetId: str | None = Field(default=None, alias="collisionAssetId")
    collisionGravity: float = Field(default=9.81, alias="collisionGravity")
    collisionSlopeLimitDegrees: float = Field(default=45.0, alias="collisionSlopeLimitDegrees")
    collisionStepOffset: float = Field(default=0.3, alias="collisionStepOffset")
    collisionPlayerHeight: float = Field(default=1.8, alias="collisionPlayerHeight")
    collisionEnabled: bool = Field(default=False, alias="collisionEnabled")

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

    # Experience settings v2 (SSV-05)
    tonemapping: Tonemapping | None = Field(default=None, alias="tonemapping")
    highPrecisionRendering: bool | None = Field(default=None, alias="highPrecisionRendering")
    postEffects: PostEffects | None = Field(default=None, alias="postEffects")

    # Collision settings (Phase 12)
    collisionMode: str | None = Field(default=None, alias="collisionMode")
    collisionAssetId: str | None = Field(default=None, alias="collisionAssetId")
    collisionGravity: float | None = Field(default=None, alias="collisionGravity")
    collisionSlopeLimitDegrees: float | None = Field(
        default=None, alias="collisionSlopeLimitDegrees"
    )
    collisionStepOffset: float | None = Field(default=None, alias="collisionStepOffset")
    collisionPlayerHeight: float | None = Field(default=None, alias="collisionPlayerHeight")
    collisionEnabled: bool | None = Field(default=None, alias="collisionEnabled")

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
