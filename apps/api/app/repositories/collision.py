"""Collision asset repository — CRUD for collision_assets table."""

from __future__ import annotations

import uuid

from sqlalchemy.orm import Session

from app.db.models.collision_asset import CollisionAsset


class CollisionAssetRepository:
    """Repository for CollisionAsset CRUD operations."""

    def __init__(self, session: Session) -> None:
        self._session = session

    def get_by_scene_id(self, scene_id: uuid.UUID) -> CollisionAsset | None:
        """Get collision asset by scene ID."""
        return (
            self._session.query(CollisionAsset)
            .filter(CollisionAsset.scene_id == scene_id)
            .first()
        )

    def get_by_id(self, asset_id: uuid.UUID) -> CollisionAsset | None:
        """Get collision asset by ID."""
        return (
            self._session.query(CollisionAsset)
            .filter(CollisionAsset.id == asset_id)
            .first()
        )

    def create(
        self,
        scene_id: uuid.UUID,
        mode: str,
        gravity: float = 9.81,
        slope_limit_degrees: float = 45.0,
        step_offset: float = 0.3,
        player_height: float = 1.8,
    ) -> CollisionAsset:
        """Create a new collision asset."""
        asset = CollisionAsset(
            scene_id=scene_id,
            mode=mode,
            status="NONE",
            gravity=gravity,
            slope_limit_degrees=slope_limit_degrees,
            step_offset=step_offset,
            player_height=player_height,
            attempt=0,
        )
        self._session.add(asset)
        self._session.flush()
        return asset

    def update_status(
        self,
        asset_id: uuid.UUID,
        status: str,
        error_message: str | None = None,
        asset_id_ref: uuid.UUID | None = None,
        job_id: uuid.UUID | None = None,
    ) -> CollisionAsset | None:
        """Update collision asset status."""
        asset = self.get_by_id(asset_id)
        if asset is None:
            return None
        asset.status = status
        if error_message is not None:
            asset.error_message = error_message
        if asset_id_ref is not None:
            asset.asset_id = asset_id_ref
        if job_id is not None:
            asset.job_id = job_id
        self._session.flush()
        return asset

    def increment_attempt(self, asset_id: uuid.UUID) -> CollisionAsset | None:
        """Increment rebuild attempt counter."""
        asset = self.get_by_id(asset_id)
        if asset is None:
            return None
        asset.attempt += 1
        asset.status = "QUEUED"
        asset.error_message = None
        self._session.flush()
        return asset

    def update_params(
        self,
        asset_id: uuid.UUID,
        gravity: float | None = None,
        slope_limit_degrees: float | None = None,
        step_offset: float | None = None,
        player_height: float | None = None,
    ) -> CollisionAsset | None:
        """Update collision physics parameters."""
        asset = self.get_by_id(asset_id)
        if asset is None:
            return None
        if gravity is not None:
            asset.gravity = gravity
        if slope_limit_degrees is not None:
            asset.slope_limit_degrees = slope_limit_degrees
        if step_offset is not None:
            asset.step_offset = step_offset
        if player_height is not None:
            asset.player_height = player_height
        self._session.flush()
        return asset

    def delete(self, asset_id: uuid.UUID) -> bool:
        """Delete a collision asset."""
        asset = self.get_by_id(asset_id)
        if asset is None:
            return False
        self._session.delete(asset)
        self._session.flush()
        return True
