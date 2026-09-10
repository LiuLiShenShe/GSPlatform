#!/usr/bin/env bash
set -euo pipefail

# build_preview_lods.sh — Generate low / medium / high LOD SOGs and manifest.
#
# Usage:
#   ./scripts/build_preview_lods.sh [--input <source.ply>] [--out-dir <dir>]
#
# Without --input a synthetic PLY is generated via generate_synthetic_scene.py.
# Requires: splat-transform (via pnpm node_modules), sha256sum, python3.
#
# Output directory structure:
#   <out-dir>/low.sog
#   <out-dir>/medium.sog
#   <out-dir>/high.sog
#   <out-dir>/poster.webp        (optional, GPU-dependent)
#   <out-dir>/manifest.json

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$ROOT/node_modules/.pnpm/@playcanvas+splat-transform@3.3.3_playcanvas@2.22.0/node_modules/@playcanvas/splat-transform/bin/cli.mjs"

INPUT=""
OUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input) INPUT="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

OUT_DIR="${OUT_DIR:-$ROOT/scenes/progressive-test}"
mkdir -p "$OUT_DIR"

# --- Generate source PLY if not provided ---
if [[ -z "$INPUT" ]]; then
  INPUT="$OUT_DIR/source.ply"
  echo ">>> Generating synthetic scene (20k gaussians)..."
  python3 "$ROOT/scripts/generate_synthetic_scene.py" --seed 7 --count 20000 --out "$INPUT"
fi

# --- Helper: decimate PLY then convert to SOG ---
lod_sog() {
  local pct="$1" label="$2" out_sog="$3"
  local tmp_ply="$OUT_DIR/_${label}.ply"

  echo ">>> [$label] Decimating to ${pct} -> $tmp_ply ..."
  node "$NODE_BIN" -g cpu "$INPUT" -d "${pct}%" "$tmp_ply" -w --tty 2>&1 | tail -3

  echo ">>> [$label] Converting to SOG -> $out_sog ..."
  node "$NODE_BIN" -g cpu "$tmp_ply" "$out_sog" -w --tty 2>&1 | tail -3

  rm -f "$tmp_ply"

  local n size sha
  n=$(node "$NODE_BIN" -g cpu --info "$out_sog" null 2>&1 \
      | sed -n 's/.*· \([0-9.]*[KkM]*\) gaussians.*/\1/p' | head -1)
  # Normalize suffixes: 20.8K -> 20800, 1.2M -> 1200000
  n=$(python3 -c "import sys; s=sys.stdin.read().strip().lower();
print(int(float(s[:-1])*1000) if s.endswith('k') else (int(float(s[:-1])*1000000) if s.endswith('m') else int(s)))" <<< "$n")
  size=$(stat -c%s "$out_sog")
  sha=$(sha256sum "$out_sog" | cut -d' ' -f1)
  echo "$label  gaussians=$n  size=$size  sha=$sha"
  # Write temp metadata for manifest step
  echo "${label}|${n}|${size}|${sha}" >> "$OUT_DIR/_meta.txt"
}

rm -f "$OUT_DIR/_meta.txt"

# --- Build LOD tiers ---
lod_sog  10 "low"    "$OUT_DIR/low.sog"
lod_sog  35 "medium" "$OUT_DIR/medium.sog"
lod_sog 100 "high"   "$OUT_DIR/high.sog"

# --- Poster (best-effort; requires GPU rasterization, bounded by timeout) ---
echo ">>> Rendering poster.webp (best-effort, GPU-dependent, 60s timeout)..."
if timeout 60 node "$NODE_BIN" -g 0 "$INPUT" "$OUT_DIR/poster.webp" --tty 2>&1 | tail -2; then
  echo ">>> poster.webp rendered OK"
else
  echo ">>> poster.webp render failed or unavailable (will use fallback gradient)"
  rm -f "$OUT_DIR/poster.webp"
fi

# --- Compute source stats ---
src_size=$(stat -c%s "$INPUT")
src_sha=$(sha256sum "$INPUT" | cut -d' ' -f1)

# --- Generate manifest.json ---
python3 - "$OUT_DIR" "$src_sha" "$src_size" < "$OUT_DIR/_meta.txt" << 'PYEOF'
import json, sys, pathlib

out_dir = pathlib.Path(sys.argv[1])
src_sha = sys.argv[2]
src_size = sys.argv[3]

meta = {}
for line in open(out_dir / "_meta.txt"):
    label, n, size, sha = line.strip().split("|")
    meta[label] = {"gaussians": int(n), "size": int(size), "sha256": sha}

# Poster relative URL (may not exist)
poster_rel = "poster.webp" if (out_dir / "poster.webp").exists() else None

manifest = {
    "id": "progressive-test",
    "title": "渐进加载测试场景",
    "format": "sog",
    "sha256": src_sha,
    "sourceSize": int(src_size),
    "sourceGaussians": meta["high"]["gaussians"],
    "lod": [
        {
            "level": "low",
            "assetUrl": "low.sog",
            "gaussians": meta["low"]["gaussians"],
            "size": meta["low"]["size"],
            "sha256": meta["low"]["sha256"],
        },
        {
            "level": "medium",
            "assetUrl": "medium.sog",
            "gaussians": meta["medium"]["gaussians"],
            "size": meta["medium"]["size"],
            "sha256": meta["medium"]["sha256"],
        },
        {
            "level": "high",
            "assetUrl": "high.sog",
            "gaussians": meta["high"]["gaussians"],
            "size": meta["high"]["size"],
            "sha256": meta["high"]["sha256"],
        },
    ],
    "poster": {
        "url": poster_rel,
        "placeholderColor": "#1a2a3a",
    },
    "camera": {
        "position": [0, 1.2, 3.5],
        "target": [0, 0.8, 0],
        "fov": 55,
    },
}

with open(out_dir / "manifest.json", "w") as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)
    f.write("\n")

print(f"manifest.json written ({len(manifest['lod'])} LOD tiers)")
PYEOF

rm -f "$OUT_DIR/_meta.txt"
echo ">>> Done. Output in $OUT_DIR"
ls -lh "$OUT_DIR"
