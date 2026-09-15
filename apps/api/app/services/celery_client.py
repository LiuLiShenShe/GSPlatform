"""Celery task dispatcher — thin send_task wrapper for the API side.

The API never imports ``tasks.*`` directly; it uses this helper which
sends a task by string name to the shared Redis broker. The actual
``@celery_app.task`` definitions live in the ``workers/`` package.
"""

from __future__ import annotations

import logging

from celery import Celery

from app.core.config import settings

logger = logging.getLogger("gsplatform.api.celery")

# Producer-only Celery app — no task autodiscovery, no worker hooks.
_broker: Celery | None = None


def _get_broker() -> Celery:
    global _broker  # noqa: PLW0603
    if _broker is None:
        _broker = Celery(
            "gsplatform-producer",
            broker=settings.celery_broker_url,
            backend=settings.celery_result_backend,
        )
        _broker.conf.task_always_eager = False
        _broker.conf.result_expires = 3600
        _broker.conf.task_default_queue = "gsplatform"
    return _broker


def send_task(name: str, *, args: list[str] | None = None) -> object:
    """Send a Celery task by *name* to the broker.

    Returns the async result object so callers can store the Celery task ID
    if needed.
    """
    broker = _get_broker()
    result = broker.send_task(name, args=args or [])
    logger.info("Dispatched %s → celery_id=%s", name, result.id)
    return result
