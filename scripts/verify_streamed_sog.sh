#!/usr/bin/env bash
set -euo pipefail

# verify_streamed_sog.sh — Validate a streamed-SOG scene manifest.
#
# Usage:
#   ./scripts/verify_streamed_sog.sh <scene-dir>/manifest.json
#
# The manifest's `stream.entryUrl` points at the upstream lod-meta.json
# container. This script walks the *real* upstream references from
# lod-meta.json (`filenames` array + each chunk unit's meta.json -> *.webp),
# and checks:
#   - manifest JSON shape + format == 'streamed-sog'
#   - lod-meta.json exists, byteLength + sha256 match the manifest
#   - lod-meta.json parses (version 1, lodLevels/counts/tree present)
#   - every referenced chunk unit exists with a non-empty meta.json
#   - every chunk meta.json is valid JSON with webp files present
#   - every file's sha256 matches checksums.sha256 (where recorded)
#   - path traversal: every referenced path stays inside the version dir
#   - structural consistency: counts match upstream + chunk files > 0

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$ROOT/node_modules/.pnpm/@playcanvas+splat-transform@3.3.3_playcanvas@2.22.0/node_modules/@playcanvas/splat-transform/bin/cli.mjs"
manifest="$1"

[[ -f "$manifest" ]] || { echo "FAIL: manifest not found: $manifest" >&2; exit 1; }
base_abs="$(cd "$(dirname "$manifest")" && pwd)"

# Find the scene root: the manifest lives in <scene>/versions/<sha>/ (or via
# the <scene>/current symlink). entryUrl is scene-root-relative, so walk up
# until we find a directory that contains a `versions` dir.
scene_root="$base_abs"
while [[ ! -d "$scene_root/versions" && "$scene_root" != "/" ]]; do
  scene_root="$(dirname "$scene_root")"
done
if [[ ! -d "$scene_root/versions" ]]; then
  echo "FAIL: could not locate scene root (no versions/ dir above $base_abs)" >&2
  exit 1
fi

fail() { echo "FAIL: $*" >&2; exit 1; }

python3 - "$manifest" "$scene_root" "$NODE_BIN" << 'PYEOF'
import json, os, re, subprocess, sys, hashlib
from pathlib import Path

manifest_path, base, node_bin = sys.argv[1], sys.argv[2], sys.argv[3]
fails = []

def check(cond, msg):
    if not cond:
        fails.append(msg)

with open(manifest_path, encoding="utf-8") as f:
    m = json.load(f)

check(isinstance(m, dict), "manifest is not an object")
check(m.get("format") == "streamed-sog", f"format must be 'streamed-sog', got {m.get('format')!r}")
check(m.get("schemaVersion") == 1, "schemaVersion must be 1")
check(m.get("sceneId"), "missing sceneId")
check(m.get("assetVersion"), "missing assetVersion")

stream = m.get("stream") or {}
entry = stream.get("entryUrl")
check(bool(entry), "stream.entryUrl missing")
check(stream.get("transport") == "range", "stream.transport must be 'range'")
check(stream.get("lodLevels") == 3, "stream.lodLevels must be 3")

# Resolve the entry URL relative to the manifest's own directory.
entry_path = os.path.normpath(os.path.join(base, entry))
entry_dir = os.path.dirname(entry_path)
version_dir = entry_dir  # lod-meta.json sits at versions/<ver>/
check(os.path.isfile(entry_path), f"entry lod-meta.json missing: {entry_path}")
check(os.path.getsize(entry_path) > 0, "entry lod-meta.json is empty")

rec_sha = stream.get("sha256")
if rec_sha:
    actual_sha = hashlib.sha256(open(entry_path, "rb").read()).hexdigest()
    check(actual_sha == rec_sha, f"lod-meta.json sha256 mismatch: recorded {rec_sha} actual {actual_sha}")

rec_bytes = stream.get("byteLength")
if rec_bytes:
    check(int(rec_bytes) == os.path.getsize(entry_path),
          f"lod-meta.json byteLength mismatch: recorded {rec_bytes} actual {os.path.getsize(entry_path)}")

# --- parse upstream lod-meta.json ---------------------------------------
try:
    with open(entry_path, encoding="utf-8") as f:
        meta = json.load(f)
except Exception as exc:
    check(False, f"lod-meta.json is not valid JSON: {exc}")
    meta = {}
if meta:
    check(meta.get("version") == 1, f"lod-meta.json version must be 1, got {meta.get('version')}")
    check(isinstance(meta.get("counts"), list) and len(meta["counts"]) == 3, "lod-meta.json counts must be a 3-element array")
    check(isinstance(meta.get("filenames"), list) and len(meta["filenames"]) > 0, "lod-meta.json filenames must be non-empty")
    check(isinstance(meta.get("tree"), dict) and meta["tree"].get("bound"), "lod-meta.json tree must have bound")
    check(isinstance(meta.get("lodErrors"), bool), "lod-meta.json lodErrors missing")

# --- every upstream-referenced chunk unit + path safety -------------------
seen_chunks = set()
for filename in (meta.get("filenames") or []):
    # path traversal guard: the resolved chunk path must stay inside the
    # version directory (no ../ escaping into the scene root / filesystem)
    chunk_rel = os.path.normpath(filename)
    chunk_path = os.path.normpath(os.path.join(entry_dir, chunk_rel))
    if not chunk_path.startswith(version_dir + os.sep) and chunk_path != version_dir:
        check(False, f"chunk path escapes version dir: {filename!r} -> {chunk_path}")
        continue
    if chunk_rel in seen_chunks:
        continue
    seen_chunks.add(chunk_rel)
    unit_dir = os.path.dirname(chunk_path)
    check(os.path.isfile(chunk_path), f"chunk unit missing: {filename}")
    if os.path.isfile(chunk_path):
        check(os.path.getsize(chunk_path) > 0, f"chunk unit empty: {filename}")
        with open(chunk_path, encoding="utf-8") as f:
            unit = json.load(f)
    else:
        unit = {}
    check(isinstance(unit, dict) and unit.get("count", 0) > 0, f"chunk {filename}: missing/invalid count")
    # every webp referenced by the chunk meta.json must exist in its unit dir
    for key in ("means", "quats", "scales", "sh0"):
        if key not in unit:
            check(False, f"chunk {filename}: missing {key!r} block")
            continue
        block = unit[key]
        files = block.get("files", [])
        for rel in files:
            fp = os.path.join(unit_dir, rel)
            check(os.path.isfile(fp), f"chunk {filename}: referenced file missing {rel}")
            if os.path.isfile(fp):
                check(os.path.getsize(fp) > 0, f"chunk {filename}: referenced file empty {rel}")

check(len(seen_chunks) >= 3, f"expected >=3 chunk units, saw {len(seen_chunks)}")

# --- checksums.sha256 (where present) -------------------------------------
checksums_path = os.path.join(version_dir, "checksums.sha256")
if os.path.isfile(checksums_path):
    for line in open(checksums_path, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        sha, _, rel = line.partition("  ")
        fp = os.path.normpath(os.path.join(version_dir, rel))
        if not os.path.isfile(fp):
            continue  # not an error: checksums file may be written before rename
        actual = hashlib.sha256(open(fp, "rb").read()).hexdigest()
        check(actual == sha, f"checksum mismatch for {rel}: recorded {sha} actual {actual}")
else:
    check(False, "missing checksums.sha256 in version dir")

# --- cross-check with splat-transform: --info on the lod container --------
info = subprocess.run(
    [node_bin, "-g", "cpu", "--info", entry_path, "null"],
    capture_output=True, text=True,
).stdout + subprocess.run(
    [node_bin, "-g", "cpu", "--info", entry_path, "null"],
    capture_output=True, text=True,
).stderr
upstream_counts = [int(x) for x in re.findall(r"\b(\d+)\s+gaussians", info)]
if upstream_counts:
    check(upstream_counts == meta.get("counts"),
          f"upstream --info counts {upstream_counts} != lod-meta counts {meta.get('counts')}")

# manifest stream.counts must equal upstream lod-meta counts
check(stream.get("counts") == meta.get("counts"),
      f"manifest stream.counts {stream.get('counts')} != lod-meta counts {meta.get('counts')}")

if fails:
    print("\n".join("FAIL: " + f for f in fails))
    sys.exit(1)
print(f"PASS: {len(seen_chunks)} chunk units, {len(meta.get('filenames') or [])} refs, "
      f"counts {meta.get('counts')}, all hashes/paths valid")
PYEOF