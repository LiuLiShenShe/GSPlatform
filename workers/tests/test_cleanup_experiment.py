from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

from workers.pipeline import cleanup_experiment as cleanup
from workers.pipeline.cleanup_experiment import (
    CleanupConfig,
    OfficialFilter,
    run_cleanup_experiment,
)
from workers.pipeline.gaussian_quality import (
    analyze_gaussian_ply,
    compare_gaussian_ply,
    read_gaussian_ply,
)
from workers.pipeline.splat_transform_adapter import CLI_PATH, ROOT, run_process
from workers.tests.test_convert_scene_lod_recipe import _gaussian_ply_bytes


@pytest.fixture
def experiment(tmp_path, monkeypatch):
    source = tmp_path / "original.ply"
    source.write_bytes(_gaussian_ply_bytes(64))
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    config = CleanupConfig("PILOT_BOX", (OfficialFilter("box", (-2, -2, -2, 2, 2, 2)),),
                           "Test a continuous source-space ROI without publishing")
    monkeypatch.setattr(cleanup, "validate_cli", lambda *args, **kwargs: "splat-transform v3.3.3")

    def official(command, **kwargs):
        shutil.copyfile(source, next(Path(value) for value in command if value.endswith("candidate.ply")))
        return 'GS_SPLAT_DEVICE {"backend":"cpu","adapter":null}'

    monkeypatch.setattr(cleanup, "run_cli_command", official)
    return source, tmp_path / "isolated" / "PILOT_BOX", digest, config


def test_hash_verified_and_never_published(experiment):
    source, output, digest, config = experiment
    result = run_cleanup_experiment(source, output, digest, config)
    assert result["status"] == "WAITING_FOR_APPROVAL"
    assert result["sourceUnchanged"] and result["publishingEnabled"] is False
    assert result["sourceSha256"] == digest == result["outputSha256"]
    assert result["inputGaussianCount"] == result["outputGaussianCount"] == 64
    assert not (output / "versions").exists()
    assert {"source-checksum.json", "filter-config.json", "candidate-manifest.json",
            "cli-execution.json", "candidate.ply", "quality-comparison.json"}.issubset(
                {path.name for path in output.iterdir()})


def test_bad_hash_stops_before_cli(experiment):
    source, output, _, config = experiment
    with pytest.raises(ValueError, match="SHA256 mismatch"):
        run_cleanup_experiment(source, output, "a" * 64, config)
    assert not output.exists()


@pytest.mark.parametrize("action", [
    OfficialFilter("custom-floater", (1,)),
    OfficialFilter("box", (0, 0, 0, -1, 1, 1)),
    OfficialFilter("box", (0, 0, 0, 1, 1, float("nan"))),
    OfficialFilter("box", (0, 0, 0)),
    OfficialFilter("floaters", (-1, 0.1, 0.004)),
    OfficialFilter("floaters", (1, 1.1, 0.004)),
    OfficialFilter("floaters", (1, 0.1, -1)),
    OfficialFilter("floaters", (1, 0.1, 0.004), column="opacity"),
    OfficialFilter("cluster", (1, 0.999, 0.1)),
    OfficialFilter("cluster", (1, 0.999, 0.1), seed=(float("inf"), 0, 0)),
    OfficialFilter("value", (1,), column="arbitrary-cli-flag", comparison="gt"),
    OfficialFilter("value", (1,), column="opacity", comparison="shell"),
])
def test_unsupported_or_unsafe_filter_rejected(experiment, action):
    source, output, digest, config = experiment
    with pytest.raises(ValueError):
        run_cleanup_experiment(source, output, digest, replace(config, filters=(action,)))
    assert not output.exists()


def test_cluster_seed_outside_bounds_rejected(experiment):
    source, output, digest, config = experiment
    config = replace(config, gpu="0", filters=(OfficialFilter("cluster", (1, 0.999, 0.1),
                                                             seed=(1000, 0, 0)),))
    with pytest.raises(ValueError, match="inside source bounds"):
        run_cleanup_experiment(source, output, digest, config)


def test_cpu_cannot_silently_run_gpu_filters(experiment):
    source, output, digest, config = experiment
    with pytest.raises(ValueError, match="GPU adapter"):
        run_cleanup_experiment(source, output, digest,
                               replace(config, filters=(OfficialFilter("floaters", (1, 0.1, 0.004)),)))


def test_full_scene_filter_is_not_implicitly_enabled(experiment, monkeypatch):
    source, output, digest, config = experiment

    class LargeRows:
        def __len__(self):
            return 13_090_324

    monkeypatch.setattr(cleanup, "read_gaussian_ply", lambda _: LargeRows())
    config = replace(config, gpu="0", filters=(OfficialFilter("floaters", (0.25, 0.1, 1 / 255)),))
    with pytest.raises(ValueError, match="Large-scene filtering is disabled"):
        run_cleanup_experiment(source, output, digest, config)
    assert not output.exists()


@pytest.mark.parametrize("target", ["source", "existing", "repo", "published", "symlink"])
def test_isolation_and_overwrite_guard(experiment, tmp_path, target):
    source, output, digest, config = experiment
    if target == "source":
        output = source.parent
    elif target == "existing":
        output.mkdir(parents=True)
    elif target == "repo":
        output = ROOT / "cleanup-test-not-created"
    elif target == "published":
        output = tmp_path / "published" / "unsafe"
    else:
        linked = tmp_path / "linked"
        linked.symlink_to(tmp_path, target_is_directory=True)
        output = linked / "escape"
    with pytest.raises(ValueError, match="isolated"):
        run_cleanup_experiment(source, output, digest, config)
    assert hashlib.sha256(source.read_bytes()).hexdigest() == digest


def test_disk_shortage_stops_safely(experiment, monkeypatch):
    source, output, digest, config = experiment
    monkeypatch.setattr(cleanup.shutil, "disk_usage", lambda _: shutil._ntuple_diskusage(100, 99, 1))
    with pytest.raises(ValueError, match="Insufficient disk"):
        run_cleanup_experiment(source, output, digest, config)
    assert not output.exists()


@pytest.mark.parametrize("failure", [RuntimeError("Official CLI rc=17"), subprocess.TimeoutExpired("cli", 1)])
def test_cli_failures_record_failed_not_approved(experiment, monkeypatch, failure):
    source, output, digest, config = experiment

    def fail(*args, **kwargs):
        raise failure

    monkeypatch.setattr(cleanup, "run_cli_command", fail)
    with pytest.raises(type(failure)):
        run_cleanup_experiment(source, output, digest, config)
    manifest = json.loads((output / "candidate-manifest.json").read_text())
    assert manifest["status"] == "FAILED" and manifest["sourceUnchanged"]
    assert json.loads((output / "cli-execution.json").read_text())["error"]


@pytest.mark.parametrize("damage", ["count", "nan", "columns", "color"])
def test_invalid_output_cannot_be_usable(experiment, monkeypatch, damage):
    source, output, digest, config = experiment

    def bad_output(command, **kwargs):
        target = next(Path(value) for value in command if value.endswith("candidate.ply"))
        target.write_bytes(_gaussian_ply_bytes(8 if damage == "count" else 64))
        if damage == "nan":
            original = read_gaussian_ply(target)
            writable = np.memmap(target, dtype=original.dtype, mode="r+", offset=original.offset,
                                 shape=original.shape)
            writable["x"][0] = np.nan
            writable.flush()
        if damage == "columns":
            target.write_bytes(target.read_bytes().replace(b"property float f_dc_0", b"property float other0"))
        if damage == "color":
            original = read_gaussian_ply(target)
            writable = np.memmap(target, dtype=original.dtype, mode="r+", offset=original.offset,
                                 shape=original.shape)
            writable["f_dc_0"][0] += 0.1
            writable.flush()
        return ""

    monkeypatch.setattr(cleanup, "run_cli_command", bad_output)
    with pytest.raises(ValueError):
        run_cleanup_experiment(source, output, digest, config)
    assert json.loads((output / "candidate-manifest.json").read_text())["status"] == "FAILED"


def test_visible_damage_is_rejected_and_never_qualified(experiment):
    source, output, digest, config = experiment
    result = run_cleanup_experiment(source, output, digest, replace(config, visual_review="REJECTED"))
    assert result["status"] == "REJECTED"
    with pytest.raises(ValueError, match="Invalid explicit"):
        run_cleanup_experiment(source, output.parent / "approved", digest,
                               replace(config, visual_review="APPROVED"))


def test_filter_order_and_explicit_values_are_preserved():
    first = OfficialFilter("box", (-1, -2, -3, 1, 2, 3))
    second = OfficialFilter("floaters", (0.05, 0.1, 1 / 255))
    forward = first.arguments(()) + second.arguments(())
    backward = second.arguments(()) + first.arguments(())
    assert forward != backward
    assert forward[0] == "--filter-box" and forward[2] == "--filter-floaters"


def test_source_box_and_seed_are_mapped_to_cli_runtime():
    assert OfficialFilter("box", (-70, 15, 290, -30, 110, 330)).arguments(()) == [
        "--filter-box", "30,-110,290,70,-15,330"]
    assert OfficialFilter("cluster", (1, 0.999, 0.1), seed=(-50, 30, 310)).arguments(())[1] == "50,-30,310"


def test_read_only_stats_and_scene_runtime_coordinates(experiment):
    source, _, digest, _ = experiment
    rows = read_gaussian_ply(source)
    assert rows.mode == "r" and not rows.flags.writeable
    statistics = analyze_gaussian_ply(source)
    assert statistics["gaussianCount"] == 64
    for axis in ("x", "y"):
        bounds = statistics["sourceBounds"][axis]
        assert statistics["runtimeBounds"][axis] == [-bounds[1], -bounds[0]]
    assert statistics["gpuOverdraw"] == "unavailable"
    assert all(value == {"nan": 0, "inf": 0} for value in statistics["nonfinite"].values())
    assert hashlib.sha256(source.read_bytes()).hexdigest() == digest


def test_sh_and_color_preservation_is_measured_not_assumed(experiment):
    source, output, digest, config = experiment
    run_cleanup_experiment(source, output, digest, config)
    comparison = compare_gaussian_ply(source, output / "candidate.ply")
    assert comparison["retainedRowsBitIdenticalIncludingSH"]
    assert comparison["removedCount"] == 0 and comparison["vrPerformance"] == "unavailable"


def test_timeout_terminates_owned_descendant_process_group(tmp_path):
    pidfile = tmp_path / "child.pid"
    code = ("import subprocess,sys,time; "
            "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); "
            f"open({str(pidfile)!r},'w').write(str(child.pid)); time.sleep(60)")
    with pytest.raises(subprocess.TimeoutExpired):
        run_process([sys.executable, "-c", code], cwd=tmp_path, timeout=1)
    child_pid = int(pidfile.read_text())
    for _attempt in range(50):
        status = Path(f"/proc/{child_pid}/stat")
        if not status.exists() or status.read_text().split()[2] == "Z":
            break
        time.sleep(0.02)
    else:
        os.kill(child_pid, 9)
        pytest.fail("Owned CLI descendant survived timeout")


@pytest.mark.skipif(not CLI_PATH.exists(), reason="Pinned CLI absent in source-only archive")
def test_real_official_box_filter_non_destructive(tmp_path):
    source = tmp_path / "original.ply"
    source.write_bytes(_gaussian_ply_bytes(64))
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    config = CleanupConfig("REAL_BOX", (OfficialFilter("box", (-2, -2, -2, 2, 2, 2)),),
                           "Real CLI control retaining all fixture geometry")
    result = run_cleanup_experiment(source, tmp_path / "REAL_BOX", digest, config)
    assert result["outputGaussianCount"] == 64 and result["sourceUnchanged"]
    comparison = compare_gaussian_ply(source, tmp_path / "REAL_BOX" / "candidate.ply")
    assert comparison["retainedRowsBitIdenticalIncludingSH"]


@pytest.mark.skipif(not CLI_PATH.exists(), reason="Pinned CLI absent in source-only archive")
def test_real_asymmetric_source_roi_is_not_flipped(tmp_path):
    source = tmp_path / "source.ply"
    source.write_bytes(_gaussian_ply_bytes(64))
    rows = read_gaussian_ply(source)
    expected = int(((rows["x"] >= -1.01) & (rows["x"] <= -0.49)).sum())
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    config = CleanupConfig("ASYMMETRIC_ROI", (OfficialFilter("box", (-1.01, -2, -2, -0.49, 2, 2)),),
                           "Verify source PLY / official CLI runtime Z180 transform",
                           minimum_retained_fraction=0.1)
    result = run_cleanup_experiment(source, tmp_path / "ASYMMETRIC_ROI", digest, config)
    assert result["outputGaussianCount"] == expected
    candidate = read_gaussian_ply(tmp_path / "ASYMMETRIC_ROI" / "candidate.ply")
    assert candidate["x"].max() <= -0.49 and candidate["x"].min() >= -1.01
    assert compare_gaussian_ply(source, tmp_path / "ASYMMETRIC_ROI" / "candidate.ply")[
        "retainedRowsBitIdenticalIncludingSH"]
