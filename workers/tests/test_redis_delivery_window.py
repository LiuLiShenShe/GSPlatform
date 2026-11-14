"""Redis must not redeliver valid full-quality work while it still runs."""

import pytest
from app.services.celery_client import _get_broker

from workers.celery_app import celery_app
from workers.tasks.reconstruct_scene import (
    reconstruct_cpu_stages,
    reconstruct_finish,
    reconstruct_train,
)


@pytest.mark.parametrize("application", [celery_app, _get_broker()])
@pytest.mark.parametrize(
    "task", [reconstruct_cpu_stages, reconstruct_train, reconstruct_finish]
)
def test_redis_delivery_window_exceeds_reconstruction_deadline(application, task):
    # Missing transport settings use Redis' one-hour default, even when the
    # task itself has a longer hard deadline and acknowledges after finishing.
    with application.connection_for_read() as connection:
        visibility = connection.transport_options.get("visibility_timeout", 3600)
    assert visibility > task.time_limit
    assert application.conf.visibility_timeout == visibility
    assert application.conf.result_backend_transport_options["visibility_timeout"] == visibility


def test_shared_producer_and_worker_use_the_same_delivery_window():
    assert _get_broker().conf.broker_transport_options.get("visibility_timeout") == (
        celery_app.conf.broker_transport_options.get("visibility_timeout")
    )
