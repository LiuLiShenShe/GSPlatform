from __future__ import annotations

import hashlib
import json
import struct
import zipfile

import pytest

from workers.pipeline.artifact_validator import validate_artifact_tree
from workers.pipeline.conversion_policy import automatic_recipe, resolve_conversion_policy, version_id_for
from workers.pipeline.convert_scene import _NODE_BIN, _convert_to_streamed_sog, convert_to_streamed_sog
from workers.pipeline.sog_container import validate_sog_container
from workers.pipeline.splat_transform_adapter import inspect_source
from workers.tests.test_convert_scene_formats import _gaussian_ply_bytes


@pytest.mark.skipif(not _NODE_BIN.exists(), reason="Pinned CLI requires installed node_modules")
def test_real_small_source_keeps_full_regular_sog(tmp_path):
    source = tmp_path / "source.ply"
    source.write_bytes(_gaussian_ply_bytes(1788))
    result = convert_to_streamed_sog(source, tmp_path / "staging", scene_id="test")
    assert result.ok, result.reason
    assert result.manifest["format"] == "sog"
    assert result.manifest["content"]["counts"] == [1788]
    assert (result.staging_dir / "scene.sog").is_file()
    assert not (result.staging_dir / "lod-meta.json").exists()
    assert validate_artifact_tree(result.staging_dir)["counts"] == [1788]


@pytest.mark.skipif(not _NODE_BIN.exists(), reason="Pinned CLI requires installed node_modules")
def test_regular_manifest_is_supported(tmp_path):
    source = tmp_path / "source.ply"
    source.write_bytes(_gaussian_ply_bytes(64))
    result = convert_to_streamed_sog(source, tmp_path / "staging", scene_id="test")
    assert result.ok, result.reason
    assert validate_artifact_tree(result.staging_dir)["counts"] == [64]


@pytest.mark.parametrize("count,mode", [(1788,"regular-sog"), (60000,"regular-sog"),
    (300000,"regular-sog"), (999999,"regular-sog"), (1000000,"streamed-sog"),
    (1000001,"streamed-sog")])
def test_verified_count_policy_boundary(tmp_path, monkeypatch, count, mode):
    source = tmp_path / "source.ply"
    source.write_bytes(_gaussian_ply_bytes(1))
    monkeypatch.setattr("workers.pipeline.conversion_policy.inspect_source", lambda *args, **kwargs:
                        {"gaussian": True, "numGaussians": count, "shBands": 0}, raising=False)
    policy = resolve_conversion_policy(source, profile="balanced", source_format="ply", gpu="cpu")
    assert policy.output_format == mode


@pytest.mark.parametrize("count,ratios", [(1000000, ["100%", "50%", "25%", "12.5%"]),
    (13090324, ["100%", "50%", "25%", "12.5%", "6.25%", "3.125%", "1.5625%"]),
    (999999, ["100%"]), (1000000000, ["100%", "50%", "25%", "12.5%", "6.25%", "3.125%", "1.5625%", "0.78125%"])])
def test_bounded_half_lod_recipe(count, ratios):
    recipe = automatic_recipe(count, "balanced", "cpu")
    assert recipe["lodRatios"] == ratios
    assert recipe["recipeVersion"] == "3"
    assert recipe["lodOrder"] == list(range(len(ratios)))


def test_new_recipe_identity_is_stable_and_separate_from_v2(monkeypatch):
    from workers.pipeline.conversion_policy import conversion_recipe

    digest = "a" * 64
    recipe = automatic_recipe(1788, "balanced", "cpu")
    identity = version_id_for(digest, recipe)
    monkeypatch.setenv("GS_CONVERT_TIMEOUT_S", "3")
    assert version_id_for(digest, automatic_recipe(1788, "quality", "cpu")) == identity
    assert identity != version_id_for(digest, conversion_recipe("balanced", 64, 32))
    assert automatic_recipe(1000000, "balanced", "0") == automatic_recipe(1000000, "balanced", "1")


@pytest.mark.skipif(not _NODE_BIN.exists(), reason="Pinned CLI requires installed node_modules")
def test_real_regular_passthrough_is_byte_identical_and_immutable(tmp_path):
    source = tmp_path / "source.ply"
    source.write_bytes(_gaussian_ply_bytes(64))
    converted = convert_to_streamed_sog(source, tmp_path / "staging", scene_id="test")
    assert converted.ok, converted.reason
    sog = converted.staging_dir / "scene.sog"
    result = convert_to_streamed_sog(sog, tmp_path / "pass", scene_id="test", source_format="sog")
    assert result.ok, result.reason
    assert result.recipe["encoding"] == "passthrough"
    assert (result.staging_dir / "scene.sog").read_bytes() == sog.read_bytes()
    assert result.source_sha256 == hashlib.sha256(sog.read_bytes()).hexdigest()
    assert result.version_id != converted.version_id
    validate_artifact_tree(result.staging_dir)


@pytest.mark.skipif(not _NODE_BIN.exists(), reason="Pinned CLI requires installed node_modules")
@pytest.mark.parametrize("damage", ["missing", "corrupt", "recipe", "checksum", "escape"])
def test_regular_artifact_corruption_is_never_publishable(tmp_path, damage):
    source = tmp_path / "source.ply"
    source.write_bytes(_gaussian_ply_bytes(64))
    result = convert_to_streamed_sog(source, tmp_path / "staging", scene_id="test")
    assert result.ok, result.reason
    entry = result.staging_dir / "scene.sog"
    if damage == "missing":
        entry.unlink()
    elif damage == "corrupt":
        entry.write_bytes(b"PK\x03\x04not-a-valid-sog")
    elif damage == "escape":
        entry.unlink()
        entry.symlink_to(source)
    elif damage == "checksum":
        (result.staging_dir / "checksums.sha256").write_text("0" * 64 + "  scene.sog\n")
    else:
        manifest = result.manifest
        manifest["conversionRecipe"]["sourceGaussianCount"] += 1
        (result.staging_dir / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises((ValueError, FileNotFoundError)):
        validate_artifact_tree(result.staging_dir)


@pytest.mark.parametrize("member", ["../escape", "empty.webp", "duplicate"])
def test_invalid_sog_container_rejected(tmp_path, member):
    source = tmp_path / "bad.sog"
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr("meta.json", '{"version":2,"count":10}')
        archive.writestr(member, b"invalid")
    with pytest.raises(ValueError):
        validate_sog_container(source)


@pytest.mark.skipif(not _NODE_BIN.exists(), reason="Pinned CLI requires installed node_modules")
def test_real_four_level_official_streamed_encoding(tmp_path):
    source = tmp_path / "source.ply"
    source.write_bytes(_gaussian_ply_bytes(1788))
    recipe = automatic_recipe(1_000_000, "balanced", "cpu")
    recipe["sourceGaussianCount"] = 1788
    result = _convert_to_streamed_sog(source, tmp_path / "staging", scene_id="fixture",
        gpu="cpu", source_format="ply", recipe_override=recipe)
    assert result.ok, result.reason
    assert result.manifest["format"] == "streamed-sog"
    assert validate_artifact_tree(result.staging_dir)["counts"] == [1788, 894, 447, 224]
    metadata = json.loads((result.staging_dir / "lod-meta.json").read_text())
    assert metadata["counts"] == [1788, 894, 447, 224]


@pytest.mark.skipif(not _NODE_BIN.exists(), reason="Pinned CLI requires installed node_modules")
def test_real_sh1_is_not_removed_from_regular_sog(tmp_path):
    original = _gaussian_ply_bytes(64)
    marker = original.index(b"end_header\n")
    header = original[:marker] + b"".join(
        f"property float f_rest_{index}\n".encode() for index in range(9)
    ) + b"end_header\n"
    payload = original[marker + len(b"end_header\n"):]
    rows = [payload[offset:offset + 56] + struct.pack("<9f", *[0.03 * index for index in range(9)])
            for offset in range(0, len(payload), 56)]
    source = tmp_path / "sh1.ply"
    source.write_bytes(header + b"".join(rows))
    assert inspect_source(source)["shBands"] == 1
    result = convert_to_streamed_sog(source, tmp_path / "staging", scene_id="sh1")
    assert result.ok, result.reason
    assert validate_sog_container(result.staging_dir / "scene.sog")["shBands"] == 1


@pytest.mark.skipif(not _NODE_BIN.exists(), reason="Pinned CLI requires installed node_modules")
def test_real_splat_input_uses_regular_sog(tmp_path):
    source = tmp_path / "input.splat"
    rows = [struct.pack("<6f8B", index * 0.01, 0, 0, 0.03, 0.03, 0.03,
                        210, 160, 120, 220, 255, 128, 128, 128) for index in range(64)]
    source.write_bytes(b"".join(rows))
    result = convert_to_streamed_sog(source, tmp_path / "staging", scene_id="splat", source_format="splat")
    assert result.ok, result.reason
    assert result.manifest["format"] == "sog"
    assert validate_artifact_tree(result.staging_dir)["counts"] == [64]


@pytest.mark.skipif(not _NODE_BIN.exists(), reason="Pinned CLI requires installed node_modules")
def test_regular_immutable_retry_never_reencodes(tmp_path, monkeypatch):
    import workers.pipeline.convert_scene as converter

    source = tmp_path / "input.ply"
    source.write_bytes(_gaussian_ply_bytes(64))
    result = convert_to_streamed_sog(source, tmp_path / ".staging", scene_id="retry")
    assert result.ok, result.reason
    published = tmp_path / "versions" / result.version_id
    published.parent.mkdir()
    result.staging_dir.rename(published)
    original = (published / "scene.sog").read_bytes()
    monkeypatch.setattr(converter, "_convert_to_streamed_sog",
                        lambda *args, **kwargs: pytest.fail("Immutable retry must not encode again"))
    retried = convert_to_streamed_sog(source, tmp_path / ".staging", scene_id="retry")
    assert retried.ok and retried.staging_dir == published
    assert (published / "scene.sog").read_bytes() == original


@pytest.mark.skipif(not _NODE_BIN.exists(), reason="Pinned CLI requires installed node_modules")
def test_real_legacy_sog_passthrough_keeps_container_bytes(tmp_path):
    source = tmp_path / "source.ply"
    source.write_bytes(_gaussian_ply_bytes(64))
    encoded = convert_to_streamed_sog(source, tmp_path / "encoded", scene_id="legacy")
    assert encoded.ok, encoded.reason
    legacy = tmp_path / "legacy.sog"
    with zipfile.ZipFile(encoded.staging_dir / "scene.sog") as modern:
        metadata = json.loads(modern.read("meta.json"))
        metadata.pop("version")
        metadata.pop("count")
        metadata["means"]["shape"] = [64, 3]
        metadata["scales"].update({"shape": [64, 3], "mins": [-4, -4, -4], "maxs": [-2, -2, -2]})
        metadata["sh0"].update({"shape": [64, 4], "mins": [0, 0, 0, -4], "maxs": [1, 1, 1, 4]})
        metadata["quats"]["shape"] = [64, 4]
        with zipfile.ZipFile(legacy, "w") as archive:
            archive.writestr("meta.json", json.dumps(metadata))
            for name in modern.namelist():
                if name != "meta.json":
                    archive.writestr(name, modern.read(name))
    assert inspect_source(legacy, decode=True)["numGaussians"] == 64
    assert validate_sog_container(legacy)["numGaussians"] == 64
    published = convert_to_streamed_sog(legacy, tmp_path / "passed", scene_id="legacy", source_format="sog")
    assert published.ok, published.reason
    assert (published.staging_dir / "scene.sog").read_bytes() == legacy.read_bytes()
    assert validate_artifact_tree(published.staging_dir)["counts"] == [64]
