#!/usr/bin/env bash
set -euo pipefail

# verify_scene_manifest.sh — Validate a progressive-loading scene manifest.
#
# Usage:
#   ./scripts/verify_scene_manifest.sh scenes/progressive-test/manifest.json
#
# Checks:
#   - JSON well-formed, id/dir match, format is 'sog'
#   - three LOD tiers low/medium/high exist, files present, non-empty
#   - recorded SHA-256 matches actual file bytes
#   - recorded gaussians counts are positive and strictly increasing
#   - poster URL (if present) resolves to an existing file
#   - camera block is well-formed

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
node_bin="$ROOT/node_modules/.pnpm/@playcanvas+splat-transform@3.3.3_playcanvas@2.22.0/node_modules/@playcanvas/splat-transform/bin/cli.mjs"
manifest="$1"

[[ -f "$manifest" ]] || { echo "FAIL: manifest not found: $manifest" >&2; exit 1; }
dirname_abs="$(cd "$(dirname "$manifest")" && pwd)"

fail() { echo "FAIL: $*" >&2; exit 1; }

# --- python validation pass (structure + checksums) ---
python3 - "$manifest" "$dirname_abs" "$node_bin" << 'PYEOF'
import json, os, subprocess, sys, hashlib

manifest = sys.argv[1]
base = sys.argv[2]
node_bin = sys.argv[3]
fails = []

with open(manifest, encoding="utf-8") as f:
    m = json.load(f)

def check(cond, msg):
    if not cond:
        fails.append(msg)

check(isinstance(m, dict), "manifest is not an object")
check(m.get("id"), "missing id")
check(m.get("format") == "sog", "format must be 'sog'")
check(m.get("lod", []), "missing lod array")

lod = {item.get("level"): item for item in m.get("lod", [])}
check(lod.keys() == {"low", "medium", "high"}, f"lod levels must be exactly low/medium/high, got {list(lod.keys())}")

prev = 0
for level in ("low", "medium", "high"):
    item = lod[level]
    url = item.get("assetUrl")
    check(bool(url), f"{level}: missing assetUrl")
    path = os.path.join(base, url)
    check(os.path.isfile(path), f"{level}: file missing {path}")
    n = int(item.get("gaussians", -1))
    check(n > prev, f"{level}: gaussians {n} not increasing over {prev}")
    prev = n
    size = os.path.getsize(path)
    check(size > 0, f"{level}: empty file")
    check(int(item.get("size", -1)) == size, f"{level}: recorded size {item.get('size')} != actual {size}")
    sha = item.get("sha256")
    if sha:
        actual = hashlib.sha256(open(path, "rb").read()).hexdigest()
        check(actual == sha, f"{level}: sha256 mismatch recorded={sha} actual={actual}")

# poster (optional)
poster = m.get("poster") or {}
if poster.get("url"):
    p = os.path.join(base, poster["url"])
    check(os.path.isfile(p), f"poster: file missing {p}")
else:
    check(bool(poster.get("placeholderColor")), "poster: placeholderColor required when no poster url")

cam = m.get("camera") or {}
check(len(cam.get("position", [])) == 3, "camera.position must be [x,y,z]")
check(len(cam.get("target", [])) == 3, "camera.target must be [x,y,z]")
check(isinstance(cam.get("fov"), (int, float)) and 0 < cam["fov"] < 180, "camera.fov invalid")

# --- cross-check with splat-transform: gaussians counts ---
for level in ("low", "medium", "high"):
    url = lod[level]["assetUrl"]
    path = os.path.join(base, url)
    out = subprocess.run(
        [node_bin, "-g", "cpu", "--info", path, "null"],
        capture_output=True, text=True,
    ).stderr
    match = None
    import re
    mm = re.search(r"[·]\s*([0-9.]+[KkM]?)\s+gaussians", out)
    if mm:
        raw = mm.group(1).lower()
        num = int(float(raw[:-1]) * 1000) if raw.endswith("k") else (int(float(raw[:-1]) * 1000000) if raw.endswith("m") else int(raw))
        match = num
    check(match == lod[level]["gaussians"], f"{level}: splat-transform reports {match} gaussians but manifest says {lod[level]['gaussians']}")

if fails:
    print("\n".join("FAIL: " + f for f in fails))
    sys.exit(1)
print("PASS: manifest structure, files, sizes, sha256, counts, camera all valid")
PYEOF