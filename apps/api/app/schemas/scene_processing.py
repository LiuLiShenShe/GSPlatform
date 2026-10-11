"""Processing settings and the minimal non-physical assumption contract."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

SceneType = Literal["UNSPECIFIED", "PLANT_OBJECT", "GREENHOUSE_SCENE", "FIELD_SCENE"]
ConversionProfile = Literal["balanced", "eco", "quality"]
CollisionPolicy = Literal["MANUAL_ONLY", "AUTO_WHEN_CALIBRATED"]
CalibrationState = Literal["UNVERIFIED", "ASSUMED", "VERIFIED"]


class ScaleAssumption(BaseModel):
    model_config = ConfigDict(extra="forbid")

    state: Literal["UNVERIFIED", "ASSUMED"]
    metersPerSceneUnit: float | None = Field(default=None, gt=0, allow_inf_nan=False, strict=True)
    referenceMethod: Literal["USER_ASSUMPTION"] | None = None
    referenceValue: float | None = Field(default=None, gt=0, allow_inf_nan=False, strict=True)
    provenance: str | None = Field(default=None, min_length=1, max_length=2000)

    @model_validator(mode="after")
    def require_assumption(self) -> ScaleAssumption:
        if self.state == "ASSUMED" and (
            self.metersPerSceneUnit is None
            or self.referenceMethod is None
            or self.referenceValue is None
            or not self.provenance
            or not self.provenance.strip()
        ):
            raise ValueError("ASSUMED requires an explicit scale, reference and provenance")
        return self


class CalibrationOut(BaseModel):
    state: CalibrationState = "UNVERIFIED"
    recordedState: CalibrationState = "UNVERIFIED"
    metersPerSceneUnit: float | None = None
    referenceMethod: str | None = None
    referenceValue: float | None = None
    sourceVersion: str | None = None
    transformIdentity: str | None = None
    evidence: dict[str, Any] | None = None
    stale: bool = False
    physicalWalkAllowed: bool = False


class SceneProcessingPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sceneType: SceneType | None = None
    conversionProfile: ConversionProfile | None = None
    collisionPolicy: CollisionPolicy | None = None
    calibration: ScaleAssumption | None = None

    @model_validator(mode="after")
    def reject_explicit_null(self) -> SceneProcessingPatch:
        if any(getattr(self, name) is None for name in self.model_fields_set):
            raise ValueError("Processing settings cannot be null")
        return self


class SceneProcessingOut(BaseModel):
    sceneType: SceneType = "UNSPECIFIED"
    conversionProfile: ConversionProfile = "balanced"
    collisionPolicy: CollisionPolicy = "MANUAL_ONLY"
    calibration: CalibrationOut = Field(default_factory=CalibrationOut)
    createdAt: datetime | None = None
    updatedAt: datetime | None = None
