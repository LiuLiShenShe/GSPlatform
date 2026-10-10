"""Pipeline — verify a published version directory before DB commit (Phase 06)."""

from __future__ import annotations

import json
from pathlib import Path

from workers.pipeline.validate_scene import _sha256_of


def verify_published_version(version_dir: Path) -> dict:
    """Verify a fully-assembled version directory is publish-safe.

    ``version_dir`` is either an isolated staging tree or an immutable version.
    Verify the supplied tree itself, never a sibling version referenced by a
    scene-root-relative manifest URL.

    Returns a dict with keys used by the publisher. Raises ``ValueError``
    on any missing/corrupt asset.
    """
    manifest_path = version_dir / "manifest.json"
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
    if not counts or any(c <= 0 for c in counts):
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
        chunk_counts.append(metadata.get("count", 0))
        for layer in metadata.values():
            if isinstance(layer, dict):
                for texture in layer.get("files", []):
                    payload = asset_path((Path(filename).parent / texture).as_posix())
                    if payload.stat().st_size == 0:
                        raise ValueError("空 chunk payload")
    if chunk_counts and sum(chunk_counts) != sum(counts):
        raise ValueError("chunk Gaussian 总数与 lod-meta counts 不一致")

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
    if build_info_path.is_file():
        build_info = json.loads(build_info_path.read_text())
        if build_info.get("lodCounts", counts) != counts:
            raise ValueError("build-info lodCounts 不一致")
        recipe = build_info.get("conversionRecipe", {})
        if recipe.get("lodRatios") == ["100%", "30%", "10%"]:
            if len(counts) != 3 or counts[0] != build_info.get("sourceGaussianCount"):
                raise ValueError("LOD0 未保留完整源 Gaussian")

    return {
        "entry_url": entry_url,
        "entry_bytes": entry_path.stat().st_size,
        "manifest": manifest,
        "counts": [int(c) for c in counts],
    }
