"""Queue deadlines must allow the configured full-quality subprocess budget."""

import pytest

from workers.reconstruction.profiles import AVAILABLE_PROFILES, load_profile
from workers.tasks.reconstruct_scene import (
    reconstruct_cpu_stages,
    reconstruct_finish,
    reconstruct_train,
)


@pytest.mark.parametrize("profile", AVAILABLE_PROFILES)
@pytest.mark.parametrize(
    ("task", "budget"),
    [
        (reconstruct_cpu_stages, "cpu_time_s"),
        (reconstruct_finish, "cpu_time_s"),
        (reconstruct_train, "gpu_time_s"),
    ],
)
def test_queue_deadline_does_not_kill_a_valid_profile_early(profile, task, budget):
    seconds = load_profile(profile).resource()[budget]
    assert task.soft_time_limit > seconds
    assert task.time_limit > task.soft_time_limit
