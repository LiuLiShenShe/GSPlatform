#!/usr/bin/env bash
# verify_release_source.sh — clean-checkout reproducibility gate (FIX-06 §17).
#
# Proves "git commit → clean checkout → fresh deps → backend starts → tests
# pass" from the TRACKED tree alone:
#
#   1. git archive HEAD (or --from-commit) into a temp dir — the release
#      source is exactly what deploy_release.sh would ship.
#   2. Asserts the archive contains no .git / .env / .venv / node_modules /
#      other untracked state (the bare `storage/` gitignore bug is locked:
#      the tracked apps/api/app/storage/ package must be present).
#   3. Fresh venv, `pip install -e apps/api[dev]` from the archive.
#   4. Imports the full production closure + workers.celery_app.
#   5. Runs ruff, mypy, the backend pytest suite, the workers pytest suite.
#   6. A FRESH venv installs the reconstruction contract (torch/gsplat) and
#      passes the GPU runtime verify (CUDA + rasterization when a GPU exists).
#   7. Optional: --with-web-build to also run pnpm install + build.
#
# Usage:
#   ./deploy/scripts/verify_release_source.sh [--from-commit HEAD] [--keep] [--with-web-build]
#
# Exit 0 = PASS, non-zero = FAIL.  Never touches the working tree or the
# installed venv.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

FROM_COMMIT="HEAD"
KEEP=0
WITH_WEB_BUILD=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --from-commit)    FROM_COMMIT="$2"; shift 2 ;;
        --keep)           KEEP=1; shift ;;
        --with-web-build) WITH_WEB_BUILD=1; shift ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

echo "verify_release_source.sh — clean checkout from tracked HEAD"
echo "  commit:   $FROM_COMMIT"
echo "  repo:     $REPO_ROOT"
echo "================================================================================"

WORK="$(mktemp -d /tmp/gsplatform-verify-XXXXXX)"
trap '[[ "$KEEP" -eq 1 ]] || rm -rf "$WORK"' EXIT
echo "workdir: $WORK"

# ── 1. archive ──────────────────────────────────────────────────────────────
cd "$REPO_ROOT"
git archive --format=tar "$FROM_COMMIT" > "$WORK/release.tar"
tar -xf "$WORK/release.tar" -C "$WORK"
echo "✓ archived $FROM_COMMIT"

# ── 2. forbidden / required paths ──────────────────────────────────────────
echo ""
echo "[1] Source integrity"
FAILED=0
for p in .git .env .venv node_modules; do
    if [[ -e "$WORK/$p" || -d "$WORK/$p" ]]; then
        echo "  ✗ forbidden path present in archive: $p"
        FAILED=1
    fi
done
for f in \
    apps/api/app/storage/__init__.py \
    apps/api/app/storage/base.py \
    apps/api/app/storage/local_disk.py \
    apps/api/app/storage/paths.py \
    apps/api/pyproject.toml \
    workers/celery_app.py; do
    if [[ -f "$WORK/$f" ]]; then
        echo "  ✓ tracked file present: $f"
    else
        echo "  ✗ tracked file MISSING from archive: $f"
        FAILED=1
    fi
done
if [[ "$FAILED" -eq 1 ]]; then
    echo "RESULT: FAIL — archive integrity check failed"
    exit 1
fi

# ── 3. fresh venv + deps ────────────────────────────────────────────────────
echo ""
echo "[2] Fresh venv + pip install -e apps/api[dev]"
python3 -m venv "$WORK/apps/api/.venv"
"$WORK/apps/api/.venv/bin/pip" install -q --upgrade pip 2>/dev/null
if ! "$WORK/apps/api/.venv/bin/pip" install -q -e "$WORK/apps/api[dev]" >/dev/null 2>&1; then
    echo "RESULT: FAIL — pip install failed in fresh venv"
    exit 1
fi
echo "✓ deps installed (dev extra for lint/type/test gate)"

# ── 4. production import closure ────────────────────────────────────────────
echo ""
echo "[3] Import closure (API + storage + workers)"
"$WORK/apps/api/.venv/bin/python" - <<'PY'
import fastapi, sqlalchemy, pydantic, pydantic_settings, uvicorn
import celery, argon2, httpx, multipart, yaml, redis, numpy
import app.storage, app.main
import workers.celery_app
import workers.tasks.publish_scene, workers.tasks.reconstruct_scene, workers.tasks.build_collision
print("IMPORT_OK")
PY

# ── 5. lint + type + tests ──────────────────────────────────────────────────
echo ""
echo "[4] ruff"
( cd "$WORK/apps/api" && "$WORK/apps/api/.venv/bin/python" -m ruff check . )

echo ""
echo "[5] mypy"
( cd "$WORK/apps/api" && "$WORK/apps/api/.venv/bin/python" -m mypy app )

echo ""
echo "[6] backend pytest"
( cd "$WORK/apps/api" && "$WORK/apps/api/.venv/bin/python" -m pytest tests -q )

echo ""
echo "[7] workers pytest"
( cd "$WORK/workers" && "$WORK/apps/api/.venv/bin/python" -m pytest tests -q )

# ── 8. reconstruction runtime reproducibility (FIX-06.1 §A) ────────────────
# A FRESH venv installs the tracked torch/gsplat contract
# (deploy/requirements-reconstruction.txt) and must pass the runtime verify:
# imports + exact versions + `python -m workers.reconstruction.train_gsplat_script
# --help` always; CUDA availability + a real gsplat rasterization when a GPU is
# present.  --allow-no-gpu keeps the gate portable: a GPU-less machine proves
# checks 1-3 and prints SKIPPED_NO_GPU for 4-5 — it never claims GPU PASS.
echo ""
echo "[8] reconstruction runtime (fresh venv)"
python3 -m venv "$WORK/recon-venv"
"$WORK/recon-venv/bin/pip" install -q --upgrade pip 2>/dev/null
if ! "$WORK/recon-venv/bin/pip" install -q -e "$WORK/apps/api" >/dev/null 2>&1; then
    echo "RESULT: FAIL — reconstruction venv pip install -e apps/api failed"
    exit 1
fi
if ! "$WORK/recon-venv/bin/pip" install -q -r "$WORK/deploy/requirements-reconstruction.txt" >/dev/null 2>&1; then
    echo "RESULT: FAIL — requirements-reconstruction.txt install failed in fresh venv"
    exit 1
fi
if ! ( cd "$WORK" && "$WORK/recon-venv/bin/python" deploy/scripts/verify_reconstruction_runtime.py --allow-no-gpu ); then
    echo "RESULT: FAIL — reconstruction runtime verification failed in fresh venv"
    exit 1
fi

if [[ "$WITH_WEB_BUILD" -eq 1 ]]; then
    echo ""
    echo "[9] web install + build"
    ( cd "$WORK/apps/web" && pnpm install --frozen-lockfile && VITE_API_BASE_URL="/api/v1" pnpm build )
fi

echo ""
echo "================================================================================"
echo "RESULT: PASS — clean checkout → fresh deps → imports → lint/type/tests all green"
[[ "$KEEP" -eq 1 ]] && echo "workdir kept at: $WORK"