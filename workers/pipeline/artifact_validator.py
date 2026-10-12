"""Pipeline — verify a published version directory before DB commit (Phase 06)."""

from __future__ import annotations

import json
import re
from pathlib import Path

from workers.pipeline.validate_scene import _sha256_of


def _validate_regular(version_dir: Path, manifest: dict) -> dict:
    from workers.pipeline.conversion_policy import version_id_for
    from workers.pipeline.sog_container import validate_sog_container

    entry_url = f"versions/{manifest.get('assetVersion')}/scene.sog"
    content = manifest.get("content", {})
    if manifest.get("assetUrl") != entry_url or content.get("entryUrl") != entry_url:
        raise ValueError("Regular SOG entryUrl disagrees with version identity")
    entry = (version_dir / "scene.sog").resolve()
    root = version_dir.resolve()
    if not entry.is_relative_to(root) or not entry.is_file() or entry.stat().st_size <= 0:
        raise ValueError("Regular SOG entry missing or outside version")
    inspection = validate_sog_container(entry)
    counts = [inspection["numGaussians"]]
    digest = _sha256_of(entry)
    if (content.get("counts") != counts or content.get("byteLength") != entry.stat().st_size
            or content.get("sha256") != digest):
        raise ValueError("Regular SOG content integrity mismatch")
    source_sha = manifest.get("sourceSha256", "")
    recipe = manifest.get("conversionRecipe", {})
    if (not re.fullmatch(r"[0-9a-f]{64}", source_sha)
            or recipe.get("recipeVersion") != "3" or recipe.get("mode") != "regular-sog"
            or manifest.get("conversionRecipeVersion") != "3"
            or recipe.get("sourceGaussianCount") != counts[0]
            or recipe.get("sourceShBands") != inspection.get("shBands")
            or version_id_for(source_sha, recipe) != manifest.get("assetVersion")):
        raise ValueError("Regular SOG source/recipe identity mismatch")
    build_path = root / "build-info.json"
    checksum_path = root / "checksums.sha256"
    if not build_path.is_file() or not checksum_path.is_file():
        raise ValueError("Regular SOG requires BuildInfo and Checksums")
    build = json.loads(build_path.read_text())
    if (build.get("sourceSha256") != source_sha or build.get("sourceGaussianCount") != counts[0]
            or build.get("conversionRecipe") != recipe or build.get("lodCounts") != counts
            or build.get("outputSha256") != digest or build.get("officialInspection") != inspection):
        raise ValueError("Regular SOG BuildInfo mismatch")
    executions = build.get("cliExecutions") or []
    if recipe.get("encoding") == "passthrough":
        if executions or digest != source_sha:
            raise ValueError("SOG passthrough changed source bytes")
    else:
        commands = [record.get("arguments", []) for record in executions]
        encoding = [command for command in commands if "scene.sog" in command]
        if len(encoding) != 1 or any(record.get("exitCode") != 0 for record in executions):
            raise ValueError("Regular SOG requires successful encoding evidence")
        command = encoding[0]
        if ("--sh-iterations" not in command
                or command[command.index("--sh-iterations") + 1] != str(recipe.get("shIterations"))
                or any(option in command for option in ("--decimate", "--filter-harmonics",
                                                         "--scale", "--translate", "--rotate"))):
            raise ValueError("Regular SOG command disagrees with recipe")
    checked = set()
    for line in checksum_path.read_text().splitlines():
        expected, relative = line.split("  ", 1)
        target = (root / relative).resolve()
        if not target.is_relative_to(root) or not target.is_file() or _sha256_of(target) != expected:
            raise ValueError("Regular SOG checksum mismatch")
        checked.add(relative)
    actual = {path.relative_to(root).as_posix() for path in root.rglob("*")
              if path.is_file() and path != checksum_path}
    if checked != actual:
        raise ValueError("Regular SOG Checksums do not cover all artifacts")
    return {"entry_url": entry_url, "entry_bytes": entry.stat().st_size,
            "manifest": manifest, "counts": counts}


def validate_artifact_tree(version_dir: Path) -> dict:
    """Verify a fully-assembled version directory is publish-safe.

    ``version_dir`` is either an isolated staging tree or an immutable version.
    Verify the supplied tree itself, never a sibling version referenced by a
    scene-root-relative manifest URL.

    Returns a dict with keys used by the publisher. Raises ``ValueError``
    on any missing/corrupt asset.
    """
    manifest_path = version_dir / "manifest.json"
    root = version_dir.resolve()
    for artifact in version_dir.rglob("*"):
        if not artifact.resolve().is_relative_to(root):
            raise ValueError("Artifact escapes immutable version directory")
    if not manifest_path.exists():
        raise ValueError(f"manifest.json 缺失: {version_dir}")

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"manifest.json 不是合法 JSON: {exc}") from exc

    if manifest.get("schemaVersion") != 1:
        raise ValueError(
            f"不支持的 manifest schemaVersion: {manifest.get('schemaVersion')}"
        )
    if manifest.get("format") == "sog":
        return _validate_regular(version_dir, manifest)
    if manifest.get("format") != "streamed-sog":
        raise ValueError(f"不支持的 format: {manifest.get('format')}")

    stream = manifest.get("stream", {})
    entry_url = stream.get("entryUrl")
    if not entry_url:
        raise ValueError("manifest.stream.entryUrl 缺失")

    entry_path = (version_dir / "lod-meta.json").resolve()

    if not entry_path.is_relative_to(version_dir.resolve()) or not entry_path.is_file():
        raise ValueError(f"entryUrl 引用的文件不存在或路径无效: {entry_url}")

    try:
        lod_meta = json.loads(entry_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"lod-meta.json 不是合法 JSON: {exc}") from exc

    counts = lod_meta.get("counts", [])
    if not counts or any(type(count) is not int or count <= 0 for count in counts):
        raise ValueError("lod-meta.json counts 无效")
    if any(first < second for first, second in zip(counts, counts[1:])):
        raise ValueError("lod-meta.json LOD counts 顺序错误: LOD0 必须为最高精度")
    if stream.get("counts", counts) != counts:
        raise ValueError("manifest counts 与 lod-meta.json 不一致")
    if stream.get("byteLength", entry_path.stat().st_size) != entry_path.stat().st_size:
        raise ValueError("manifest byteLength 与入口文件不一致")
    if stream.get("sha256") and stream["sha256"] != _sha256_of(entry_path):
        raise ValueError("manifest entry sha256 校验失败")
    if (
        manifest.get("assetVersion")
        and entry_url != f"versions/{manifest['assetVersion']}/lod-meta.json"
    ):
        raise ValueError("manifest entryUrl 与 assetVersion 不一致")

    def asset_path(relative: str) -> Path:
        path = (version_dir / relative).resolve()
        if not path.is_relative_to(version_dir.resolve()) or not path.is_file():
            raise ValueError(f"chunk asset 缺失或路径无效: {relative}")
        return path

    chunk_counts = []
    for filename in lod_meta.get("filenames", []):
        metadata_path = asset_path(filename)
        metadata = json.loads(metadata_path.read_text())
        if metadata_path.stat().st_size == 0 or metadata.get("count", 0) <= 0:
            raise ValueError("空 chunk metadata")
        chunk_counts.append(metadata.get("count", 0))
        for layer in metadata.values():
            if isinstance(layer, dict):
                for texture in layer.get("files", []):
                    payload = asset_path((Path(filename).parent / texture).as_posix())
                    if payload.stat().st_size == 0:
                        raise ValueError("空 chunk payload")
    if chunk_counts and sum(chunk_counts) != sum(counts):
        raise ValueError("chunk Gaussian 总数与 lod-meta counts 不一致")

    referenced_counts = [0] * len(counts)

    def validate_node(node: dict) -> None:
        for level, reference in node.get("lods", {}).items():
            index = int(level)
            file_index = reference.get("file")
            offset = reference.get("offset")
            count = reference.get("count")
            if (
                index < 0 or index >= len(counts)
                or type(file_index) is not int or file_index < 0
                or file_index >= len(chunk_counts)
                or type(offset) is not int or offset < 0
                or type(count) is not int or count <= 0
                or offset + count > chunk_counts[file_index]
            ):
                raise ValueError("LOD tree chunk reference 无效")
            referenced_counts[index] += count
        for child in node.get("children", []):
            validate_node(child)

    tree = lod_meta.get("tree", {})
    if tree:
        validate_node(tree)
        if referenced_counts != counts:
            raise ValueError("LOD tree counts 与 metadata 不一致")

    checksum_path = version_dir / "checksums.sha256"
    if manifest.get("conversionRecipeVersion") and not checksum_path.is_file():
        raise ValueError("checksums.sha256 缺失")
    if checksum_path.is_file():
        checked = set()
        for line in checksum_path.read_text().splitlines():
            digest, relative = line.split("  ", 1)
            if _sha256_of(asset_path(relative)) != digest:
                raise ValueError(f"checksum 校验失败: {relative}")
            checked.add(relative)
        actual = {
            path.relative_to(version_dir).as_posix()
            for path in version_dir.rglob("*")
            if path.is_file() and path != checksum_path
        }
        if checked != actual:
            raise ValueError("checksums.sha256 未覆盖所有资产")

    build_info_path = version_dir / "build-info.json"
    if manifest.get("conversionRecipeVersion") and not build_info_path.is_file():
        raise ValueError("build-info.json 缺失")
    if build_info_path.is_file():
        build_info = json.loads(build_info_path.read_text())
        if build_info.get("lodCounts", counts) != counts:
            raise ValueError("build-info lodCounts 不一致")
        recipe = build_info.get("conversionRecipe", {})
        if recipe and recipe != manifest.get("conversionRecipe"):
            raise ValueError("build-info recipe 与 Manifest 不一致")
        if build_info.get("sourceSha256") != manifest.get("sourceSha256"):
            raise ValueError("build-info source provenance 不一致")
        executions = build_info.get("cliExecutions")
        if executions:
            from workers.pipeline.conversion_policy import version_id_for

            if version_id_for(manifest["sourceSha256"], recipe) != manifest.get("assetVersion"):
                raise ValueError("assetVersion 与 source/recipe 不一致")
            if not chunk_counts:
                raise ValueError("CLI 输出缺少 chunk references")
            stack_commands = [record["arguments"] for record in executions
                              if "lod-meta.json" in record.get("arguments", [])]
            if len(stack_commands) != 1:
                raise ValueError("BuildInfo 缺少实际 Stack command")
            command = stack_commands[0]
            for option, field in (("--lod-chunk-count", "lodChunkCount"),
                                  ("--lod-chunk-extent", "lodChunkExtent"),
                                  ("--sh-iterations", "shIterations")):
                if option not in command or command[command.index(option) + 1] != str(recipe[field]):
                    raise ValueError("实际 command 与 recipe 不一致")
        if recipe.get("lodRatios") == ["100%", "30%", "10%"]:
            if len(counts) != 3 or counts[0] != build_info.get("sourceGaussianCount"):
                raise ValueError("LOD0 未保留完整源 Gaussian")
        if recipe.get("mode") == "streamed-sog" and recipe.get("recipeVersion") == "3":
            if (len(counts) != len(recipe.get("lodRatios", []))
                    or counts[0] != build_info.get("sourceGaussianCount")
                    or counts[0] != recipe.get("sourceGaussianCount")):
                raise ValueError("Recipe v3 LOD hierarchy disagrees with source")

    return {
        "entry_url": entry_url,
        "entry_bytes": entry_path.stat().st_size,
        "manifest": manifest,
        "counts": [int(c) for c in counts],
    }
