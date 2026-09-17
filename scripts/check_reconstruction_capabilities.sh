#!/usr/bin/env bash
# check_reconstruction_capabilities.sh — Verify the Phase 07 reconstruction
# toolchain is installed and usable (ffmpeg/ffprobe/colmap/gsplat/splat-transform).
#
# Usage: ./scripts/check_reconstruction_capabilities.sh [--verbose]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERBOSE=0
[[ "${1:-}" == "--verbose" ]] && VERBOSE=1

fail=0

echo "== GSPlatform Phase 07 — reconstruction capabilities check =="

# ── system tools ──────────────────────────────────────────────────────────────
for tool in ffmpeg ffprobe colmap; do
    if command -v "$tool" >/dev/null 2>&1; then
        # colmap does not support -version; use -h which prints the banner.
        if [[ "$tool" == "colmap" ]]; then
            ver=$("$tool" -h 2>/dev/null | head -1 || true)
        else
            ver=$("$tool" -version 2>/dev/null | head -1 || true)
        fi
        echo "  [OK]   $tool: ${ver:-present}"
    else
        echo "  [MISS] $tool not found on PATH"
        fail=1
    fi
done

# ── python package env (venv) ─────────────────────────────────────────────────
VENV_PY=
if [[ -x "$ROOT/apps/api/.venv/bin/python" ]]; then
    VENV_PY="$ROOT/apps/api/.venv/bin/python"
    echo "  [OK]   venv python: $VENV_PY"
else
    py=$(command -v python3 || echo python)
    echo "  [WARN] apps/api/.venv not found; using system python ($py)"
    VENV_PY="$py"
fi

"$VENV_PY" - << 'PYEOF'
import importlib, sys, warnings
warnings.filterwarnings("ignore")

ok = True
def check(name):
    global ok
    try:
        mod = importlib.import_module(name)
        ver = getattr(mod, "__version__", "?" if "__version__" in vars(mod) else "present")
        print(f"  [OK]   {name}: {ver}")
    except Exception as exc:
        ok = False
        print(f"  [MISS] {name}: {exc}")

check("torch")
if "torch" in sys.modules:
    import torch
    print(f"         torch.cuda.is_available() = {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"         device = {torch.cuda.get_device_name(0)}")
check("gsplat")
check("numpy")

sys.exit(0 if ok else 1)
PYEOF
[[ $? -eq 0 ]] || fail=1

# ── splat-transform CLI (pinned node_modules path) ────────────────────────────
CLI="$(find "$ROOT/node_modules/.pnpm" -maxdepth 12 -path '*splat-transform*/bin/cli.mjs' 2>/dev/null | head -1 || true)"
if [[ -n "$CLI" ]]; then
    echo "  [OK]   splat-transform CLI: $CLI"
    if [[ -x "$ROOT/apps/api/.venv/bin/node" ]] || command -v node >/dev/null 2>&1; then
        node "$CLI" --version 2>&1 | head -1 | sed 's/^/         version: /'
    fi
else
    echo "  [MISS] splat-transform CLI not found under node_modules/.pnpm"
    fail=1
fi

# ── GPU ───────────────────────────────────────────────────────────────────────
if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader 2>/dev/null | \
        while IFS="," read -r name total free; do
            echo "  [GPU]  $name | total ${total} | free ${free}"
        done
else
    echo "  [WARN] nvidia-smi not found — GPU training unavailable"
fi

if [[ $fail -eq 0 ]]; then
    echo "== RESULT: PASS =="
else
    echo "== RESULT: FAIL (missing tools above) ==" >&2
fi
exit "$fail"