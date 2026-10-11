from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

from workers.pipeline.conversion_policy import conversion_recipe, resolve_conversion_policy
from workers.pipeline.splat_transform_adapter import (
    CLI_PATH,
    LOG_LIMIT_BYTES,
    execution_record,
    run_process,
    run_cli_command,
    validate_cli,
)


def test_process_nonzero_is_not_swallowed(tmp_path):
    with pytest.raises(RuntimeError, match="rc=17"):
        run_process([sys.executable, "-c", "raise SystemExit(17)"], cwd=tmp_path, timeout=5)


def test_disk_and_memory_logging_are_bounded(tmp_path):
    output = run_process([sys.executable, "-c", "print('x' * 20000000)"],
                         cwd=tmp_path, timeout=15)
    assert len(output) <= 65536
    assert (tmp_path / "cli.log").stat().st_size <= LOG_LIMIT_BYTES


def test_timeout_does_not_kill_unrelated_process(tmp_path):
    sentinel = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(20)"])
    try:
        with pytest.raises(subprocess.TimeoutExpired):
            run_process([sys.executable, "-c", "import time; time.sleep(20)"],
                        cwd=tmp_path, timeout=1)
        assert sentinel.poll() is None
    finally:
        sentinel.terminate()
        sentinel.wait(timeout=5)


def test_missing_or_wrong_cli_fails(tmp_path):
    with pytest.raises(FileNotFoundError):
        validate_cli(tmp_path / "absent-cli.mjs")
    executable = tmp_path / "cli.mjs"
    executable.write_text("console.log('splat-transform v3.10.1');")
    with pytest.raises(ValueError, match="Expected SplatTransform 3.3.3"):
        validate_cli(executable)


@pytest.mark.parametrize("profile,expected", [
    ("balanced", (64, 32)), ("eco", (512, 32)), ("quality", (64, 16)),
])
def test_resolved_policy_has_no_arbitrary_cli_input(tmp_path, profile, expected):
    source = tmp_path / "source.ply"
    source.write_bytes(b"ply")
    policy = resolve_conversion_policy(source, profile=profile, source_format="ply", gpu="cpu")
    assert policy.recipe == conversion_recipe(profile, *expected)
    assert policy.output_format == "streamed-sog"
    with pytest.raises(ValueError):
        resolve_conversion_policy(source, profile=profile, source_format="ply", gpu="--help")


def test_unknown_device_is_not_claimed_from_configuration():
    record = execution_record(["cli.mjs", "-g", "0", "/private/source.ply"], "done")
    assert record["observedDevice"]["backend"] == "unknown"
    assert record["arguments"][-1] == "source.ply"
    record = execution_record(["cli.mjs"], 'GS_SPLAT_DEVICE {"backend":"cpu","adapter":null}')
    assert record["observedDevice"]["backend"] == "cpu"


@pytest.mark.skipif(not Path(".git").is_dir(), reason="Git history absent from clean archive")
def test_recipe_and_identity_exactly_match_starting_head(tmp_path):
    baseline = subprocess.check_output([
        "git", "show", "ea3b800:workers/pipeline/convert_scene.py",
    ], text=True)
    module_path = tmp_path / "baseline.py"
    module_path.write_text(baseline)
    spec = importlib.util.spec_from_file_location("pc02_baseline_recipe", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    from workers.pipeline.conversion_policy import version_id_for

    for profile, expected in (("balanced", (64, 32)), ("eco", (512, 32)), ("quality", (64, 16))):
        for device in ("cpu", "0", "1"):
            recipe = conversion_recipe(profile, *expected, device)
            assert recipe == module.conversion_recipe(profile, *expected, device)
            assert version_id_for("a" * 64, recipe) == module.version_id_for("a" * 64, recipe)


@pytest.mark.skipif(not CLI_PATH.is_file(), reason="Official CLI absent from archive")
def test_real_single_sog_and_real_streamed_zip_passthrough(tmp_path):
    import json
    import zipfile

    from workers.pipeline.convert_scene import convert_to_streamed_sog
    from workers.pipeline.verify_publish import verify_published_version
    from workers.tests.test_convert_scene_formats import _gaussian_ply_bytes

    source = tmp_path / "small.ply"
    source.write_bytes(_gaussian_ply_bytes(256))
    sog = tmp_path / "small.sog"
    run_cli_command([str(CLI_PATH), "-g", "cpu", str(source), str(sog), "--no-tty",
                     "--max-workers", "0"], cwd=tmp_path, timeout=120)
    result = convert_to_streamed_sog(sog, tmp_path / "staging", scene_id="sog-test",
                                     source_format="sog", gpu="cpu")
    assert result.ok, result.reason
    assert verify_published_version(result.staging_dir)["counts"] == [256, 77, 26]
    assert result.staging_dir is not None
    bundle = tmp_path / "streamed.zip"
    with zipfile.ZipFile(bundle, "w") as archive:
        for path in result.staging_dir.rglob("*"):
            if path.is_file() and path.name not in ("manifest.json", "build-info.json",
                                                   "checksums.sha256"):
                archive.write(path, path.relative_to(result.staging_dir))
    passed = convert_to_streamed_sog(bundle, tmp_path / "passthrough", scene_id="zip-test",
                                     source_format="zip", gpu="cpu")
    assert passed.ok, passed.reason
    assert verify_published_version(passed.staging_dir)["counts"] == [256, 77, 26]
    assert passed.recipe["mode"] == "streamed-passthrough"
    info = json.loads((passed.staging_dir / "build-info.json").read_text())
    assert info["gpuDevice"] is None
