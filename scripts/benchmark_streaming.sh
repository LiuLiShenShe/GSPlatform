#!/usr/bin/env bash
set -euo pipefail

# benchmark_streaming.sh — Local structural benchmark of a streamed-SOG scene.
#
# Usage:
#   ./scripts/benchmark_streaming.sh <scene-dir>/current/manifest.json
#
# Prints per-LOD counts, chunk sizes, total download volume, and estimated
# savings vs a full high-quality file. No origin server required.

manifest="$1"
[[ -f "$manifest" ]] || { echo "FAIL: manifest not found: $manifest" >&2; exit 1; }
base="$(cd "$(dirname "$manifest")" && pwd -P)"

# entryUrl is scene-root-relative; walk up until we find the `versions` dir.
scene_root="$base"
while [[ ! -d "$scene_root/versions" && "$scene_root" != "/" ]]; do
  scene_root="$(dirname "$scene_root")"
done
[[ -d "$scene_root/versions" ]] || { echo "FAIL: could not locate scene root" >&2; exit 1; }

python3 - "$manifest" "$scene_root" << 'PYEOF'
import json, os, sys

manifest_path, base = sys.argv[1], sys.argv[2]
with open(manifest_path, encoding="utf-8") as f:
    m = json.load(f)

scene_id = m.get("sceneId", "?")
asset_version = m.get("assetVersion", "?")
stream = m["stream"]
counts = stream["counts"]
total_gaussians = counts[-1]
lod_levels = stream["lodLevels"]
transport = stream["transport"]
entry_bytes = stream["byteLength"]

# Parse the upstream container to enumerate chunks.
entry_rel = stream["entryUrl"]
entry_full = os.path.join(base, entry_rel)
with open(entry_full, encoding="utf-8") as f:
    meta = json.load(f)

filenames = meta.get("filenames", [])
lod_chunks = {}  # lod -> [chunk_rel]
for name in filenames:
    lod = int(name.split("_")[0]) if name[0:1].isdigit() else -1
    lod_chunks.setdefault(lod, []).append(name)

# Walk each chunk unit to measure file sizes.
lod_sizes = {}       # lod -> total bytes of all webp + meta.json
total_chunk_bytes = 0
file_count = 0
for name in filenames:
    lod = int(name.split("_")[0]) if name[0:1].isdigit() else -1
    chunk_dir = os.path.join(base, os.path.dirname(entry_rel), name.replace("/meta.json", ""))
    if not os.path.isdir(chunk_dir):
        print(f"  WARN: missing chunk dir: {chunk_dir}")
        continue
    for fname in os.listdir(chunk_dir):
        fp = os.path.join(chunk_dir, fname)
        if os.path.isfile(fp):
            sz = os.path.getsize(fp)
            lod_sizes.setdefault(lod, 0)
            lod_sizes[lod] += sz
            total_chunk_bytes += sz
            file_count += 1

print(f"Scene:              {scene_id}")
print(f"Asset version:      {asset_version}")
print(f"Transport:          {transport}")
print(f"LOD levels:         {lod_levels}")
print(f"Counts:             {' / '.join(str(c) for c in counts)}")
print(f"Total gaussians:    {total_gaussians}")
print(f"Entry (lod-meta):   {entry_bytes:>10,} bytes")
print(f"Chunk units:        {len(filenames)}")
print(f"Chunk files:        {file_count}")
print(f"Total chunk bytes:  {total_chunk_bytes:>10,}")
print()
print("Per-LOD breakdown:")
for lod in sorted(lod_chunks.keys()):
    n_chunks = len(lod_chunks[lod])
    bytes_ = lod_sizes.get(lod, 0)
    cnt = counts[lod] if lod < len(counts) else 0
    print(f"  LOD {lod}:  gaussians={cnt:>8,}  chunks={n_chunks:>3}  bytes={bytes_:>10,}")
print()
print(f"Total download (all LODs): {total_chunk_bytes:>10,} bytes across {file_count} files")
print(f"  low  only (entry):       {entry_bytes:>10,} bytes (lowest latency to first frame)")
print(f"  low  chunks:             {lod_sizes.get(0, 0):>10,} bytes")
print(f"  high-only incremental:   {lod_sizes.get(2, 0):>10,} bytes (only fetched on demand)")
PYEOF
