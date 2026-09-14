"""Model registry — importing this registers every model on Base.metadata."""

from __future__ import annotations

from app.db.models.asset import Asset
from app.db.models.enums import (
    AssetKind,
    JobKind,
    JobStatus,
    SceneCategory,
    SceneStatus,
    UploadSessionStatus,
    Visibility,
)
from app.db.models.job import Job
from app.db.models.scene import Scene, SceneVersion
from app.db.models.upload_session import UploadSession
from app.db.models.user import User

__all__ = [
    "Asset",
    "AssetKind",
    "Job",
    "JobKind",
    "JobStatus",
    "Scene",
    "SceneCategory",
    "SceneStatus",
    "SceneVersion",
    "UploadSession",
    "UploadSessionStatus",
    "User",
    "Visibility",
]
