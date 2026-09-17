"""Reconstruction service — submit / status / cancel for 3DGS pipeline jobs (Phase 07).

Flow:
  1. Client uploads media via POST /uploads with purpose=RECONSTRUCT.
  2. Client calls POST /uploads/{id}/complete — marks UPLOADED, no publish job.
  3. Client calls POST /compute/reconstruct with uploadIds → creates Scene + Job
     + dispatches tasks.reconstruct_cpu_stages via Celery.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable

from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.errors import ConflictError, NotFoundError
from app.core.identity import RequestIdentity
from app.db.models.enums import JobKind, JobStatus, SceneStatus
from app.db.models.job import Job
from app.db.models.scene import Scene
from app.db.models.upload_session import UploadSession
from app.repositories.uploads import UploadRepository
from app.schemas.compute import (
    ComputeCapabilitiesOut,
    ComputeProfileOut,
    CreateReconstructionRequest,
    ReconstructionJobOut,
)

logger = logging.getLogger("gsplatform.api.compute")

RECONSTRUCT_TASK = "tasks.reconstruct_cpu_stages"

# Canonical upload status values that indicate a finished upload.
_COMPLETE_UPLOAD_STATUSES = frozenset({"UPLOADED", "SUCCEEDED"})

# send_task signature: (name: str, *, args: list[str] | None = None) -> object.
SendTask = Callable[..., object]


class ReconstructionService:
    """Compute-layer use cases: submit, capabilities, profiles, cancel."""

    def __init__(self, session: Session, settings: Settings) -> None:
        self._session = session
        self._settings = settings
        self._repo = UploadRepository(session)

    # ------------------------------------------------------------------ #
    # submit reconstruction
    # ------------------------------------------------------------------ #
    def submit_reconstruction(
        self,
        req: CreateReconstructionRequest,
        identity: RequestIdentity,
        send_task: SendTask | None = None,
    ) -> ReconstructionJobOut:
        """Create a Scene + RECONSTRUCT Job and dispatch the CPU-stages task."""

        # 1. Verify all uploads exist, are owned, are complete, and have a
        #    compatible purpose (RECONSTRUCT or PUBLISH — legacy compat).
        uploads = self._verify_uploads(req, identity)

        # 2. Create draft Scene (status=PROCESSING).
        scene = self._create_draft_scene(req, identity, uploads)

        # 3. Create Job(kind=RECONSTRUCT, status=QUEUED, progress=0).
        job = Job(
            scene_id=scene.id,
            owner_id=identity.user_id,
            kind=JobKind.RECONSTRUCT.value,
            status=JobStatus.QUEUED.value,
            progress=0,
        )
        self._session.add(job)
        self._session.flush()

        # 4. Commit BEFORE dispatch so the worker sees the committed rows.
        self._session.commit()

        # 5. Dispatch the Celery task.
        if send_task is None:
            raise ConflictError("Celery 队列未配置，无法提交重建任务")
        upload_id_strs = [str(uid) for uid in req.uploadIds]
        send_task(
            RECONSTRUCT_TASK,
            args=[str(job.id), upload_id_strs, req.profile],
        )

        logger.info(
            "Reconstruction submitted: job=%s scene=%s profile=%s uploads=%d",
            job.id,
            scene.id,
            req.profile,
            len(uploads),
        )

        return self._job_to_out(job, scene)

    # ------------------------------------------------------------------ #
    # cancel
    # ------------------------------------------------------------------ #
    def cancel_job(
        self,
        job_id: uuid.UUID,
        identity: RequestIdentity,
    ) -> ReconstructionJobOut:
        """Owner-gated cancel: flip job to CANCEL_REQUESTED (best-effort)."""
        job = self._session.query(Job).filter(Job.id == job_id).first()
        if job is None or job.owner_id != identity.user_id:
            raise NotFoundError("任务不存在或无权操作")
        if job.kind != JobKind.RECONSTRUCT.value:
            raise ConflictError("仅支持取消重建任务")
        if job.status not in (JobStatus.QUEUED.value, JobStatus.RUNNING.value):
            raise ConflictError(
                f"任务状态为 {job.status}，无法取消"
            )

        job.status = JobStatus.CANCEL_REQUESTED.value
        self._session.commit()

        scene = self._session.query(Scene).filter(Scene.id == job.scene_id).first()
        return self._job_to_out(job, scene)

    # ------------------------------------------------------------------ #
    # capabilities / profiles (probe workers package)
    # ------------------------------------------------------------------ #
    @staticmethod
    def get_capabilities() -> ComputeCapabilitiesOut:
        """Probe the worker host for reconstruction tool availability."""
        try:
            from workers.reconstruction.capabilities import (  # type: ignore[import-not-found]
                check_capabilities,
            )

            report = check_capabilities(with_gpu_probe=True)
            return ComputeCapabilitiesOut(
                ok=report.ok,
                tools=report.tools,
                gpu=report.gpu,
                problems=report.problems,
            )
        except Exception:
            logger.warning(
                "Capability probe unavailable — workers package not importable",
                exc_info=True,
            )
            return ComputeCapabilitiesOut(
                ok=False,
                tools={},
                gpu={"available": False},
                problems=["capability probe unavailable"],
            )

    @staticmethod
    def list_profiles() -> list[ComputeProfileOut]:
        """Return available quality profiles from the workers package."""
        try:
            from workers.reconstruction.profiles import (  # type: ignore[import-not-found]
                list_public_profiles,
            )

            raw = list_public_profiles()
            return [ComputeProfileOut(**p) for p in raw]
        except Exception:
            logger.warning(
                "Profile list unavailable — workers package not importable",
                exc_info=True,
            )
            return []

    # ------------------------------------------------------------------ #
    # internals
    # ------------------------------------------------------------------ #
    def _verify_uploads(
        self,
        req: CreateReconstructionRequest,
        identity: RequestIdentity,
    ) -> list[UploadSession]:
        """Validate upload ownership, status, and return session objects."""
        seen: set[uuid.UUID] = set()
        uploads: list[UploadSession] = []
        for uid in req.uploadIds:
            if uid in seen:
                raise ConflictError(f"重复的上传 ID: {uid}")
            seen.add(uid)

            us = self._repo.get_owned(uid, identity.user_id)
            if us is None:
                raise NotFoundError(f"上传 {uid} 不存在或不属于当前用户")

            # Accept RECONSTRUCT (intended) or PUBLISH (legacy compat) purpose,
            # but reject purpose-mismatched uploads with a clear message.
            if us.purpose not in ("RECONSTRUCT", "PUBLISH"):
                raise ConflictError(
                    f"上传 {uid} 的用途为 {us.purpose}，不支持用于重建"
                )

            if us.status not in _COMPLETE_UPLOAD_STATUSES:
                raise ConflictError(
                    f"上传 {uid} 状态为 {us.status}，尚未完成"
                )

            uploads.append(us)
        return uploads

    def _create_draft_scene(
        self,
        req: CreateReconstructionRequest,
        identity: RequestIdentity,
        uploads: list[UploadSession],
    ) -> Scene:
        """Create a PROCESSING scene for the reconstruction output."""
        # Derive a slug from the first upload id for uniqueness.
        first_upload = uploads[0]
        slug = self._generate_slug(identity.user_id, first_upload.id)

        title = req.sceneTitle
        description = req.description
        scene = Scene(
            owner_id=identity.user_id,
            slug=slug,
            title=title,
            description=description,
            category="experiment",
            visibility=req.visibility,
            status=SceneStatus.PROCESSING.value,
        )
        self._session.add(scene)
        self._session.flush()
        return scene

    @staticmethod
    def _generate_slug(owner_id: uuid.UUID, seed: uuid.UUID) -> str:
        import hashlib

        raw = f"{owner_id}-{seed}"
        digest = hashlib.sha256(raw.encode()).hexdigest()[:12]
        return f"r-{digest}"

    @staticmethod
    def _job_to_out(job: Job, scene: Scene | None) -> ReconstructionJobOut:
        return ReconstructionJobOut(
            jobId=job.id,
            status=job.status,
            stage=job.stage,
            progress=job.progress,
            errorCode=job.error_code,
            errorMessage=job.error_message_safe,
            createdAt=job.created_at,
            updatedAt=job.updated_at,
            sceneId=str(scene.id) if scene is not None else None,
        )
