"""SceneRuntimeDescriptorV1 — unified runtime scene contract (SSV-01).

Single source of truth for what any Viewer runtime (Desktop / XR / Share)
needs to render a scene: scene identity, loadable content, presentation
settings, viewpoints, annotations, background audio and collision — all
assembled from the existing DB models, never invented for the DTO.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class RuntimeVec3(BaseModel):
    """3D vector for positions / targets / transforms."""

    x: float
    y: float
    z: float


class RuntimeSceneOut(BaseModel):
    """Scene identity block (external id = business slug)."""

    id: str
    name: str
    posterUrl: str | None = Field(default=None, alias="posterUrl")

    model_config = {"populate_by_name": True}


class RuntimeContentOut(BaseModel):
    """Loadable content for the Viewer.

    ``url`` is a viewer-accessible same-origin asset URL.  FIX-01: the
    descriptor always emits the authorized endpoint
    (``/api/v1/scenes/<slug>/assets/...``) so private gaussian bytes are never
    reachable through a public static path; the legacy ``/local-scenes/...``
    prefix is re-homed by the service.  Never a server-local filesystem path.
    ``format`` is derived from the actual asset filename / metadata:
    ``sog`` | ``ply`` | ``compressed-ply`` | ``meta`` | ``lod-meta``.
    Both are ``None`` when the scene has no published version yet.
    """

    url: str | None = None
    format: str | None = None


class RuntimeWorldTransform(BaseModel):
    """World transform applied to the splat (does not modify the SOG)."""

    position: RuntimeVec3 | None = None
    rotation: RuntimeVec3 | None = None
    scale: RuntimeVec3 | None = None


class RuntimeInitialCamera(BaseModel):
    """Initial camera pose (fov in degrees)."""

    position: RuntimeVec3 | None = None
    target: RuntimeVec3 | None = None
    fov: float | None = None


class RuntimeBackground(BaseModel):
    """Background: solid color or equirectangular panorama asset."""

    type: str = "color"  # color | equirectangular
    color: RuntimeVec3 | None = None
    url: str | None = None  # panorama asset URL (served via presentation route)


class RuntimePresentation(BaseModel):
    """Presentation settings block — from ScenePresentation model.

    The rendering fields map 1:1 onto the official SuperSplat
    ExperienceSettings v2 (SSV-05). Old scenes that never authored them read
    as the official defaults; the front-end adapter always starts from
    ``defaultSettings()`` so a missing value is never invalid.
    """

    worldTransform: RuntimeWorldTransform = Field(alias="worldTransform")
    initialCamera: RuntimeInitialCamera = Field(alias="initialCamera")
    background: RuntimeBackground
    # Official ExperienceSettings v2 scalars.
    tonemapping: str = "aces"  # none | linear | filmic | hejl | aces | aces2 | neutral
    highPrecisionRendering: bool = False
    # Structured post-processing document (null = official defaults).
    postEffects: dict[str, Any] | None = None

    model_config = {"populate_by_name": True}


class RuntimeViewpoint(BaseModel):
    """Saved camera viewpoint."""

    id: str
    name: str
    position: RuntimeVec3
    target: RuntimeVec3
    fov: float
    orderIndex: int = Field(alias="orderIndex")
    enabled: bool

    model_config = {"populate_by_name": True}


class RuntimeAnnotation(BaseModel):
    """3D hotspot annotation anchored to a Gaussian surface position."""

    id: str
    title: str
    description: str
    anchor: RuntimeVec3
    style: str  # LEADER_TEXT | NUMBER_POPUP | HIDDEN
    contentType: str = Field(alias="contentType")  # TEXT | IMAGE | VIDEO | AUDIO | PANORAMA
    textContent: str = Field(default="", alias="textContent")
    # Media asset URL. Null until the annotation media serving mechanism is
    # wired (SSV-06) — no generic asset serve route exists yet.
    mediaAssetUrl: str | None = Field(default=None, alias="mediaAssetUrl")
    textColor: str = Field(default="#FFFFFF", alias="textColor")
    textSize: int = Field(default=14, alias="textSize")
    fov: float = Field(default=60.0)
    # Per-annotation camera pose (FIX-02 §12-§14).  Null = no authored camera;
    # the front-end adapter falls back to the scene initial camera.  Never a
    # shared default guess.
    cameraPosition: RuntimeVec3 | None = Field(default=None, alias="cameraPosition")
    cameraTarget: RuntimeVec3 | None = Field(default=None, alias="cameraTarget")
    cameraFov: float | None = Field(default=None, alias="cameraFov")
    orderIndex: int = Field(default=0, alias="orderIndex")
    enabled: bool = Field(default=True)

    model_config = {"populate_by_name": True}


class RuntimeBackgroundAudio(BaseModel):
    """Background audio asset + playback settings."""

    url: str | None = None  # served via GET /api/v1/scenes/{scene_id}/presentation/background-audio
    volume: float = Field(default=0.5)
    loop: bool = Field(default=True)
    enabled: bool = Field(default=False)

    model_config = {"populate_by_name": True}


class RuntimeCollision(BaseModel):
    """Collision runtime block — populated only when a built artifact exists.

    ``format`` is ``voxel`` (native octree; preferred) or ``glb`` (mesh
    fallback). The official viewer routes by the served url extension.

    FIX-05 §22-§25: the official viewer cannot reliably re-transform a built
    collision, so a collision is STALE once the scene's world transform
    changes after the build (``worldTransformHash`` mismatch) — the UI must
    disable walk and ask the owner to rebuild. ``worldTransformHash`` records
    the transform the build was performed under (``None`` = identity/absent).
    """

    url: str | None = None  # served via GET /api/v1/scenes/{scene_id}/collision/*
    format: str  # glb | voxel
    mode: str  # INDOOR | OUTDOOR
    gravity: float
    slopeLimitDegrees: float = Field(alias="slopeLimitDegrees")
    stepOffset: float = Field(alias="stepOffset")
    playerHeight: float = Field(alias="playerHeight")
    enabled: bool
    stale: bool = False
    worldTransformHash: str | None = Field(alias="worldTransformHash", default=None)

    model_config = {"populate_by_name": True}


class SceneRuntimeDescriptorV1(BaseModel):
    """The unified runtime scene contract.

    Fixed logical structure (SSV-01):
      schemaVersion / scene / content / presentation / viewpoints /
      annotations / backgroundAudio / collision
    Missing data is serialized as ``null`` / ``[]`` / defaults — never by
    adding ad-hoc DB fields.
    """

    schemaVersion: int = 1
    scene: RuntimeSceneOut
    content: RuntimeContentOut
    presentation: RuntimePresentation
    viewpoints: list[RuntimeViewpoint] = []
    annotations: list[RuntimeAnnotation] = []
    backgroundAudio: RuntimeBackgroundAudio | None = None
    collision: RuntimeCollision | None = None

    model_config = {"populate_by_name": True}
