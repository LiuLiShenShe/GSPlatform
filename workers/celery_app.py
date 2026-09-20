"""GSPlatform Celery application.

Broker / backend come from ``GS_CELERY_BROKER_URL`` / ``GS_CELERY_RESULT_BACKEND``
env vars (never committed). Tasks are defined in ``tasks/`` and registered via
autodiscovery. The API side sends work by task name through its own thin
producer app (see ``apps/api/app/services/celery_client.py``); this worker
app is the one that *executes* them.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Make ``app`` (the FastAPI package) importable from the worker process.
API_SRC = Path(__file__).resolve().parent.parent / "apps" / "api"
REPO_ROOT = Path(__file__).resolve().parent.parent  # /fj/GSPlatform
WORKERS_PKG = Path(__file__).resolve().parent        # /fj/GSPlatform/workers

for p in (str(API_SRC), str(REPO_ROOT), str(WORKERS_PKG)):
    if p not in sys.path:
        sys.path.insert(0, p)

from celery import Celery  # noqa: E402

from app.core.config import settings  # noqa: E402

celery_app = Celery(
    "gsplatform-workers",
    broker=settings.celery_broker_url,
    backend=settings.celery_result_backend,
)

celery_app.conf.update(
    task_track_started=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    task_time_limit=3600,
    task_soft_time_limit=3300,
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
    },
)

# Import task modules so their @celery_app.task decorators register.
celery_app.autodiscover_tasks(["tasks"])

# Explicit import fallback: ensures tasks are discovered even when
# autodiscover resolution fails (e.g. running via -m celery).
import tasks.publish_scene  # noqa: F401, E402
import tasks.reconstruct_scene  # noqa: F401, E402
import tasks.build_collision  # noqa: F401, E402

__all__ = ["celery_app"]
