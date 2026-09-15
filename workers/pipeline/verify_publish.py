"""Pipeline — verify a published version directory before DB commit (Phase 06)."""

from __future__ import annotations

import json
from pathlib import Path


def verify_published_version(version_dir: Path) -> dict:
    """Verify a fully-assembled version directory is publish-safe.

    ``version_dir`` is either a staging dir (``.staging/``) or a final
    version dir (``versions/<sha>/``).  The manifest's ``stream.entryUrl``
    is scene-root-relative; to resolve it we walk up until we find a
    parent that contains a ``versions`` subdirectory, then resolve
    relative to that scene root.

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
        raise ValueError(f"不支持的 manifest schemaVersion: {manifest.get('schemaVersion')}")
    if manifest.get("format") != "streamed-sog":
        raise ValueError(f"不支持的 format: {manifest.get('format')}")

    stream = manifest.get("stream", {})
    entry_url = stream.get("entryUrl")
    if not entry_url:
        raise ValueError("manifest.stream.entryUrl 缺失")

    # ── Resolve entry_url relative to the scene root ─────────────────────────
    # The entry_url is scene-root-relative (e.g. versions/<sha>/lod-meta.json).
    # When version_dir is the staging dir, lod-meta.json lives at the root.
    # When it's the final published dir, the manifest hasn't been re-written
    # yet so we walk up to find the scene root and resolve there.
    scene_root = _find_scene_root(version_dir)
    if scene_root is not None:
        entry_path = (scene_root / entry_url).resolve()
    else:
        # Fallback: lod-meta.json is at the version_dir root (staging layout).
        entry_path = (version_dir / "lod-meta.json").resolve()

    if not entry_path.exists() or not entry_path.is_file():
        # second attempt: check version_dir root directly
        fallback = (version_dir / "lod-meta.json").resolve()
        if fallback.exists() and fallback.is_file():
            entry_path = fallback
        else:
            raise ValueError(
                f"entryUrl 引用的文件不存在: {entry_url}  (scene_root={scene_root})"
            )

    try:
        lod_meta = json.loads(entry_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"lod-meta.json 不是合法 JSON: {exc}") from exc

    counts = lod_meta.get("counts", [])
    if not counts or any(c <= 0 for c in counts):
        raise ValueError("lod-meta.json counts 无效")

    return {
        "entry_url": entry_url,
        "entry_bytes": entry_path.stat().st_size,
        "manifest": manifest,
        "counts": [int(c) for c in counts],
    }


def _find_scene_root(start: Path) -> Path | None:
    """Walk up *start* until we find a directory containing ``versions/``."""
    current = start.resolve()
    while current != current.parent:
        if (current / "versions").is_dir():
            return current
        current = current.parent
    return None