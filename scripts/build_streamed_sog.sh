#!/usr/bin/env bash
set -euo pipefail

# build_streamed_sog.sh — Build a true upstream Streamed SOG scene.
#
# Two-stage build using the locked splat-transform CLI (v3.3.3):
#   1) decimate the normalized source PLY into low/medium/high PLYs
#   2) stack them with --tag-lod into a lod-meta.json streamed container
#      (spatial tree + {lod}_{chunk}/ units; each unit = meta.json + WebPs)
#
# Output layout (publish-safe):
#   <scene-dir>/versions/<asset-version>/
#       lod-meta.json   upstream streamed-SOG index container
#       0_0/, 0_1/, …   LOD chunk units
#       manifest.json   business manifest (schemaVersion 1)
#       build-info.json tool version + exact CLI args
#       checksums.sha256
#   <scene-dir>/current -> versions/<asset-version>
#
# The whole build happens in a staging dir under <scene-dir> and is renamed
# into place only after every step succeeds, so a failed build never leaves a
# half-written version that the publisher could mistake for a complete asset.
#
# Usage:
#   ./scripts/build_streamed_sog.sh --input <source.ply> --scene-dir <dir> [--profile <balanced|eco|quality>]
#
# Profiles (chunk granularity):
#   balanced  --lod-chunk-count 4 --lod-chunk-extent 8   (default)
#   eco       --lod-chunk-count 8 --lod-chunk-extent 16
#   quality   --lod-chunk-count 2 --lod-chunk-extent 4
#
# Requires: splat-transform (locked @playcanvas/splat-transform@3.3.3),
#           python3, sha256sum.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$ROOT/node_modules/.pnpm/@playcanvas+splat-transform@3.3.3_playcanvas@2.22.0/node_modules/@playcanvas/splat-transform/bin/cli.mjs"

INPUT=""
SCENE_DIR=""
PROFILE="balanced"
GPU="cpu"

usage() {
  sed -n '/^# Usage:/,/^$/s/^# //p' "$0"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input)     INPUT="$2";     shift 2 ;;
    --scene-dir) SCENE_DIR="$2"; shift 2 ;;
    --profile)   PROFILE="$2";   shift 2 ;;
    --gpu)       GPU="$2";       shift 2 ;;
    --help|-h)   usage ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

[[ -n "$INPUT" && -n "$SCENE_DIR" ]] || { echo "ERROR: --input and --scene-dir are required" >&2; usage; }
[[ -f "$INPUT" ]] || { echo "ERROR: input file not found: $INPUT" >&2; exit 1; }
[[ -f "$NODE_BIN" ]] || { echo "ERROR: splat-transform CLI not found at $NODE_BIN" >&2; exit 1; }

# --- Validate locked version ------------------------------------------------
TOOL_VERSION=$(node "$NODE_BIN" --version 2>&1 | head -1 | grep -o 'v[0-9.]*' | tr -d 'v' || true)
if [[ "$TOOL_VERSION" != "3.3.3" ]]; then
  echo "FATAL: splat-transform version mismatch: expected 3.3.3, got '$TOOL_VERSION'" >&2
  exit 1
fi
echo "splat-transform $TOOL_VERSION (locked)  GPU=$GPU  profile=$PROFILE"

# --- Profile parameters -----------------------------------------------------
case "$PROFILE" in
  balanced) CHUNK_COUNT=4; CHUNK_EXTENT=8  ;;
  eco)      CHUNK_COUNT=8; CHUNK_EXTENT=16 ;;
  quality)  CHUNK_COUNT=2; CHUNK_EXTENT=4  ;;
  *) echo "ERROR: unknown profile '$PROFILE'" >&2; exit 1 ;;
esac

# --- Staging dir ------------------------------------------------------------
mkdir -p "$SCENE_DIR"
STAGING="$SCENE_DIR/.staging-$(date +%s)-$$"
# Decimation workspace lives OUTSIDE the publish staging dir: the staged tree
# is moved verbatim into versions/<sha>/ on success, so it must contain only
# publishable files. The PLY workspace is cleaned at exit.
WORKDIR="$(mktemp -d)"
mkdir -p "$STAGING"
cleanup() {
  rm -rf "$STAGING"
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

# --- Stage 1: decimate into LOD PLYs ---------------------------------------
echo ">>> [1/4] Decimating LOD tiers..."
node "$NODE_BIN" -g "$GPU" "$INPUT" --decimate 10%  "$WORKDIR/low.ply"  --overwrite --tty 2>&1 | tail -1
node "$NODE_BIN" -g "$GPU" "$INPUT" --decimate 30%  "$WORKDIR/med.ply"  --overwrite --tty 2>&1 | tail -1
node "$NODE_BIN" -g "$GPU" "$INPUT" --decimate 100% "$WORKDIR/high.ply" --overwrite --tty 2>&1 | tail -1

# --- Stage 2: stack into streamed-SOG container -----------------------------
echo ">>> [2/4] Stacking into lod-meta.json (chunk-count=$CHUNK_COUNT, extent=$CHUNK_EXTENT)..."
node "$NODE_BIN" -g "$GPU" \
  "$WORKDIR/low.ply"  --tag-lod 0 \
  "$WORKDIR/med.ply"  --tag-lod 1 \
  "$WORKDIR/high.ply" --tag-lod 2 \
  "$STAGING/lod-meta.json" \
  --lod-chunk-count "$CHUNK_COUNT" \
  --lod-chunk-extent "$CHUNK_EXTENT" \
  --overwrite --tty 2>&1 | tail -2

# --- Stage 3: poster (best-effort, GPU-only, bounded) -----------------------
echo ">>> [3/4] Rendering poster.webp (best-effort, 90s timeout)..."
POSTER="$STAGING/poster.webp"
if timeout 90 node "$NODE_BIN" -g 0 "$INPUT" "$POSTER" --tty 2>&1 | tail -1; then
  echo "  poster.webp OK"
else
  echo "  poster render failed/unavailable — manifest will omit poster URL"
  rm -f "$POSTER"
fi

# --- Stage 4: metadata + atomic publish -------------------------------------
echo ">>> [4/4] Writing manifest / checksums / build-info ..."

# gaussian counts per LOD: read the authoritative values from the upstream
# lod-meta.json container (the decimated PLY --info output rounds, e.g. 2376
# -> "2.38K"); the container's `counts` is what the loader actually uses.
COUNT_LOW=$(python3 -c "import json;print(json.load(open('$STAGING/lod-meta.json'))['counts'][0])")
COUNT_MED=$(python3 -c "import json;print(json.load(open('$STAGING/lod-meta.json'))['counts'][1])")
COUNT_HIGH=$(python3 -c "import json;print(json.load(open('$STAGING/lod-meta.json'))['counts'][2])")
echo "  counts: low=$COUNT_LOW  medium=$COUNT_MED  high=$COUNT_HIGH"

ASSET_SHA256=$(sha256sum "$STAGING/lod-meta.json" | cut -d' ' -f1)
ASSET_VERSION="${ASSET_SHA256:0:12}"
ENTRY_BYTES=$(stat -c%s "$STAGING/lod-meta.json")

# checksums.sha256 for every file under the version dir (excluding itself)
(cd "$STAGING" && find . -type f ! -name checksums.sha256 -print0 \
  | sort -z | xargs -0 sha256sum > checksums.sha256)

# build-info.json — exact tool version + args for reproducibility
SRC_SHA256=$(sha256sum "$INPUT" | cut -d' ' -f1)
cat > "$STAGING/build-info.json" <<EOF
{
  "tool": "splat-transform",
  "toolVersion": "$TOOL_VERSION",
  "sourceFile": "$(basename "$INPUT")",
  "sourceSha256": "$SRC_SHA256",
  "profile": "$PROFILE",
  "lodChunkCount": $CHUNK_COUNT,
  "lodChunkExtent": $CHUNK_EXTENT,
  "lodLevels": 3,
  "counts": [$COUNT_LOW, $COUNT_MED, $COUNT_HIGH],
  "gpu": "$GPU",
  "buildTime": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# manifest.json — business metadata only; entryUrl points at the upstream
# lod-meta.json container (all paths relative to the scene dir so the dev
# origin /local-scenes/<sceneId>/ and prod origin both resolve them).
POSTER_URL="versions/$ASSET_VERSION/poster.webp"
[[ -f "$POSTER" ]] || POSTER_URL=""
python3 - "$STAGING/manifest.json" "$ASSET_VERSION" "$ENTRY_BYTES" "$ASSET_SHA256" \
  "$COUNT_LOW" "$COUNT_MED" "$COUNT_HIGH" "$POSTER_URL" << 'PYEOF'
import json, sys

path, ver, bytes_, sha, lo, med, hi, poster = sys.argv[1:]
manifest = {
    "schemaVersion": 1,
    "sceneId": "",
    "assetVersion": ver,
    "format": "streamed-sog",
    "stream": {
        "entryUrl": f"versions/{ver}/lod-meta.json",
        "byteLength": int(bytes_),
        "sha256": sha,
        "transport": "range",
        "lodLevels": 3,
        "counts": [int(lo), int(med), int(hi)]
    },
    "poster": {"url": poster, "width": 1600, "height": 900} if poster else None,
    "camera": {
        "position": [0, 1.2, 3.5],
        "target": [0, 0.8, 0],
        "fov": 55
    }
}
with open(path, "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)
    f.write("\n")
PYEOF
python3 - "$STAGING/manifest.json" "$(basename "$SCENE_DIR")" << 'PYEOF'
import json, sys
path, scene_id = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    m = json.load(f)
m["sceneId"] = scene_id
with open(path, "w", encoding="utf-8") as f:
    json.dump(m, f, indent=2, ensure_ascii=False)
    f.write("\n")
PYEOF

# --- Atomic publish ---------------------------------------------------------
VERSION_DIR="$SCENE_DIR/versions/$ASSET_VERSION"
mkdir -p "$(dirname "$VERSION_DIR")"
mv "$STAGING" "$VERSION_DIR"
ln -sfn "versions/$ASSET_VERSION" "$SCENE_DIR/current"

# Release the staging trap now that the dir has been renamed away
trap - EXIT

echo ">>> Build complete."
echo "    version: $ASSET_VERSION"
echo "    dir:     $VERSION_DIR"
echo "    current: $SCENE_DIR/current -> $VERSION_DIR"
echo "    entry:   versions/$ASSET_VERSION/lod-meta.json ($ENTRY_BYTES bytes, sha256 $ASSET_SHA256)"
