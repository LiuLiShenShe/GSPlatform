#!/usr/bin/env bash
# verify_published_scene.sh — Verify a published streamed-SOG scene directory.
# Usage: ./scripts/verify_published_scene.sh <scene-dir>/versions/<asset-version>
#
# Checks: manifest.json, lod-meta.json integrity, entry URL, poster.
set -euo pipefail

VERSION_DIR="${1:?Usage: $0 <version_dir>}"
ROOT="$(cd "$(dirname "$0")"/.. && pwd)"

[[ -d "$VERSION_DIR" ]] || { echo "FAIL: not a directory: $VERSION_DIR" >&2; exit 1; }
[[ -f "$VERSION_DIR/manifest.json" ]] || { echo "FAIL: manifest.json missing" >&2; exit 1; }
[[ -f "$VERSION_DIR/lod-meta.json" ]] || { echo "FAIL: lod-meta.json missing" >&2; exit 1; }

python3 - "$VERSION_DIR" << 'PYEOF'
import json, sys, os
from pathlib import Path
vdir = Path(sys.argv[1])

manifest = json.loads((vdir / "manifest.json").read_text())
assert manifest["schemaVersion"] == 1, "schemaVersion != 1"
assert manifest["format"] == "streamed-sog", f"format: {manifest['format']}"

stream = manifest.get("stream", {})
entry_url = stream.get("entryUrl", "")
assert entry_url, "stream.entryUrl missing"

# Resolve entry_url relative to scene root
scene_root = vdir
while scene_root != Path("/") and not (scene_root / "versions").is_dir():
    scene_root = scene_root.parent
entry_path = (scene_root / entry_url).resolve()
assert entry_path.exists(), f"entryUrl resolves to nonexistent: {entry_url}"
assert entry_path.stat().st_size == stream.get("byteLength", 0), "byteLength mismatch"

lod = json.loads(entry_path.read_text())
counts = lod.get("counts", [])
assert counts and all(c > 0 for c in counts), f"invalid counts: {counts}"
print(f"PASS: manifest OK, counts={counts}, entry_bytes={stream['byteLength']}")

poster = manifest.get("poster")
if poster and poster.get("url"):
    poster_path = (scene_root / poster["url"]).resolve()
    assert poster_path.exists(), f"poster missing: {poster['url']}"
    print(f"  poster: {poster_path.stat().st_size} bytes")
PYEOF

echo "PASS: $VERSION_DIR verified."
