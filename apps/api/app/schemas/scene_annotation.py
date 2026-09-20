"""Scene Annotation DTOs — 3D hotspot annotation create/update/read."""
from __future__ import annotations

from pydantic import BaseModel, Field


class SceneAnnotationOut(BaseModel):
    """Annotation output DTO."""
    id: str
    title: str
    description: str
    anchorX: float = Field(alias="anchorX")
    anchorY: float = Field(alias="anchorY")
    anchorZ: float = Field(alias="anchorZ")
    style: str  # LEADER_TEXT | NUMBER_POPUP | HIDDEN
    contentType: str = Field(alias="contentType")  # TEXT | IMAGE | VIDEO | AUDIO | PANORAMA
    textContent: str = Field(default="", alias="textContent")
    mediaAssetId: str | None = Field(default=None, alias="mediaAssetId")
    textColor: str = Field(default="#FFFFFF", alias="textColor")
    textSize: int = Field(default=14, alias="textSize")
    fov: float = Field(default=60.0)
    orderIndex: int = Field(default=0, alias="orderIndex")
    enabled: bool = Field(default=True)

    model_config = {"populate_by_name": True}


class SceneAnnotationCreateRequest(BaseModel):
    """Create annotation at a Gaussian-picked world position."""
    title: str = Field(default="", max_length=500)
    description: str = Field(default="", max_length=5000)
    anchorX: float = Field(alias="anchorX")
    anchorY: float = Field(alias="anchorY")
    anchorZ: float = Field(alias="anchorZ")
    style: str = Field(default="LEADER_TEXT")
    contentType: str = Field(default="TEXT", alias="contentType")
    textContent: str = Field(default="", max_length=10000, alias="textContent")
    mediaAssetId: str | None = Field(default=None, alias="mediaAssetId")
    textColor: str = Field(default="#FFFFFF", alias="textColor")
    textSize: int = Field(default=14, alias="textSize")
    fov: float = Field(default=60.0)

    model_config = {"populate_by_name": True}


class SceneAnnotationUpdateRequest(BaseModel):
    """Partial update for annotation."""
    title: str | None = Field(default=None, max_length=500)
    description: str | None = Field(default=None, max_length=5000)
    anchorX: float | None = Field(default=None, alias="anchorX")
    anchorY: float | None = Field(default=None, alias="anchorY")
    anchorZ: float | None = Field(default=None, alias="anchorZ")
    style: str | None = None
    contentType: str | None = Field(default=None, alias="contentType")
    textContent: str | None = Field(default=None, max_length=10000, alias="textContent")
    mediaAssetId: str | None = Field(default=None, alias="mediaAssetId")
    textColor: str | None = Field(default=None, alias="textColor")
    textSize: int | None = Field(default=None, alias="textSize")
    fov: float | None = None
    orderIndex: int | None = Field(default=None, alias="orderIndex")
    enabled: bool | None = None

    model_config = {"populate_by_name": True}


class SceneAnnotationReorderRequest(BaseModel):
    """Reorder annotations."""
    annotationIds: list[str] = Field(alias="annotationIds")

    model_config = {"populate_by_name": True}
