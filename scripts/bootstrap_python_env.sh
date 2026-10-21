#!/usr/bin/env bash
# bootstrap_python_env.sh — build apps/api/.venv with uv (no conda).
#
# The project's Python dependencies are managed by uv:
#   * apps/api/pyproject.toml  — declared runtime + dev dependencies
#   * apps/api/uv.lock         — exact, reproducible resolution
#
# This script never touches conda: `[tool.uv] python-preference = "only-managed"`
# plus an explicit `--python 3.11` force the venv onto a uv-managed CPython,
# even when conda is on PATH.
#
# Usage:
#   scripts/bootstrap_python_env.sh                # API + dev tools
#   scripts/bootstrap_python_env.sh --with-recon   # + torch/gsplat (extra "recon")
#   scripts/bootstrap_python_env.sh --locked       # fail if uv.lock is stale
#
# Environment:
#   UV_BIN                 — uv executable (default: uv from PATH)
#   GS_PYTHON_VERSION      — interpreter for the venv (default: 3.11)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_DIR="$ROOT/apps/api"
UV_BIN="${UV_BIN:-uv}"
PY_VERSION="${GS_PYTHON_VERSION:-3.11}"

WITH_RECON=0
LOCKED=0
for arg in "$@"; do
    case "$arg" in
        --with-recon) WITH_RECON=1 ;;
        --locked)     LOCKED=1 ;;
        *) echo "Unknown option: $arg" >&2; exit 2 ;;
    esac
done

if ! command -v "$UV_BIN" >/dev/null 2>&1; then
    echo "ERROR: uv not found (UV_BIN=$UV_BIN)." >&2
    echo "       Install uv from https://docs.astral.sh/uv/ (a standalone binary;" >&2
    echo "       conda is not required and is not supported by this project)." >&2
    exit 1
fi

echo ">>> uv $("$UV_BIN" --version)"
cd "$API_DIR"

sync_args=(sync --extra dev --python "$PY_VERSION")
if [[ "$WITH_RECON" == "1" ]]; then
    # The `recon` extra holds the same verified pins as
    # deploy/requirements-reconstruction.txt (torch 2.14.0+cu126 / gsplat
    # 1.5.3). torch resolves from PyTorch's cu126 index via tool.uv.sources.
    sync_args+=(--extra recon)
fi
if [[ "$LOCKED" == "1" ]]; then
    sync_args+=(--locked)
fi
"$UV_BIN" "${sync_args[@]}"

PY="$API_DIR/.venv/bin/python"
echo ""
echo ">>> interpreter: $(readlink -f "$PY")"
"$PY" - <<'PY'
import sys
print(f"    python  {sys.version.split()[0]}  ({sys.prefix})")
try:
    import fastapi, sqlalchemy  # noqa: F401
    print("    api     fastapi + sqlalchemy import OK")
except Exception as exc:  # pragma: no cover - diagnostic only
    print(f"    api     IMPORT FAILED: {exc}")
try:
    import torch, gsplat  # noqa: F401
    print(f"    recon   torch {torch.__version__} / gsplat {gsplat.__version__} / cuda={torch.cuda.is_available()}")
except Exception:
    print("    recon   not installed (run with --with-recon for the GPU worker)")
PY

echo ">>> done. Run the API with: apps/api/.venv/bin/uvicorn app.main:app --reload --port 8001"