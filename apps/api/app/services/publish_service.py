"""Publish service — atomic version publication & DB consistency (Phase 06).

Invoked by the Celery ``publish_scene`` task after the pipeline has assembled
a fully-verified version directory. The contract:

- the version dir is immutable (``published/<scene-id>/versions/<sha>/``);
- it is moved into place on the same filesystem **before** any DB write;
- a single DB transaction creates SceneVersion + Assets and updates
  ``Scene.current_version_id`` / status;
- any DB failure leaves the file version orphaned but harmless (never
  *committed* as current); any file failure never reaches the DB.

The scene row itself is created at upload-complete time (DRAFT→PROCESSING) so
the scene id exists before the worker runs.
"""

from __future__ import annotations

import uuid

from sqlalchemy.orm import Session

from app.core.errors import NotFoundError
from app.db.models.asset import Asset
from app.db.models.enums import (
    AssetKind,
    JobStatus,
    SceneStatus,
    UploadSessionStatus,
)
from app.db.models.job import Job
from app.db.models.scene import Scene, SceneVersion
from app.repositories.uploads import UploadRepository
from app.storage.base import Storage


class PublishService:
    """Coordinates publish pipeline with the database."""

    def __init__(self, session: Session, storage: Storage) -> None:
        self._session = session
        self._storage = storage
        self._uploads = UploadRepository(session)

    # ------------------------------------------------------------------ #
    # helpers
    # ------------------------------------------------------------------ #
    def _published_root(self, scene_id: uuid.UUID) -> str:
        return f"published/{scene_id}"

    def _version_rel(self, version_id: str) -> str:
        return f"versions/{version_id}"

    # ------------------------------------------------------------------ #
    # public API
    # ------------------------------------------------------------------ #
    def begin(
        self, scene_id: uuid.UUID, version_id: str
    ) -> str:
        """Create the immutable version directory key and the staging key.

        Returns the **staging** key the pipeline must write to; the pipeline
        calls :meth:`promote_staging_to_version` once verified.
        """
        published_root = self._published_root(scene_id)
        self._storage.mkdir(f"{published_root}/versions")
        return f"{published_root}/.staging/{version_id}"

    def promote_staging_to_version(
        self, scene_id: uuid.UUID, version_id: str, staging_key: str
    ) -> str:
        """Atomically rename the verified staging dir into the version dir."""
        published_root = self._published_root(scene_id)
        version_key = f"{published_root}/{self._version_rel(version_id)}"
        if self._storage.exists(version_key):
            # idempotent re-publish: drop the old same-content dir and re-rename
            self._storage.delete(version_key)
        self._storage.atomic_rename_dir(staging_key, version_key)
        return version_key

    def commit_version(
        self,
        *,
        scene_id: uuid.UUID,
        version_id: str,
        manifest: dict,
        entry_bytes: int,
        entry_url: str,
        counts: list[int],
        source_sha256: str,
    ) -> SceneVersion:
        """Persist SceneVersion + Assets and flip the scene to PUBLISHED.

        Runs in one DB transaction; raises on conflict so the caller can
        roll back (never a partial commit).
        """
        scene = self._session.query(Scene).filter(Scene.id == scene_id).first()
        if scene is None:
            raise NotFoundError("场景不存在")

        version = SceneVersion(
            scene_id=scene.id,
            asset_version=version_id,
            format="streamed-sog",
            size_bytes=entry_bytes,
            sha256=source_sha256,
            manifest=manifest,
        )
        self._session.add(version)
        self._session.flush()

        # Assets: manifest + SOG entry + poster (if any).
        poster = manifest.get("poster") or {}
        assets = [
            Asset(
                scene_id=scene.id,
                version_id=version.id,
                kind=AssetKind.MANIFEST.value,
                storage_key=f"published/{scene_id}/versions/{version_id}/manifest.json",
                mime_type="application/json",
                byte_size=0,
                sha256="",
                metadata_={"entryUrl": entry_url},
            ),
            Asset(
                scene_id=scene.id,
                version_id=version.id,
                kind=AssetKind.SOG.value,
                storage_key=f"published/{scene_id}/versions/{version_id}/lod-meta.json",
                mime_type="application/json",
                byte_size=entry_bytes,
                sha256=source_sha256,
                metadata_={"counts": counts, "lodLevels": len(counts)},
            ),
        ]
        if poster.get("url"):
            assets.append(
                Asset(
                    scene_id=scene.id,
                    version_id=version.id,
                    kind=AssetKind.POSTER.value,
                    storage_key=(
                        f"published/{scene_id}/versions/{version_id}/poster.webp"
                    ),
                    mime_type="image/webp",
                    byte_size=0,
                    sha256="",
                    metadata_={},
                )
            )
        self._session.add_all(assets)

        # Flip current version + publish state atomically.
        scene.current_version_id = version.id
        scene.status = SceneStatus.PUBLISHED.value
        scene.published_at = version.created_at
        scene.splat_count = sum(counts)
        self._session.flush()
        return version

    def mark_upload_succeeded(self, upload_id: uuid.UUID) -> None:
        self._uploads.update_status(upload_id, UploadSessionStatus.SUCCEEDED)

    def mark_job_succeeded(self, job: Job) -> None:
        job.status = JobStatus.SUCCEEDED.value
        job.stage = "SUCCEEDED"
        job.progress = 100
        self._session.flush()

    def mark_job_failed(self, job: Job, *, stage: str, message: str) -> None:
        job.status = JobStatus.FAILED.value
        job.stage = stage
        job.progress = 0
        job.error_code = "PUBLISH_FAILED"
        job.error_message_safe = message[:1000]
        self._session.flush()

    def mark_upload_failed(self, upload_id: uuid.UUID) -> None:
        self._uploads.update_status(upload_id, UploadSessionStatus.FAILED)

    def quarantine(self, scene_id: uuid.UUID, upload_id: uuid.UUID) -> str:
        """Move a failed upload's staging assets to the quarantine zone."""
        key = f"quarantine/{upload_id}"
        src = f"staging/{upload_id}"
        if self._storage.exists(src):
            self._storage.atomic_rename_dir(src, key)
        return key
