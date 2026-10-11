"""Conservative version validity for existing spatial authoring records."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SceneSpatialState(Base):
    __tablename__ = "scene_spatial_states"

    scene_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("scenes.id"), primary_key=True
    )
    source_version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("scene_versions.id"), nullable=False
    )
    state: Mapped[str] = mapped_column(String(20), nullable=False)
    stale_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
