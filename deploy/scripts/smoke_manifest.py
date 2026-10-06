#!/usr/bin/env python3
"""smoke_manifest.py — stream.entryUrl parser for the post-deploy smoke gate.

The published-manifest contract is ``{"stream": {"entryUrl":
"versions/<ver>/lod-meta.json"}}`` (FIX-05C/06.1 §C).  The old smoke test read
``manifest.get("entryUrl")`` at the top level, which was always empty for
real published manifests — so the versioned-immutable and versioned-Range
checks silently never ran.

This one parser is shared by both callers:

  * bash smoke:  ``python3 deploy/scripts/smoke_manifest.py --manifest <file>``
    prints ``versions/<ver>`` (stdout) on success, exits 0; on any invalid
    manifest it prints a safe reason to stderr and exits 1 (the smoke gate
    then FAILs instead of skipping — FIX-06.1 §C).
  * pytest regression: import :func:`parse_entry_url` directly.

Validation rules (the contract, not guesswork):

  * manifest must be a JSON object with a ``stream`` object containing a
    string ``entryUrl``.
  * entryUrl must be exactly ``versions/<ver>/<file>`` (three segments, no
    leading/trailing slash).
  * ``<ver>`` must be non-empty and must not contain ``/``, ``..``, ``.`` —
    a version path is a content-addressed directory name, never ``current``
    (mutable) and never a traversal.
  * ``<file>`` must be non-empty, not ``.``/``..``, and must not contain ``/``.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def parse_entry_url(manifest: object) -> tuple[str, str]:
    """Return ``(version_path, entry_file)`` for a published manifest.

    Raises :class:`ValueError` with a safe, deployable message when the
    manifest does not match the ``{"stream": {"entryUrl":
    "versions/<ver>/<file>"}}`` contract.
    """
    if not isinstance(manifest, dict):
        raise ValueError("manifest 不是 JSON 对象")
    stream = manifest.get("stream")
    if not isinstance(stream, dict):
        raise ValueError("manifest.stream 缺失或不是对象")
    entry_url = stream.get("entryUrl")
    if not isinstance(entry_url, str) or not entry_url:
        raise ValueError("manifest.stream.entryUrl 缺失或为空")

    # Exactly versions/<ver>/<file>: three non-empty segments, anchored.
    parts = entry_url.split("/")
    if len(parts) != 3 or parts[0] != "versions":
        raise ValueError(
            f"stream.entryUrl 必须是 versions/<ver>/<file>，得到: {entry_url!r}"
        )
    version_id, filename = parts[1], parts[2]
    if not version_id or version_id in (".", ".."):
        raise ValueError(f"stream.entryUrl 版本号无效: {version_id!r}")
    if "/" in version_id or "\\" in version_id:
        raise ValueError(f"stream.entryUrl 版本号含路径分隔符: {version_id!r}")
    if not filename or filename in (".", "..") or "/" in filename or "\\" in filename:
        raise ValueError(f"stream.entryUrl 文件名无效: {filename!r}")
    if version_id == "current":
        raise ValueError("stream.entryUrl 不得指向可变的 current 目录")

    return f"versions/{version_id}", filename


def _main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--manifest",
        required=True,
        help="path to the published manifest.json (JSON object)",
    )
    args = parser.parse_args(argv)

    try:
        manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
        version_path, filename = parse_entry_url(manifest)
    except (ValueError, OSError) as exc:
        print(f"smoke_manifest: {exc}", file=sys.stderr)
        return 1

    print(version_path)
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
