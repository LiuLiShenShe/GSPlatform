"""Model registry — importing this registers every model on Base.metadata."""

from __future__ import annotations

from app.db.models.asset import Asset
from app.db.models.audit import AuditEvent
from app.db.models.enums import (
    AssetKind,
    JobKind,
    JobStatus,
    SceneCategory,
    SceneStatus,
    UploadSessionStatus,
    Visibility,
)
from app.db.models.favorite import Favorite
from app.db.models.job import Job
from app.db.models.scene import Scene, SceneVersion
from app.db.models.scene_presentation import ScenePresentation
from app.db.models.scene_viewpoint import SceneViewpoint
from app.db.models.session import Session
from app.db.models.share_link import ShareLink
from app.db.models.upload_session import UploadSession
from app.db.models.user import User

__all__ = [
    "Asset",
    "AssetKind",
    "AuditEvent",
    "Favorite",
    "Job",
    "JobKind",
    "JobStatus",
    "Scene",
    "SceneCategory",
    "ScenePresentation",
    "SceneStatus",
    "SceneVersion",
    "SceneViewpoint",
    "Session",
    "ShareLink",
    "UploadSession",
    "UploadSessionStatus",
    "User",
    "Visibility",
]
