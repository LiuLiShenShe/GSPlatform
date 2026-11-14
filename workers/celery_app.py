"""GSPlatform Celery application.

Broker / backend come from ``GS_CELERY_BROKER_URL`` / ``GS_CELERY_RESULT_BACKEND``
env vars (never committed). Tasks are defined in ``tasks/`` and registered via
autodiscovery. The API side sends work by task name through its own thin
producer app (see ``apps/api/app/services/celery_client.py``); this worker
app is the one that *executes* them.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Make ``app`` (the FastAPI package) importable from the worker process.
API_SRC = Path(__file__).resolve().parent.parent / "apps" / "api"
REPO_ROOT = Path(__file__).resolve().parent.parent  # /fj/GSPlatform
WORKERS_PKG = Path(__file__).resolve().parent        # /fj/GSPlatform/workers

for p in (str(API_SRC), str(REPO_ROOT), str(WORKERS_PKG)):
    if p not in sys.path:
        sys.path.insert(0, p)

from app.core.config import settings
from celery import Celery

celery_app = Celery(
    "gsplatform-workers",
    broker=settings.celery_broker_url,
    backend=settings.celery_result_backend,
)

celery_app.conf.update(
    task_track_started=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    # Redis' one-hour default redelivers a still-running full-quality task.
    # Match the API producer and keep this above the longest task hard limit.
    visibility_timeout=settings.celery_visibility_timeout_s,
    broker_transport_options={
        "visibility_timeout": settings.celery_visibility_timeout_s,
    },
    result_backend_transport_options={
        "visibility_timeout": settings.celery_visibility_timeout_s,
    },
    # Publish pipeline can legitimately run >1h on very large PLY (decimate ×3
    # + SOG stack on 10M+ gaussians).  Sized by env so operators can tune
    # without a deploy; defaults raised from the historical 3600s/3300s.
    task_time_limit=int(os.environ.get("GS_TASK_TIME_LIMIT_S", "7200")),
    task_soft_time_limit=int(os.environ.get("GS_TASK_SOFT_TIME_LIMIT_S", "6600")),
    result_expires=3600,
    broker_connection_retry_on_startup=True,
    task_default_queue="gsplatform",
    # CPU/GPU queue routing for Phase 07 reconstruction.
    # Worker invocation:
    #   celery -A workers.celery_app worker -Q cpu --concurrency=2
    #   celery -A workers.celery_app worker -Q gpu --concurrency=1
    task_routes={
        "tasks.reconstruct_cpu_stages": {"queue": "cpu"},
        "tasks.reconstruct_train": {"queue": "gpu"},
        "tasks.reconstruct_finish": {"queue": "cpu"},
        "tasks.publish_scene": {"queue": "gsplatform"},
        "tasks.cleanup_expired_uploads": {"queue": "gsplatform"},
        "tasks.build_collision": {"queue": "cpu"},
        "tasks.build_mesh": {"queue": "gpu"},
    },
)

# Import task modules so their @celery_app.task decorators register.
celery_app.autodiscover_tasks(["tasks"])

# Explicit import fallback: ensures tasks are discovered even when
# autodiscover resolution fails (e.g. running via -m celery).
import tasks.build_collision
import tasks.build_mesh
import tasks.publish_scene
import tasks.reconstruct_scene  # noqa: F401

__all__ = ["celery_app"]
