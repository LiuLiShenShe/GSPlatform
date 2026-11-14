"""Large photo sets must not start one SIFT worker per host CPU."""

from types import SimpleNamespace

import pytest

from workers.reconstruction import colmap_pipeline as colmap
from workers.reconstruction.profiles import load_profile


@pytest.mark.parametrize("profile", ["draft", "standard", "high", None])
@pytest.mark.parametrize("stage", ["features", "matching", "mapping"])
def test_colmap_cpu_stages_have_explicit_bounded_threads(tmp_path, profile, stage):
    commands = []

    class Runner:
        def run(self, command):
            commands.append(command)
            return SimpleNamespace(ok=False, error="stop after command capture")

    config = load_profile(profile).colmap() if profile else {}
    runner = Runner()
    if stage == "features":
        colmap.run_feature_extractor(runner, tmp_path, tmp_path / "db", config)
        flag = "--SiftExtraction.num_threads"
    elif stage == "matching":
        colmap.run_matcher(runner, tmp_path / "db", config)
        flag = "--SiftMatching.num_threads"
    else:
        colmap.run_mapper(runner, tmp_path, tmp_path / "db", tmp_path / "out", config)
        flag = "--Mapper.num_threads"
    command = commands[0]
    assert flag in command, "COLMAP's default -1 can exhaust host memory"
    assert 1 <= int(command[command.index(flag) + 1]) <= 8
