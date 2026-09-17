"""Celery tasks — 3DGS reconstruction pipeline (Phase 07).

Three queue-routed tasks split the pipeline at hard boundaries. All real
work is driven by :func:`workers.reconstruction.orchestrator.run_pipeline`,
which is reentrant (resumes from stage-state completion markers):

1. **reconstruct_cpu_stages** — PROBING→MAPPING (CPU-bound: ffprobe, ffmpeg,
   COLMAP). Runs on the ``cpu`` queue. On success it dispatches the GPU task.
2. **reconstruct_train** — TRAINING only (GPU-bound: gsplat + torch). Runs on
   the ``gpu`` queue. On success it dispatches the finish task.
3. **reconstruct_finish** — CONVERTING→SUCCEEDED (CPU-bound: splat-transform,
   verify, publish). Runs on the ``cpu`` queue.

Progress is driven by real tool events (ffmpeg frames, COLMAP image count,
gsplat iterations) — never timers. The orchestrator owns the actual stage
execution; these tasks own queue routing, DB state, and hand-off.
"""

from __future__ import annotations

import logging
import uuid
from pathlib import Path

from workers.celery_app import celery_app

from app.core.config import settings
from app.db.models.job import Job
from app.db.session import SessionLocal
from app.services.celery_client import send_task

logger = logging.getLogger("gsplatform.workers.reconstruct")

_STORAGE_ROOT = Path(settings.storage_root)

CPU_STAGES_RANGE = ("PROBING", "MAPPING")
GPU_STAGE_RANGE = ("TRAINING", "TRAINING")
FINISH_STAGES_RANGE = ("CONVERTING", "SUCCEEDED")


# ── helpers ────────────────────────────────────────────────────────────────── #

def _load_job(session, job_id: str) -> Job | None:
    return session.query(Job).filter(Job.id == uuid.UUID(job_id)).first()


def _is_cancelled_factory(session, job_id: str):
    """Return a callable that checks the DB for cancellation."""
    _jid = uuid.UUID(job_id)

    def _check() -> bool:
        j = session.query(Job).filter(Job.id == _jid).first()
        return j is not None and j.status == "CANCEL_REQUESTED"

    return _check


def _run_stage_range(
    *,
    job_id: str,
    upload_ids: list[str],
    profile_name: str,
    stage_range: tuple[str, str],
    scene_id: str | None = None,
    session,
    attempt: int,
) -> dict:
    """Run *stage_range* via the orchestrator, wiring DB progress/error updates.

    Returns the orchestrator result dict. DB state (stage/progress/status) is
    journaled through the ``on_progress`` callback.
    """
    from workers.reconstruction.orchestrator import run_pipeline

    def on_progress(stage: str, pct: int) -> None:
        job = _load_job(session, job_id)
        if job is not None:
            job.stage = stage
            job.progress = pct
            session.flush()

    def on_error(stage: str, code: str, message: str, suggestion: str) -> None:
        job = _load_job(session, job_id)
        if job is not None:
            job.stage = stage
            job.error_code = code
            job.error_message_safe = message[:1000]
            session.flush()

    return run_pipeline(
        job_id,
        str(_STORAGE_ROOT),
        upload_ids,
        profile_name,
        stage_range,
        is_cancelled=_is_cancelled_factory(session, job_id),
        attempt=attempt,
        scene_id=scene_id,
        on_progress=on_progress,
        on_error=on_error,
        session=session,
    )


# ── CPU stages: PROBING→MAPPING ────────────────────────────────────────────── #

@celery_app.task(
    bind=True,
    name="tasks.reconstruct_cpu_stages",
    max_retries=1,
    default_retry_delay=30,
    acks_late=True,
    queue="cpu",
    time_limit=3600,
    soft_time_limit=3300,
)
def reconstruct_cpu_stages(
    self,
    job_id: str,
    upload_ids: list[str],
    profile_name: str,
) -> dict:
    """Run PROBING → EXTRACTING → PRECHECK → FEATURES → MATCHING → MAPPING."""
    session = SessionLocal()
    job = _load_job(session, job_id)
    if job is None:
        return {"ok": False, "error": "job_not_found"}

    job.attempt += 1
    job.status = "RUNNING"
    session.flush()

    try:
        result = _run_stage_range(
            job_id=job_id,
            upload_ids=upload_ids,
            profile_name=profile_name,
            stage_range=CPU_STAGES_RANGE,
            session=session,
            attempt=job.attempt,
        )
        if not result.get("ok"):
            _fail_job(session, job, result, default_code="CPU_STAGES_FAILED")
            return result

        # Hand-off: dispatch the GPU training task.
        send_task(
            "tasks.reconstruct_train",
            args=[
                job_id,
                upload_ids,
                profile_name,
                str(job.attempt),
            ],
        )
        session.commit()
        logger.info("CPU stages done for job %s — dispatched gpu training", job_id)
        return result

    except Exception as exc:  # noqa: BLE001
        logger.exception("reconstruct_cpu_stages FAILED for job %s", job_id)
        session.rollback()
        _fail_job(session, job, {"error_message": str(exc)}, default_code="CPU_STAGES_FAILED")
        return {"ok": False, "error": str(exc)}
    finally:
        session.close()


# ── GPU stage: TRAINING only ───────────────────────────────────────────────── #

@celery_app.task(
    bind=True,
    name="tasks.reconstruct_train",
    max_retries=1,
    default_retry_delay=30,
    acks_late=True,
    queue="gpu",
    time_limit=7200,
    soft_time_limit=6900,
)
def reconstruct_train(
    self,
    job_id: str,
    upload_ids: list[str],
    profile_name: str,
    attempt: int,
) -> dict:
    """Run TRAINING stage on GPU queue via the gsplat training subprocess."""
    session = SessionLocal()
    job = _load_job(session, job_id)
    if job is None:
        return {"ok": False, "error": "job_not_found"}

    job.status = "RUNNING"
    session.flush()

    try:
        result = _run_stage_range(
            job_id=job_id,
            upload_ids=upload_ids,
            profile_name=profile_name,
            stage_range=GPU_STAGE_RANGE,
            session=session,
            attempt=int(attempt),
        )
        if not result.get("ok"):
            _fail_job(session, job, result, default_code="TRAINING_FAILED")
            return result

        # Hand-off: dispatch the CPU finish task with the scene id.
        scene_id = _scene_id_for_job(session, job_id)
        send_task(
            "tasks.reconstruct_finish",
            args=[job_id, profile_name, str(attempt), scene_id],
        )
        session.commit()
        logger.info("Training done for job %s — dispatched finish", job_id)
        return result

    except Exception as exc:  # noqa: BLE001
        logger.exception("reconstruct_train FAILED for job %s", job_id)
        session.rollback()
        _fail_job(session, job, {"error_message": str(exc)}, default_code="TRAINING_FAILED")
        return {"ok": False, "error": str(exc)}
    finally:
        session.close()


# ── CPU stages: CONVERTING→SUCCEEDED ────────────────────────────────────────── #

@celery_app.task(
    bind=True,
    name="tasks.reconstruct_finish",
    max_retries=1,
    default_retry_delay=30,
    acks_late=True,
    queue="cpu",
    time_limit=3600,
    soft_time_limit=3300,
)
def reconstruct_finish(
    self,
    job_id: str,
    profile_name: str,
    attempt: int,
    scene_id: str,
) -> dict:
    """Run CONVERTING → VERIFYING → PUBLISHING on CPU queue."""
    session = SessionLocal()
    job = _load_job(session, job_id)
    if job is None:
        return {"ok": False, "error": "job_not_found"}

    job.status = "RUNNING"
    session.flush()

    try:
        result = _run_stage_range(
            job_id=job_id,
            upload_ids=[],
            profile_name=profile_name,
            stage_range=FINISH_STAGES_RANGE,
            scene_id=scene_id,
            session=session,
            attempt=int(attempt),
        )
        if not result.get("ok"):
            _fail_job(session, job, result, default_code="FINISH_FAILED")
            return result

        job.status = "SUCCEEDED"
        job.stage = "SUCCEEDED"
        job.progress = 100
        session.commit()
        logger.info("Reconstruction complete for job %s: %s", job_id, result)
        return result

    except Exception as exc:  # noqa: BLE001
        logger.exception("reconstruct_finish FAILED for job %s", job_id)
        session.rollback()
        _fail_job(session, job, {"error_message": str(exc)}, default_code="FINISH_FAILED")
        return {"ok": False, "error": str(exc)}
    finally:
        session.close()


# ── shared helpers ─────────────────────────────────────────────────────────── #

def _fail_job(session, job: Job, result: dict, *, default_code: str) -> None:
    """Mark *job* FAILED using safe fields from *result* (never raw internals)."""
    try:
        job.status = "FAILED"
        job.stage = result.get("stage") or job.stage or "UNKNOWN"
        job.error_code = result.get("error") or default_code
        job.error_message_safe = (result.get("error_message") or "")[:1000]
        job.progress = int(result.get("progress") or 0)
        session.commit()
    except Exception:  # noqa: BLE001
        session.rollback()


def _scene_id_for_job(session, job_id: str) -> str:
    """Return the Job's linked scene id (the publish target)."""
    job = _load_job(session, job_id)
    if job is not None and job.scene_id is not None:
        return str(job.scene_id)
    return ""
