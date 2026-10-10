"""FIX-CONVERT-01 — LOD hierarchy, chunk profile, version identity, metadata.

RED-first coverage for four defects found by auditing the conversion of a real
13M-gaussian scene:

RED-01  The stack tagged the tiers backwards. PlayCanvas' streamed-SOG spec
        says "LOD 0 = highest detail"; the code fed ``low.ply`` (10%) as LOD 0
        and ``high.ply`` (100%) as LOD 2, so the viewer streamed the emptiest
        tier as the base level and the full-detail tier as the coarsest.
RED-02  The balanced profile asked for 4K gaussians per chunk (``--lod-chunk-
        count 4``). Proven by benchmark: see the report; the parameters now
        come from measured data, and this test locks the CLI arguments that
        actually reach splat-transform.
RED-03  ``asset_version`` was ``source_sha256[:12]`` — a function of the SOURCE
        only. Re-converting the same PLY with different parameters produced the
        same id and collided with the already-published immutable version.
RED-04  ``_write_metadata`` hardcoded profile/chunkCount/chunkExtent/gpu, so the
        shipped report contradicted the artifact whenever the run differed.

The CLI-requiring tests use the REAL pinned splat-transform 3.3.3; the pure
command-construction tests spy on ``_run`` and assert on the real argv.
"""

from __future__ import annotations

import json
import shutil
import struct
import subprocess
from pathlib import Path

import pytest

from workers.pipeline.convert_scene import (
    _LOD_RATIOS,
    _PROFILES,
    _marker_for,
    _reusable_decimation,
    conversion_recipe,
    convert_to_streamed_sog,
    version_id_for,
)

SCENE_UUID = "11111111-2222-3333-4444-555555555555"
SHA_A = "a" * 64
SHA_B = "b" * 64


def _node_bin() -> Path:
    import workers.pipeline.convert_scene as mod

    return mod._NODE_BIN


REQUIRES_CLI = pytest.mark.skipif(
    not _node_bin().exists(),
    reason="splat-transform CLI 不在本 checkout（node_modules 未随 git archive 分发）",
)


def _gaussian_ply_bytes(n: int = 512) -> bytes:
    props = [
        ("x", "float"),
        ("y", "float"),
        ("z", "float"),
        ("f_dc_0", "float"),
        ("f_dc_1", "float"),
        ("f_dc_2", "float"),
        ("opacity", "float"),
        ("scale_0", "float"),
        ("scale_1", "float"),
        ("scale_2", "float"),
        ("rot_0", "float"),
        ("rot_1", "float"),
        ("rot_2", "float"),
        ("rot_3", "float"),
    ]
    head = ["ply", "format binary_little_endian 1.0", f"element vertex {n}"]
    head += [f"property {t} {nm}" for nm, t in props]
    head += ["end_header"]
    header = ("\n".join(head) + "\n").encode("ascii")
    rows = []
    for i in range(n):
        x = (i % 16) / 16.0 * 2 - 1
        y = ((i // 16) % 16) / 16.0 * 2 - 1
        z = ((i // 256) % 2) * 0.1
        rows.append(
            struct.pack(
                "<14f",
                x,
                y,
                z,
                0.5,
                0.5,
                0.5,
                0.9,
                -3.0,
                -3.0,
                -3.0,
                1.0,
                0.0,
                0.0,
                0.0,
            )
        )
    return header + b"".join(rows)


def _stage(tmp_path: Path, data: bytes) -> Path:
    d = tmp_path / "staging"
    d.mkdir(parents=True, exist_ok=True)
    p = d / "upload.bin"
    p.write_bytes(data)
    return p


@pytest.fixture
def captured_commands(monkeypatch):
    """Record every real argv the converter hands to splat-transform."""
    import workers.pipeline.convert_scene as mod

    seen: list[list[str]] = []
    real = mod._run

    def spy(cmd, cwd=None, timeout=None):
        seen.append(list(cmd))
        return real(cmd, cwd=cwd, timeout=timeout)

    monkeypatch.setattr(mod, "_run", spy)
    return seen


def _stack_cmd(seen: list[list[str]]) -> list[str]:
    stacks = [c for c in seen if "lod-meta.json" in " ".join(c)]
    assert stacks, f"no stack invocation recorded: {seen}"
    return stacks[0]


# ── RED-01: LOD hierarchy ────────────────────────────────────────────────────
@REQUIRES_CLI
def test_ply_source_is_lod0_and_tiers_are_30_10(tmp_path, captured_commands):
    """LOD 0 must be the untouched original, LOD 1 = 30%, LOD 2 = 10%."""
    src = _stage(tmp_path, _gaussian_ply_bytes(600))
    res = convert_to_streamed_sog(
        src,
        tmp_path / "published" / ".staging",
        scene_id=SCENE_UUID,
        source_format="ply",
    )
    assert res.ok, res.reason

    stack = _stack_cmd(captured_commands)
    # Tag positions must be original→0, lod1→1, lod2→2.
    assert stack.count("--tag-lod") == 3
    pairs = [
        (stack[i - 1], stack[i + 1]) for i, a in enumerate(stack) if a == "--tag-lod"
    ]
    lod0_input, tag0 = pairs[0]
    lod1_input, tag1 = pairs[1]
    lod2_input, tag2 = pairs[2]
    assert tag0 == "0", pairs
    assert tag1 == "1", pairs
    assert tag2 == "2", pairs
    # LOD 0 is the ORIGINAL raw-input copy — not a re-decimated file.
    assert Path(lod0_input).name.startswith("raw-input"), lod0_input
    assert Path(lod1_input).name == "lod1.ply"
    assert Path(lod2_input).name == "lod2.ply"

    # The reduced tiers come from 30% / 10% decimation of that same source.
    ratios = [
        c[c.index("--decimate") + 1] for c in captured_commands if "--decimate" in c
    ]
    assert ratios == ["30%", "10%"], ratios


@REQUIRES_CLI
def test_no_redundant_100_percent_decimate_for_ply(tmp_path, captured_commands):
    """A PLY upload must not spend a full extra pass re-encoding LOD 0.

    ``--decimate 100%`` produced a byte-identical copy of the source
    (measured: 3.2 GB re-written in 9s) purely to obtain a PLY that already
    existed.
    """
    src = _stage(tmp_path, _gaussian_ply_bytes(600))
    res = convert_to_streamed_sog(
        src,
        tmp_path / "published" / ".staging",
        scene_id=SCENE_UUID,
        source_format="ply",
    )
    assert res.ok, res.reason
    ratios = [
        c[c.index("--decimate") + 1] for c in captured_commands if "--decimate" in c
    ]
    assert "100%" not in ratios, f"redundant full-detail pass still runs: {ratios}"


@REQUIRES_CLI
def test_ply_lod0_uses_source_inode_without_full_copy(tmp_path, captured_commands):
    src = _stage(tmp_path, _gaussian_ply_bytes(600))
    res = convert_to_streamed_sog(
        src,
        tmp_path / "published" / ".staging",
        scene_id=SCENE_UUID,
        source_format="ply",
    )
    assert res.ok, res.reason
    raw = next((tmp_path / "published").glob(".workdir-*/raw-input.ply"))
    assert raw.stat().st_ino == src.stat().st_ino
    assert src.read_bytes() == _gaussian_ply_bytes(600)


@REQUIRES_CLI
def test_real_cli_reports_lod_counts_highest_detail_first(tmp_path):
    """Ground the ordering in real numbers, not in the argv we built.

    Asserts against what the pinned CLI actually wrote into lod-meta.json.
    """
    src = _stage(tmp_path, _gaussian_ply_bytes(900))
    res = convert_to_streamed_sog(
        src,
        tmp_path / "published" / ".staging",
        scene_id=SCENE_UUID,
        source_format="ply",
    )
    assert res.ok, res.reason
    meta = json.loads(
        (
            tmp_path / "published" / ".staging" / res.version_id / "lod-meta.json"
        ).read_text()
    )
    counts = meta["counts"]
    assert len(counts) == 3, counts
    assert counts[0] >= counts[1] >= counts[2], (
        f"LOD counts must decrease with level, got {counts}"
    )
    assert counts[0] == 900, f"LOD0 must be the full source, got {counts[0]}"


# ── RED-02: chunk profile ────────────────────────────────────────────────────
def test_balanced_profile_is_not_the_4k_baseline():
    """The old balanced profile asked for 4K gaussians per chunk."""
    count, extent = _PROFILES["balanced"]
    assert count != 4, f"balanced chunk-count regressed to the 4K baseline: {count}"
    assert extent > 0


@REQUIRES_CLI
def test_stack_uses_profile_chunk_arguments(tmp_path, captured_commands):
    count, extent = _PROFILES["balanced"]
    src = _stage(tmp_path, _gaussian_ply_bytes(600))
    res = convert_to_streamed_sog(
        src,
        tmp_path / "published" / ".staging",
        scene_id=SCENE_UUID,
        source_format="ply",
    )
    assert res.ok, res.reason
    stack = _stack_cmd(captured_commands)
    assert stack[stack.index("--lod-chunk-count") + 1] == str(count)
    assert stack[stack.index("--lod-chunk-extent") + 1] == str(extent)


@REQUIRES_CLI
def test_cli_rejects_lod_chunk_min_on_pinned_version(tmp_path, captured_commands):
    """Guard the version gap we hit: 3.3.3 has no ``--lod-chunk-min``.

    The online CLI reference documents it, but passing it aborts the whole
    conversion with ERR_PARSE_ARGS_UNKNOWN_OPTION.
    """
    src = _stage(tmp_path, _gaussian_ply_bytes(600))
    res = convert_to_streamed_sog(
        src,
        tmp_path / "published" / ".staging",
        scene_id=SCENE_UUID,
        source_format="ply",
    )
    assert res.ok, res.reason
    for cmd in captured_commands:
        assert "--lod-chunk-min" not in cmd, (
            "pinned splat-transform 3.3.3 does not accept --lod-chunk-min"
        )


# ── RED-03: version identity ────────────────────────────────────────────────
def test_same_source_different_recipe_yields_different_version():
    """RED-03: the version id must move when the recipe moves."""
    a = conversion_recipe("balanced", 256, 16)
    b = conversion_recipe("balanced", 64, 16)
    assert version_id_for(SHA_A, a) != version_id_for(SHA_A, b)


def test_same_source_same_recipe_is_stable():
    a = conversion_recipe("balanced", 256, 16)
    assert version_id_for(SHA_A, a) == version_id_for(SHA_A, a)


def test_different_source_same_recipe_yields_different_version():
    a = conversion_recipe("balanced", 256, 16)
    assert version_id_for(SHA_A, a) != version_id_for(SHA_B, a)


def test_version_id_shape_satisfies_db_constraint():
    """SceneVersion CHECK: length(asset_version) BETWEEN 8 AND 80."""
    a = conversion_recipe("balanced", 256, 16)
    vid = version_id_for(SHA_A, a)
    assert 8 <= len(vid) <= 80
    assert vid == vid.lower()
    assert all(c in "0123456789abcdef" for c in vid)


def test_recipe_excludes_non_content_factors():
    """Timeout / device tuning must never mint a new asset version.

    They are recorded separately (build-info) but must stay out of the identity,
    or an operator raising GS_CONVERT_TIMEOUT_S would orphan every version.
    """
    recipe = conversion_recipe("balanced", 256, 16)
    keys = set(recipe)
    assert "timeout" not in keys
    assert "gpu" not in keys
    assert "gpuDevice" not in keys
    assert recipe["lodRatios"] == ["100%", "30%", "10%"]


@REQUIRES_CLI
def test_published_version_dirs_do_not_collide_across_recipes(tmp_path):
    """End-to-end: same source converted twice must produce two dirs."""
    src = _stage(tmp_path, _gaussian_ply_bytes(600))
    root = tmp_path / "published" / ".staging"

    first = convert_to_streamed_sog(
        src, root, scene_id=SCENE_UUID, source_format="ply", profile="balanced"
    )
    assert first.ok, first.reason

    # Same bytes, different recipe (different profile => different chunk params).
    second = convert_to_streamed_sog(
        src, root, scene_id=SCENE_UUID, source_format="ply", profile="quality"
    )
    assert second.ok, second.reason

    assert first.version_id != second.version_id
    assert (root / first.version_id / "lod-meta.json").exists()
    assert (root / second.version_id / "lod-meta.json").exists()
    # And the first version was not mutated by the second run.
    assert first.source_sha256 == second.source_sha256


def test_output_is_written_into_version_scoped_staging(tmp_path, monkeypatch):
    """Two concurrent publishes of one scene must not share a staging dir."""
    import workers.pipeline.convert_scene as mod

    def fake(cmd, cwd=None, timeout=None):
        # Emulate the CLI's contract: write the file named as the output.
        if "--decimate" in cmd:
            out = Path(cmd[cmd.index("--decimate") + 2])
        else:
            out = Path(next(a for a in cmd if a.endswith("lod-meta.json")))
        out.parent.mkdir(parents=True, exist_ok=True)
        if "--decimate" in cmd:
            ratio = int(cmd[cmd.index("--decimate") + 1].rstrip("%"))
            out.write_bytes(_gaussian_ply_bytes(max(1, 64 * ratio // 100)))
        else:
            out.write_bytes(
                json.dumps(
                    {"counts": [64, 19, 6], "filenames": [], "tree": {}}
                ).encode()
            )
        return ""

    monkeypatch.setattr(mod, "_run", fake)

    src = _stage(tmp_path, _gaussian_ply_bytes(64))
    root = tmp_path / "published" / ".staging"
    res = convert_to_streamed_sog(src, root, scene_id=SCENE_UUID, source_format="ply")
    assert res.ok, res.reason
    vdir = root / res.version_id
    assert vdir.is_dir(), f"expected version-scoped staging, got {list(root.iterdir())}"
    assert (vdir / "manifest.json").exists()


# ── RED-04: metadata truthfulness ────────────────────────────────────────────
@REQUIRES_CLI
def test_build_info_records_the_parameters_that_actually_ran(tmp_path):
    count, extent = _PROFILES["balanced"]
    src = _stage(tmp_path, _gaussian_ply_bytes(600))
    res = convert_to_streamed_sog(
        src,
        tmp_path / "published" / ".staging",
        scene_id=SCENE_UUID,
        source_format="ply",
    )
    assert res.ok, res.reason
    vdir = tmp_path / "published" / ".staging" / res.version_id
    info = json.loads((vdir / "build-info.json").read_text())

    assert info["profile"] == "balanced"
    assert info["lodChunkCount"] == count
    assert info["lodChunkExtent"] == extent
    assert info["lodRatios"] == ["100%", "30%", "10%"]
    assert info["toolVersion"] == "3.3.3"
    assert info["gpuDevice"] == "cpu"
    # The source gaussian count comes from the PLY header, not a constant.
    assert info["sourceGaussianCount"] == 600
    # Per-stage timings are recorded, and none is negative.
    stages = info["stageDurations"]
    assert stages, "no stage durations recorded"
    assert all(v >= 0 for v in stages.values()), stages
    assert info["totalDuration"] > 0


@REQUIRES_CLI
def test_manifest_counts_match_the_lod_meta(tmp_path):
    src = _stage(tmp_path, _gaussian_ply_bytes(600))
    res = convert_to_streamed_sog(
        src,
        tmp_path / "published" / ".staging",
        scene_id=SCENE_UUID,
        source_format="ply",
    )
    assert res.ok, res.reason
    vdir = tmp_path / "published" / ".staging" / res.version_id
    manifest = json.loads((vdir / "manifest.json").read_text())
    meta = json.loads((vdir / "lod-meta.json").read_text())
    assert manifest["stream"]["counts"] == meta["counts"]
    assert manifest["assetVersion"] == res.version_id


# ── intermediate reuse (PART E) ──────────────────────────────────────────────
def test_decimation_reuse_requires_matching_marker(tmp_path):
    """A file that merely EXISTS is not a valid intermediate."""
    target = tmp_path / "lod1.ply"
    target.write_bytes(b"half written")
    # No marker at all -> not reusable.
    assert not _reusable_decimation(
        target, ratio="30%", source_sha256=SHA_A, recipe_key="k"
    )


def test_decimation_reuse_rejects_wrong_recipe(tmp_path):
    import workers.pipeline.convert_scene as mod

    target = tmp_path / "lod1.ply"
    target.write_bytes(_gaussian_ply_bytes(16))
    mod._mark_decimation(target, ratio="30%", source_sha256=SHA_A, recipe_key="k1")
    assert _reusable_decimation(
        target, ratio="30%", source_sha256=SHA_A, recipe_key="k1"
    )
    # A different conversion recipe must not inherit this file.
    assert not _reusable_decimation(
        target, ratio="30%", source_sha256=SHA_A, recipe_key="k2"
    )
    # Nor a different source.
    assert not _reusable_decimation(
        target, ratio="30%", source_sha256=SHA_B, recipe_key="k1"
    )


def test_decimation_reuse_rejects_truncated_output(tmp_path):
    import workers.pipeline.convert_scene as mod

    target = tmp_path / "lod1.ply"
    target.write_bytes(_gaussian_ply_bytes(16))
    mod._mark_decimation(target, ratio="30%", source_sha256=SHA_A, recipe_key="k")
    assert _reusable_decimation(
        target, ratio="30%", source_sha256=SHA_A, recipe_key="k"
    )
    # Truncate it (as an interrupted write would): must not be trusted.
    target.write_bytes(b"complete")
    assert not _reusable_decimation(
        target, ratio="30%", source_sha256=SHA_A, recipe_key="k"
    )


@REQUIRES_CLI
def test_failed_run_leaves_reusable_intermediates(tmp_path, monkeypatch):
    """A failed conversion must not throw away hours of decimation."""
    import workers.pipeline.convert_scene as mod

    src = _stage(tmp_path, _gaussian_ply_bytes(600))
    root = tmp_path / "published" / ".staging"
    real = mod._run
    calls = {"n": 0}

    def flaky(cmd, cwd=None, timeout=None):
        calls["n"] += 1
        if "lod-meta.json" in " ".join(cmd):
            raise RuntimeError("simulated stack failure")
        return real(cmd, cwd=cwd, timeout=timeout)

    monkeypatch.setattr(mod, "_run", flaky)
    first = convert_to_streamed_sog(src, root, scene_id=SCENE_UUID, source_format="ply")
    assert not first.ok
    assert "stack" in first.reason

    workdirs = list((root.parent).glob(".workdir-*"))
    assert workdirs, "workdir removed on failure — intermediates cannot be reused"
    kept = sorted(p.name for p in workdirs[0].glob("lod*.ply"))
    assert kept == ["lod1.ply", "lod2.ply"], kept

    # Retry with a working CLI: it must reuse, not redo, the decimation.
    monkeypatch.setattr(mod, "_run", real)
    decimate_calls_before = calls["n"]
    second = convert_to_streamed_sog(
        src, root, scene_id=SCENE_UUID, source_format="ply"
    )
    assert second.ok, second.reason
    assert second.stage_durations is not None


# ── CLI hygiene (PART C) ────────────────────────────────────────────────────
@REQUIRES_CLI
def test_background_invocations_do_not_request_a_tty(tmp_path, captured_commands):
    """Use supported non-interactive and bounded encoder-worker options."""
    src = _stage(tmp_path, _gaussian_ply_bytes(600))
    res = convert_to_streamed_sog(
        src,
        tmp_path / "published" / ".staging",
        scene_id=SCENE_UUID,
        source_format="ply",
    )
    assert res.ok, res.reason
    for cmd in captured_commands:
        assert "--tty" not in cmd, (
            f"interactive flag passed to a background worker: {cmd}"
        )
        assert "--no-tty" in cmd, f"explicit non-interactive flag expected: {cmd}"
        assert cmd[cmd.index("--max-workers") + 1] == "0"
