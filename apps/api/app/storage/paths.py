"""Secure path resolution — every storage key must pass through this module.

The golden rule: the resolved absolute path must be a strict descendant of
the configured root and must not escape via ``..``, symlinks, or absolute
injection. Any violation raises ``ValueError`` so callers can return 400/403
instead of creating or writing an unintended file.
"""

from __future__ import annotations

from pathlib import Path


def resolve_within(root: str | Path, rel_key: str) -> Path:
    """Return the resolved absolute path for *rel_key* under *root*.

    Raises ``ValueError`` if:
    - *rel_key* is an absolute path
    - *rel_key* contains a ``..`` component
    - the resolved path escapes *root* after symlink resolution

    The returned path is **not** required to already exist.
    """
    root_resolved = Path(root).resolve()
    key = str(rel_key)

    # 1. Reject absolute injection.
    if Path(key).is_absolute():
        raise ValueError(f"绝对路径不允许: {key!r}")

    # 2. Reject path traversal.
    parts = Path(key).parts
    if ".." in parts:
        raise ValueError(f"路径不允许包含 '..': {key!r}")

    candidate = (root_resolved / key).resolve()

    # 3. Ensure the resolved path is within the root.
    try:
        candidate.relative_to(root_resolved)
    except ValueError:
        raise ValueError(
            f"路径逃逸根目录: key={key!r}  resolved={candidate!r}  root={root_resolved!r}"
        ) from None

    return candidate
