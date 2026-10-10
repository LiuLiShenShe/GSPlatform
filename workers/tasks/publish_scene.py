"""Celery tasks — upload→publish pipeline and periodic cleanup (Phase 06).

The ``publish_scene`` task implements the full VALIDATING→CONVERTING→VERIFYING→PUBLISHING
state machine described in PHASE_06.md. Progress is driven by real pipeline stages,
never timers.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from workers.celery_app import celery_app

from app.core.config import settings
from app.db.models.enums import JobStatus, UploadSessionStatus
from app.db.models.job import Job
from app.db.session import SessionLocal
from app.repositories.uploads import UploadRepository
from app.services.publish_service import PublishService
from app.storage import LocalDiskStorage

logger = logging.getLogger("gsplatform.workers.publish")


def _get_storage() -> LocalDiskStorage:
    return LocalDiskStorage(settings.storage_root)


# ──────────────────────────────────────────────────────────────────────────────
# publish_scene — validates, converts, verifies and publishes a single upload.
# ──────────────────────────────────────────────────────────────────────────────
@celery_app.task(
    bind=True,
    name="tasks.publish_scene",
    max_retries=1,
    default_retry_delay=30,
    acks_late=True,
)
def publish_scene(self, upload_id: str, scene_id: str, job_id: str) -> dict:
    """Execute the full upload→publish pipeline."""
    uid = uuid.UUID(upload_id)
    sid = uuid.UUID(scene_id)
    jid = uuid.UUID(job_id)

    session = SessionLocal()
    storage = _get_storage()
    repo = UploadRepository(session)
    publish_svc = PublishService(session, storage)

    us = repo.get_by_id(uid)
    if us is None:
        logger.error("UploadSession %s not found", upload_id)
        session.close()
        return {"ok": False, "error": "upload_session_not_found"}

    job = session.query(Job).filter(Job.id == jid).first()
    if job is None:
        logger.error("Job %s not found", job_id)
        session.close()
        return {"ok": False, "error": "job_not_found"}

    # Duplicate-delivery guard (FIX-06 §11): with acks_late a completed task
    # can be redelivered after a worker crash. A SUCCEEDED job must not be
    # mutated again (no second promote/commit/status flip).
    if job.status == JobStatus.SUCCEEDED.value:
        # FIX-UPLOAD-01.1 §B: a completed publish redelivered after a crash may
        # have committed the publish WITHOUT chaining the auto-collision (the
        # crash window between ``commit_version`` and the chaining block).  The
        # duplicate-delivery branch therefore re-asserts the collision chain
        # for the current version — idempotent, never re-publishes.
        try:
            from app.services.celery_client import send_task
            from app.services.collision import CollisionService

            coll_svc = CollisionService(session, storage, send_task=send_task)
            coll_svc.ensure_auto_collision_for_current_version(
                sid, us.owner_id, retry_failed=True
            )
            session.commit()
        except Exception:
            session.rollback()
            logger.exception(
                "Duplicate-delivery collision recovery failed for scene %s", scene_id
            )
        logger.info("Job %s already SUCCEEDED; ignoring duplicate delivery", job_id)
        session.close()
        return {"ok": True, "duplicate": True, "version": "existing"}

    if us.scene_id != sid or job.scene_id != sid or job.owner_id != us.owner_id:
        session.close()
        return {"ok": False, "error": "publish_ownership_mismatch"}
    from workers.tasks.build_collision import LeaseHeartbeat, _claim_execution_rights

    claim = _claim_execution_rights(session, job_id)
    if claim.decision != "EXECUTE":
        session.close()
        return {"ok": True, "duplicate": True, "status": claim.decision}
    heartbeat = LeaseHeartbeat(job_id=jid, generation=claim.generation)
    heartbeat.start()

    job.attempt += 1
    job.status = "RUNNING"
    session.flush()

    source_path = Path(settings.storage_root) / us.storage_key
    quarantined_source = (
        Path(settings.storage_root) / "quarantine" / str(uid) / source_path.name
    )
    if not source_path.exists() and quarantined_source.is_file():
        source_path = quarantined_source
    source_validated = False
    # staging key: published/<scene_id>/.staging/<ver>
    staging_key = ""
    # Set once the conversion has told us which version dir it wrote, so the
    # finally-block can clean up exactly that dir (see comment there).
    version_staging: Path | None = None

    try:
        # ── 1. VALIDATING ─────────────────────────────────────────────────────
        job.stage = "VALIDATING"
        job.progress = 5
        session.flush()
        repo.update_status(uid, UploadSessionStatus.VALIDATING)

        if not source_path.exists():
            raise FileNotFoundError(f"暂存文件缺失: {source_path}")

        from workers.pipeline.validate_scene import validate_upload

        vr = validate_upload(
            source_path,
            declared_format=us.upload_format,
            declared_mime=us.mime_type,
            expected_size=us.total_size,
            expected_sha256=us.declared_sha256,
        )
        if not vr.ok:
            raise ValueError(f"上传文件验证失败: {vr.reason}")
        source_validated = True

        job.progress = 20
        session.flush()

        # ── 2. CONVERTING ─────────────────────────────────────────────────────
        job.stage = "CONVERTING"
        repo.update_status(uid, UploadSessionStatus.CONVERTING)
        # COMMIT before the conversion starts.  The stage/progress transitions
        # used to be flush-only, which (a) hid real progress from the status
        # API and (b) held a row lock on the upload session for the WHOLE
        # conversion — on a 13M-gaussian PLY that is hours, during which any
        # DELETE/cancel on that upload (or a test-suite cleanup) blocks behind
        # it.  Committing here releases the lock and publishes the stage; the
        # idempotency guard at the top still makes a redelivery safe.
        session.commit()

        scene_dir = Path(settings.storage_root) / "published" / str(sid)
        scene_dir.mkdir(parents=True, exist_ok=True)
        staging_path = scene_dir / f".staging-{jid}-{claim.generation}"

        def record_stage(stage: str, state: str, record: dict) -> None:
            if heartbeat.lost:
                raise RuntimeError("Publish execution lease lost")
            job.stage = stage
            session.commit()
            logger.info(
                "publish stage=%s state=%s timing=%s", stage, state, json.dumps(record)
            )

        from workers.pipeline.convert_scene import convert_to_streamed_sog

        cr = convert_to_streamed_sog(
            source_path,
            staging_path,
            scene_id=str(sid),
            profile="balanced",
            # device resolved from GS_CONVERT_GPU at call time (default "cpu");
            # was previously hardcoded "cpu" regardless of available hardware.
            source_format=us.upload_format,
            on_stage=record_stage,
        )
        if not cr.ok:
            raise ValueError(f"转换失败: {cr.reason}")

        ver = cr.version_id
        # convert_to_streamed_sog writes into a VERSION-scoped subdirectory of
        # the staging root; promote/verify must address that same dir.  Keeping
        # the version in the key is also what makes two concurrent publishes of
        # one scene disjoint (they used to share ``.staging`` and each entry
        # rmtree'd the other's partial output).
        version_staging = cr.staging_dir or staging_path / ver
        staging_key = version_staging.relative_to(
            Path(settings.storage_root)
        ).as_posix()
        logger.info(
            "Conversion done: version=%s recipe=%s stages=%s",
            ver,
            json.dumps(cr.recipe or {}, sort_keys=True),
            json.dumps(cr.stage_durations or {}),
        )
        job.progress = 70
        session.flush()

        # ── 3. VERIFYING ──────────────────────────────────────────────────────
        job.stage = "VERIFYING"
        session.flush()
        repo.update_status(uid, UploadSessionStatus.VERIFYING)
        session.commit()

        from workers.pipeline.verify_publish import verify_published_version

        started = time.monotonic()
        verify_started = datetime.now(timezone.utc).isoformat()
        verify_published_version(version_staging)
        logger.info(
            "publish stage=VERIFYING state=SUCCEEDED startedAt=%s finishedAt=%s elapsedSeconds=%.3f",
            verify_started,
            datetime.now(timezone.utc).isoformat(),
            time.monotonic() - started,
        )
        job.progress = 85
        session.flush()

        # ── 4. PROMOTE + PUBLISH ──────────────────────────────────────────────
        job.stage = "PUBLISHING"
        session.flush()
        repo.update_status(uid, UploadSessionStatus.PUBLISHING)
        session.commit()
        started = time.monotonic()
        publish_started = datetime.now(timezone.utc).isoformat()

        from sqlalchemy import select

        owned_job = session.scalars(
            select(Job)
            .where(Job.id == jid)
            .with_for_update()
            .execution_options(populate_existing=True)
        ).one()
        if heartbeat.lost or owned_job.execution_generation != claim.generation:
            raise RuntimeError("Publish execution generation changed")
        if owned_job.status != JobStatus.RUNNING.value:
            raise RuntimeError("Publish job is no longer running")
        if version_staging != scene_dir / "versions" / ver:
            publish_svc.promote_staging_to_version(sid, ver, staging_key)

        publish_svc.commit_version(
            scene_id=sid,
            version_id=ver,
            manifest=cr.manifest or {},
            entry_bytes=cr.entry_bytes,
            entry_url=f"versions/{ver}/lod-meta.json",
            counts=(cr.manifest or {}).get("stream", {}).get("counts", [0, 0, 0]),
            source_sha256=cr.source_sha256,
        )
        job.progress = 100
        job.stage = "SUCCEEDED"
        job.status = "SUCCEEDED"
        job.finished_at = datetime.now(timezone.utc)
        job.lease_expires_at = None
        publish_svc.mark_upload_succeeded(uid)
        session.commit()
        logger.info(
            "publish stage=PUBLISHING state=SUCCEEDED startedAt=%s finishedAt=%s elapsedSeconds=%.3f",
            publish_started,
            datetime.now(timezone.utc).isoformat(),
            time.monotonic() - started,
        )
        logger.info("Published scene %s (version %s)", scene_id, ver)

        # ── 5. AUTO-COLLISION (FIX-UPLOAD-01 §7-§9 / §B recovery) ───────────
        # Publishing is complete and committed; now chain the collision build.
        # Publish success must NOT depend on collision success: a dispatch or
        # build failure FAILs only the collision side, the scene stays PUBLISHED.
        # Idempotent per scene+version (no duplicate job / reuse valid build);
        # retry_failed=True lets a fresh publish recover a FAILED collision.
        try:
            from app.services.celery_client import send_task
            from app.services.collision import CollisionService

            coll_svc = CollisionService(session, storage, send_task=send_task)
            response = coll_svc.ensure_auto_collision_for_current_version(
                sid, us.owner_id, retry_failed=True
            )
            if response is not None:
                logger.info(
                    "Auto-collision for scene %s → job=%s status=%s",
                    scene_id,
                    response.job_id,
                    response.status,
                )
            else:
                logger.info(
                    "Scene %s has no current version; collision skipped", scene_id
                )
            session.commit()
        except Exception as exc:  # noqa: BLE001 - never fail a published scene
            logger.exception("Auto-collision dispatch failed for scene %s", scene_id)
            session.rollback()
            logger.warning(
                "Scene %s stays PUBLISHED; collision can be retried later", scene_id
            )
            _ = exc
        return {"ok": True, "version": ver}

    except Exception as exc:
        logger.exception("publish_scene FAILED for upload %s", upload_id)
        session.rollback()
        from sqlalchemy import select

        owned_job = session.scalars(
            select(Job)
            .where(Job.id == jid)
            .with_for_update()
            .execution_options(populate_existing=True)
        ).one()
        if (
            owned_job.execution_generation != claim.generation
            or owned_job.status != JobStatus.RUNNING.value
        ):
            return {"ok": False, "error": "publish_execution_fenced"}
        # quarantine failed source staging file, if still present
        src_staging_dir = Path(settings.storage_root) / "staging" / str(uid)
        quarantine_dir = Path(settings.storage_root) / "quarantine" / str(uid)
        if (
            not source_validated
            and src_staging_dir.exists()
            and not quarantine_dir.exists()
        ):
            quarantine_dir.parent.mkdir(parents=True, exist_ok=True)
            src_staging_dir.rename(quarantine_dir)
        # update DB state
        try:
            job.status = "FAILED"
            job.finished_at = datetime.now(timezone.utc)
            job.lease_expires_at = None
            job.stage = job.stage or "UNKNOWN"
            job.error_code = "PUBLISH_FAILED"
            job.error_message_safe = str(exc)[:1000]
            repo.update_status(uid, UploadSessionStatus.FAILED)
            session.commit()
        except Exception:
            session.rollback()
        return {"ok": False, "error": str(exc)}

    finally:
        # Remove ONLY this run's version-scoped staging dir.  Wiping the whole
        # ``.staging`` root would also delete a concurrent publish's output
        # (convert already removed its own staging dir on failure, and a
        # successful promote renamed it into ``versions/``, so there is
        # normally nothing left to clean here).
        if version_staging is not None and version_staging.is_relative_to(staging_path):
            import shutil

            shutil.rmtree(version_staging, ignore_errors=True)
        heartbeat.stop()
        session.close()


# ──────────────────────────────────────────────────────────────────────────────
# cleanup_expired_uploads — Celery beat task, runs periodically.
# ──────────────────────────────────────────────────────────────────────────────
@celery_app.task(name="tasks.cleanup_expired_uploads")
def cleanup_expired_uploads() -> dict:
    """Mark stale upload sessions as EXPIRED, remove stale staging dirs, and
    run the scheduled post-publish collision recovery (FIX-UPLOAD-01.1 §B).

    This task is the REAL scheduled entrypoint (``deploy/systemd/
    gsplatform-cleanup.timer``, every 6 hours) — the crash-window recovery for
    a PUBLISHED scene whose auto-collision was never dispatched rides on it,
    NOT on Celery redelivery.
    """
    session = SessionLocal()
    storage = _get_storage()
    try:
        from app.services.upload_service import UploadService

        svc = UploadService(session, storage, settings, send_task=None)
        expired = svc.expire_stale()

        from app.services.celery_client import send_task
        from app.services.collision import CollisionService

        coll_svc = CollisionService(session, storage, send_task=send_task)
        recovery = coll_svc.reconcile_auto_collision()
        return {
            "ok": True,
            "expired": expired,
            "collision_recovery": recovery,
        }
    finally:
        session.close()
