from typing import Literal

from pydantic import BaseModel, ConfigDict


class CreateMeshAsset(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sourcePlySha256: str
    upAxis: Literal["+X", "-X", "+Y", "-Y", "+Z", "-Z"]
    confirmOrientation: Literal[True]
