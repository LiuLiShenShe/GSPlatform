from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

from workers.pipeline import convert_scene
from workers.pipeline.validate_scene import _sha256_of
from workers.pipeline.verify_publish import verify_published_version


@pytest.mark.skipif(
    not (convert_scene._ROOT / ".git").exists(),
    reason="Baseline Git history is absent from clean archive",
)
def test_baseline_red_lod_and_metadata(tmp_path, monkeypatch):
    source_code = subprocess.check_output(
        ["git", "show", "01ad894:workers/pipeline/convert_scene.py"], text=True
    )
    module_path = tmp_path / "baseline.py"
    module_path.write_text(source_code)
    spec = importlib.util.spec_from_file_location("convert_baseline", module_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    commands = []

    def fake(command, cwd=None, timeout=None):
        commands.append(command)
        output = next(
            (argument for argument in command if argument.endswith("lod-meta.json")),
            None,
        )
        if output:
            Path(output).write_text(json.dumps({"counts": [10, 30, 100]}))
        elif "--decimate" in command:
            Path(command[command.index("--decimate") + 2]).write_bytes(b"ply")
        return ""

    monkeypatch.setattr(module, "_run", fake)
    monkeypatch.setattr(module, "_NODE_BIN", Path(sys.executable))
    source = tmp_path / "source.ply"
    source.write_bytes(b"ply\nformat ascii 1.0\nelement vertex 100\nend_header\n")
    result = module.convert_to_streamed_sog(
        source, tmp_path / ".staging", scene_id="red", profile="quality"
    )
    assert result.ok
    stack = next(command for command in commands if "--tag-lod" in command)
    assert Path(stack[stack.index("--tag-lod") - 1]).name == "low.ply"
    assert result.version_id == _sha256_of(source)[:12]
    assert module._PROFILES["balanced"] == (4, 8)
    metadata = json.loads((tmp_path / ".staging" / "build-info.json").read_text())
    assert metadata["profile"] == "balanced"
    assert metadata["lodChunkCount"] != module._PROFILES["quality"][0]


def test_unknown_profile_is_rejected_before_writing(tmp_path):
    source = tmp_path / "source.ply"
    source.write_bytes(b"ply")
    result = convert_scene.convert_to_streamed_sog(
        source, tmp_path / ".staging", scene_id="test", profile="typo"
    )
    assert not result.ok
    assert not (tmp_path / ".staging").exists()


def test_intermediate_marker_requires_gaussian_ply(tmp_path):
    target = tmp_path / "lod1.ply"
    target.write_bytes(b"not a Gaussian PLY")
    with pytest.raises(ValueError):
        convert_scene._mark_decimation(
            target, ratio="30%", source_sha256="a" * 64, recipe_key="recipe"
        )


def test_background_output_is_bounded(tmp_path):
    output = convert_scene._run(
        [sys.executable, "-c", "print('x' * 1000000)"], cwd=tmp_path
    )
    assert len(output) <= 65536
    assert (tmp_path / "cli.log").stat().st_size > 1000000


def test_subprocess_timeout_reaps_its_own_process(tmp_path):
    with pytest.raises(subprocess.TimeoutExpired):
        convert_scene._run(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            cwd=tmp_path,
            timeout=1,
        )


def test_profiles_use_measured_chunk_semantics():
    assert convert_scene._PROFILES == {
        "balanced": (64, 32),
        "eco": (512, 32),
        "quality": (64, 16),
    }


def test_compute_backend_is_content_identity_but_adapter_index_is_not():
    cpu = convert_scene.conversion_recipe("balanced", 64, 32, "cpu")
    first = convert_scene.conversion_recipe("balanced", 64, 32, "0")
    second = convert_scene.conversion_recipe("balanced", 64, 32, "1")
    assert cpu != first
    assert first == second


def test_timeout_and_gpu_env_configuration(monkeypatch, tmp_path):
    monkeypatch.setenv("GS_CONVERT_TIMEOUT_S", "1")
    with pytest.raises(subprocess.TimeoutExpired):
        convert_scene._run(
            [sys.executable, "-c", "import time; time.sleep(30)"], cwd=tmp_path
        )
    monkeypatch.setenv("GS_CONVERT_GPU", "1")
    source = tmp_path / "source.ply"
    source.write_bytes(b"ply")
    seen = []

    def fake(*arguments, **keywords):
        seen.append(keywords["gpu"])
        return convert_scene.ConvertResult(False, reason="not executed")

    monkeypatch.setattr(convert_scene, "_convert_to_streamed_sog", fake)
    convert_scene.convert_to_streamed_sog(
        source, tmp_path / ".staging", scene_id="test"
    )
    assert seen == ["1"]


def test_reuse_never_accepts_binary_payload_truncation(tmp_path):
    from workers.tests.test_convert_scene_formats import _gaussian_ply_bytes

    target = tmp_path / "lod1.ply"
    target.write_bytes(_gaussian_ply_bytes(10)[:-5])
    with pytest.raises(ValueError, match="Truncated"):
        convert_scene._mark_decimation(
            target, ratio="30%", source_sha256="a" * 64, recipe_key="test"
        )


def test_valid_published_recipe_is_reused_without_reencoding(tmp_path, monkeypatch):
    from workers.tests.test_convert_scene_formats import _gaussian_ply_bytes

    source = tmp_path / "source.ply"
    source.write_bytes(_gaussian_ply_bytes(100))
    source_hash = _sha256_of(source)
    recipe = convert_scene.conversion_recipe("balanced", 64, 32)
    version = convert_scene.version_id_for(source_hash, recipe)
    published = tmp_path / "versions" / version
    published.mkdir(parents=True)
    entry = published / "lod-meta.json"
    entry.write_text(json.dumps({"counts": [100, 30, 10], "filenames": []}))
    convert_scene._write_metadata(
        published,
        scene_id="test",
        ver=version,
        source_name=source.name,
        source_sha256=source_hash,
        source_gaussian_count=100,
        entry_bytes=entry.stat().st_size,
        entry_sha256=_sha256_of(entry),
        has_poster=False,
        recipe=recipe,
        gpu="cpu",
        stage_durations={},
        total_duration=1,
    )
    monkeypatch.setattr(
        convert_scene,
        "_convert_to_streamed_sog",
        lambda *arguments, **keywords: pytest.fail(
            "must not reencode immutable version"
        ),
    )
    result = convert_scene.convert_to_streamed_sog(
        source, tmp_path / ".staging", scene_id="test"
    )
    assert result.ok
    assert result.staging_dir == published


def test_same_recipe_lock_cannot_delete_running_artifacts(tmp_path):
    import fcntl

    source = tmp_path / "source.ply"
    source.write_bytes(b"ply")
    version = convert_scene.version_id_for(
        _sha256_of(source), convert_scene.conversion_recipe("balanced", 64, 32)
    )
    root = tmp_path / ".staging"
    artifact = root / version / "in-progress"
    artifact.parent.mkdir(parents=True)
    artifact.write_bytes(b"preserve")
    lock_dir = tmp_path / ".conversion-locks"
    lock_dir.mkdir()
    with (lock_dir / f"{version}.lock").open("a+b") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        result = convert_scene.convert_to_streamed_sog(source, root, scene_id="test")
    assert not result.ok
    assert artifact.read_bytes() == b"preserve"


def test_verify_rejects_inverted_counts(tmp_path):
    (tmp_path / "lod-meta.json").write_text(json.dumps({"counts": [10, 30, 100]}))
    (tmp_path / "manifest.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "format": "streamed-sog",
                "stream": {"entryUrl": "versions/test/lod-meta.json"},
            }
        )
    )
    with pytest.raises(ValueError):
        verify_published_version(tmp_path)
