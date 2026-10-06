#!/usr/bin/env bash
# preflight.sh — GSPlatform host / release preflight (FIX-06.2 §13-§21).
#
# Two distinct modes — a fresh host must be able to preflight BEFORE
# /opt/gsplatform/current exists, and an installed release must be validated
# against its own contract.  Mixing them made a first deploy impossible.
#
#   --mode host
#     Pre-deploy HOST readiness.  Valid before any release exists.  Checks
#     only what is checkable pre-deploy: OS commands, filesystem/disk, env
#     file, PostgreSQL/Redis reachability (pg_isready / redis-cli), the
#     production rate-limiter config gate, and the NVIDIA host runtime when
#     GPU reconstruction is part of the product.  Does NOT check /current:
#     web dist, API venv, torch/gsplat, alembic — none exist on a fresh host.
#
#   --mode release
#     Installed-RELEASE integrity / runtime validation.  REQUIRES
#     $DEPLOY_ROOT/current (fails if no release is installed yet).  Checks
#     the symlink + commit metadata, web dist, storage package, API venv
#     (imports, celery, uvicorn), systemd ExecStart paths, the
#     torch/gsplat/CUDA reconstruction runtime, alembic current==head, and
#     nginx syntax.
#
# Usage:
#   ./deploy/scripts/preflight.sh --environment production --mode host
#   ./deploy/scripts/preflight.sh --environment production --mode release
#   ./deploy/scripts/preflight.sh --environment staging --mode host --dry-run
#
# Default --mode is host (the runbook's pre-deploy step is host readiness).
# Legacy calls without --mode keep working: they run host-mode checks.
#
# Environment:
#   DEPLOY_ROOT       — release root (default /opt/gsplatform)
#   GS_STORAGE_ROOT   — data root (default /srv/gsplatform-data)
#   GS_SCENE_ORIGIN_ROOT — scene origin tree root (default $GS_STORAGE_ROOT/scene-origin)
#   GS_DATABASE_URL   — PostgreSQL URL for the host probe (pg_isready)
#   GS_REDIS_URL      — Redis URL for the host probe (redis-cli PING)
#   GS_ENV_FILE       — deployment env file (default /etc/gsplatform/env);
#                       loaded safely (no shell expansion) when it exists.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── Shared env-file loader (FIX-06.2 §24) ─────────────────────────────────
. "$SCRIPT_DIR/lib_env.sh"

# ── Defaults ────────────────────────────────────────────────────────────────
ENVIRONMENT=""
MODE="host"
DRY_RUN=0
DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/gsplatform}"
GS_STORAGE_ROOT="${GS_STORAGE_ROOT:-/srv/gsplatform-data}"
GS_SCENE_ORIGIN_ROOT="${GS_SCENE_ORIGIN_ROOT:-${GS_STORAGE_ROOT}/scene-origin}"

# ── Parse args ──────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --environment) ENVIRONMENT="$2"; shift 2 ;;
        --mode)        MODE="$2"; shift 2 ;;
        --dry-run)     DRY_RUN=1; shift ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done
if [[ -z "$ENVIRONMENT" ]]; then
    echo "Usage: $0 --environment <staging|production> [--mode host|release] [--dry-run]" >&2
    exit 1
fi
if [[ "$MODE" != "host" && "$MODE" != "release" ]]; then
    echo "ERROR: --mode must be 'host' or 'release' (got: $MODE)" >&2
    exit 1
fi

# Load the deployment env file (no-op if $GS_ENV_FILE does not exist or
# GS_ENV_LOADED=1).  Secrets are never printed.
load_gsplatform_env

# ── Helpers ─────────────────────────────────────────────────────────────────
PASS=0
FAIL=0
WARN=0
NOTICE=""
LOG="/tmp/gsplatform-preflight-$MODE-$ENVIRONMENT-$(date +%s).log"

pass() { echo "  ✓ $1"; ((PASS++)) || true; }
warn() { echo "  ⚠ $1" ; NOTICE+="$1"$'\n'; ((WARN++)) || true; }
fail() { echo "  ✗ $1" ; ((FAIL++)) || true; }

check_file() { [[ -e "$1" ]] && pass "$1 exists" || fail "$1 missing"; }
check_exec() { command -v "$1" >/dev/null 2>&1 && pass "$1 available ($(command -v "$1"))" || fail "$1 not found on PATH"; }

echo "GSPlatform Preflight — mode=$MODE environment=$ENVIRONMENT dry-run=$DRY_RUN"
echo "================================================================================"

# ── [A] HOST: commands, filesystem, env file ───────────────────────────────
echo "[A] Host & filesystem"
check_exec nginx
check_exec python3
check_exec node
check_exec pnpm
check_exec ffmpeg || true  # optional outside workers
# pg_isready / redis-cli presence+reachability are probed in [B]/[C] with
# environment-appropriate severity (production requires them).

echo ""
echo "Directories"
for d in "$DEPLOY_ROOT" "$GS_STORAGE_ROOT" "${GS_STORAGE_ROOT}/staging" \
         "${GS_STORAGE_ROOT}/published" "${GS_STORAGE_ROOT}/quarantine" \
         "${GS_STORAGE_ROOT}/logs" "${GS_SCENE_ORIGIN_ROOT}"; do
    if [[ -d "$d" ]]; then pass "$d"; else warn "$d missing (will create on deploy)"; fi
done

# Disk space: warn if < 10GB free on storage root
AVAIL_KB=$(df --output=avail "$GS_STORAGE_ROOT" 2>/dev/null | tail -1 || echo 0)
if [[ "$AVAIL_KB" -lt 10485760 ]]; then
    warn "Storage root has <10 GB free (avail: $(( AVAIL_KB / 1048576 )) GB)"
else
    pass "Storage root has $(( AVAIL_KB / 1048576 )) GB free"
fi

echo ""
echo "Env file"
if [[ -f "${GS_ENV_FILE:-/etc/gsplatform/env}" ]]; then
    pass "env file present: ${GS_ENV_FILE:-/etc/gsplatform/env}"
elif [[ "$ENVIRONMENT" == "production" ]]; then
    fail "env file missing: ${GS_ENV_FILE:-/etc/gsplatform/env} — create it from deploy/env/production.env.example"
else
    warn "env file missing: ${GS_ENV_FILE:-/etc/gsplatform/env} (non-blocking outside production)"
fi

# ── [B] HOST: PostgreSQL reachability via pg_isready (FIX-06.2 §16) ────────
# libpq does NOT accept SQLAlchemy's "+psycopg2" driver suffix — strip it.
# Only the suffix is removed; the URI is never echoed (it may hold a password).
echo ""
echo "[B] PostgreSQL connectivity"
if command -v pg_isready >/dev/null 2>&1; then
    if [[ -n "${GS_DATABASE_URL:-}" ]]; then
        LIBPQ_URL="${GS_DATABASE_URL//+psycopg2/}"
        if pg_isready -d "$LIBPQ_URL" -t 5 >/dev/null 2>&1; then
            pass "PostgreSQL reachable (pg_isready, GS_DATABASE_URL)"
        else
            fail "PostgreSQL unreachable (pg_isready) — GS_DATABASE_URL set but connection failed"
        fi
    else
        fail "GS_DATABASE_URL not set — cannot test DB connectivity"
    fi
else
    # pg_isready ships with the postgresql client tools (installed with the
    # `postgresql` package in the runbook).  Blocking in production.
    if [[ "$ENVIRONMENT" == "production" ]]; then
        fail "pg_isready not found — install postgresql-client (runbook §2)"
    else
        warn "pg_isready not found — skipping PostgreSQL host probe (non-blocking outside production)"
    fi
fi

# ── [C] HOST: Redis reachability via redis-cli PING (FIX-06.2 §17) ─────────
# redis-cli never echoes the URI/password; logs only show "PING OK".
echo ""
echo "[C] Redis connectivity"
REDIS_URL="${GS_REDIS_URL:-${REDIS_URL:-redis://127.0.0.1:6379/0}}"
if command -v redis-cli >/dev/null 2>&1; then
    if redis-cli -u "$REDIS_URL" PING 2>/dev/null | grep -q "PONG"; then
        pass "Redis PING OK"
    else
        if [[ "$ENVIRONMENT" == "production" ]]; then
            fail "Redis unreachable in production (GS_RATE_LIMIT_BACKEND=redis requires it) — BLOCKING"
        else
            warn "Redis unreachable or GS_REDIS_URL not set (non-blocking outside production)"
        fi
    fi
else
    # redis-cli ships with the redis-server package in the runbook.
    if [[ "$ENVIRONMENT" == "production" ]]; then
        fail "redis-cli not found — install redis-server (runbook §2); production Redis probe required"
    else
        warn "redis-cli not found — skipping Redis host probe (non-blocking outside production)"
    fi
fi

# ── [D] HOST: production rate-limiter config gate (FIX-06.2 §18) ───────────
# Two layers: this pre-deploy config gate (fail fast, no uvicorn needed) AND
# the application startup guard in app/main.py (kept; defence in depth).
echo ""
echo "[D] Production configuration"
if [[ "$ENVIRONMENT" == "production" ]]; then
    if [[ "${GS_RATE_LIMIT_BACKEND:-}" == "redis" ]]; then
        pass "GS_RATE_LIMIT_BACKEND=redis (host config gate)"
    else
        fail "GS_RATE_LIMIT_BACKEND must be 'redis' in production (got: '${GS_RATE_LIMIT_BACKEND:-<unset>}') — app startup would refuse too"
    fi
    if [[ "${GS_DEV_IDENTITY_ENABLED:-false}" == "true" ]]; then
        fail "GS_DEV_IDENTITY_ENABLED must be false in production"
    else
        pass "GS_DEV_IDENTITY_ENABLED not true in production"
    fi
else
    pass "rate-limiter backend policy only enforced in production"
fi

# ── [E] HOST: NVIDIA runtime when GPU reconstruction is part of the product ─
# Host-mode probe is nvidia-smi only — torch/gsplat live in the release venv
# and belong to RELEASE mode.
echo ""
echo "[E] NVIDIA host runtime"
GPU_SIGNAL="${REPO_ROOT}/deploy/systemd/gsplatform-celery-gpu.service"
if [[ -f "$GPU_SIGNAL" ]]; then
    if command -v nvidia-smi >/dev/null 2>&1 && \
       CNT=$(nvidia-smi --query-gpu=count --format=csv,noheader 2>/dev/null | head -1) && \
       [[ -n "$CNT" && "$CNT" -ge 1 ]]; then
        pass "NVIDIA GPU visible: $CNT device(s) (nvidia-smi)"
    else
        fail "nvidia-smi missing/failed — GPU reconstruction unit ships with the product and needs >=1 visible NVIDIA GPU"
    fi
else
    pass "no GPU worker unit — NVIDIA host probe skipped"
fi

# ── RELEASE MODE ONLY ──────────────────────────────────────────────────────
if [[ "$MODE" == "release" ]]; then

# ── [F] RELEASE: current symlink + release metadata ───────────────────────
echo ""
echo "[F] Release root & metadata"
if [[ ! -d "${DEPLOY_ROOT}/current" ]]; then
    fail "${DEPLOY_ROOT}/current does not exist — RELEASE mode requires an installed release (run HOST mode + deploy_release.sh first)"
else
    CURRENT=$(readlink -f "${DEPLOY_ROOT}/current" 2>/dev/null || echo "")
    pass "current symlink points to $CURRENT"
fi
if [[ -f "${DEPLOY_ROOT}/current/.git-commit-hash" ]]; then
    HASH=$(cat "${DEPLOY_ROOT}/current/.git-commit-hash")
    if [[ "$HASH" =~ ^[0-9a-f]{40}$ ]]; then
        pass "release commit hash recorded ($HASH)"
    else
        fail "release .git-commit-hash is not a valid commit hash: $HASH"
    fi
else
    fail ".git-commit-hash missing in current release (deploy_release.sh must write it)"
fi

# ── [G] RELEASE: build artifacts & tracked-source integrity ───────────────
echo ""
echo "[G] Build artifacts & release integrity"
check_file "${DEPLOY_ROOT}/current/apps/web/dist/index.html"
check_file "${DEPLOY_ROOT}/current/apps/api/app/main.py"
check_file "${DEPLOY_ROOT}/current/deploy/nginx/gsplatform.conf"
check_file "${DEPLOY_ROOT}/current/deploy/systemd/gsplatform-api.service"
check_file "${DEPLOY_ROOT}/current/apps/api/.venv/bin/uvicorn"
# FIX-06 §1/§13: the storage package is *tracked* — a release built from
# git archive must contain it.
for f in \
    "${DEPLOY_ROOT}/current/apps/api/app/storage/__init__.py" \
    "${DEPLOY_ROOT}/current/apps/api/app/storage/base.py" \
    "${DEPLOY_ROOT}/current/apps/api/app/storage/local_disk.py" \
    "${DEPLOY_ROOT}/current/apps/api/app/storage/paths.py"; do
    check_file "$f"
done

# ── [H] RELEASE: Nginx configuration syntax ───────────────────────────────
echo ""
echo "[H] Nginx configuration syntax"
if nginx -t 2>/tmp/gsplatform-nginx-test.log; then
    pass "nginx -t passed"
else
    cat /tmp/gsplatform-nginx-test.log >&2
    fail "nginx -t failed (see log above)"
fi

# ── [I] RELEASE: Python dependencies & shared worker venv (FIX-06 §3/§4) ───
echo ""
echo "[I] Python API venv health (shared venv = apps/api/.venv)"
API_VENV="${DEPLOY_ROOT}/current/apps/api/.venv"
if [[ -x "${API_VENV}/bin/python" ]]; then
    # Full production import closure: API + storage + worker entry.
    if "${API_VENV}/bin/python" -c "
import fastapi, sqlalchemy, pydantic, pydantic_settings, uvicorn
import celery, argon2, httpx, multipart, yaml, redis, numpy
import app.storage, app.main
print('deps OK')
"; then
        pass "API imports: fastapi/sqlalchemy/pydantic/uvicorn/celery/argon2/httpx/multipart/yaml/redis/numpy + app.storage + app.main"
    else
        fail "API venv missing required packages"
    fi
    # Worker entry: module-level imports are celery/app only — must import
    # without torch/gsplat in this shared venv.
    if "${API_VENV}/bin/python" -c "import workers.celery_app; print('workers OK')"; then
        pass "workers.celery_app importable in shared venv"
    else
        fail "workers.celery_app import failed in shared venv"
    fi
    CELERY_BIN="${API_VENV}/bin/celery"
    if [[ -x "$CELERY_BIN" ]]; then
        pass "celery executable present: $CELERY_BIN"
    else
        fail "celery executable missing: $CELERY_BIN"
    fi
else
    fail "API venv not found at ${API_VENV} — deploy never completes without it"
fi

# ── [J] RELEASE: systemd ExecStart paths (FIX-06 §4) ───────────────────────
echo ""
echo "[J] systemd unit ExecStart path existence"
for unit in gsplatform-api gsplatform-celery-cpu gsplatform-celery-gpu gsplatform-cleanup; do
    UNIT_FILE="${DEPLOY_ROOT}/current/deploy/systemd/${unit}.service"
    if [[ -f "$UNIT_FILE" ]]; then
        EXEC=$(grep -E "^ExecStart=" "$UNIT_FILE" | cut -d= -f2- | awk '{print $1}')
        if [[ -n "$EXEC" && -e "$EXEC" ]]; then
            pass "$unit ExecStart exists ($EXEC)"
        elif [[ -n "$EXEC" ]]; then
            EXEC_PATH="${DEPLOY_ROOT}/current/${EXEC#*/current/}"
            if [[ -e "$EXEC_PATH" ]]; then
                pass "$unit ExecStart resolves under current ($EXEC)"
            else
                fail "$unit ExecStart missing: $EXEC"
            fi
        else
            fail "$unit has no ExecStart="
        fi
    else
        fail "unit file missing in release: $UNIT_FILE"
    fi
done

# ── [K] RELEASE: reconstruction runtime (torch/gsplat/CUDA) — FIX-06.1 §A ──
echo ""
echo "[K] Reconstruction runtime (GPU worker) — BLOCKING when GPU unit is present"
GPU_UNIT="${DEPLOY_ROOT}/current/deploy/systemd/gsplatform-celery-gpu.service"
if [[ -f "$GPU_UNIT" ]]; then
    if [[ -x "${API_VENV}/bin/python" && -f "${DEPLOY_ROOT}/current/deploy/scripts/verify_reconstruction_runtime.py" ]]; then
        if (cd "${DEPLOY_ROOT}/current" && "${API_VENV}/bin/python" deploy/scripts/verify_reconstruction_runtime.py) \
            >/tmp/gsplatform-recon-verify.log 2>&1; then
            pass "reconstruction runtime verified (torch/gsplat versions + trainer --help + CUDA rasterization)"
        else
            cat /tmp/gsplatform-recon-verify.log >&2
            fail "reconstruction runtime verification FAILED — GPU worker must not start with broken torch/gsplat/CUDA"
        fi
    else
        fail "GPU worker unit present but reconstruction runtime missing (apps/api/.venv python or verify_reconstruction_runtime.py)"
    fi
else
    pass "no GPU worker unit — CPU-only deployment; reconstruction runtime check skipped"
fi

# ── [L] RELEASE: Alembic migration state (current == head) ─────────────────
echo ""
echo "[L] Alembic migration state"
if [[ -n "${GS_DATABASE_URL:-}" && -d "${DEPLOY_ROOT}/current/apps/api/migrations" ]]; then
    cd "${DEPLOY_ROOT}/current/apps/api"
    HEAD_HASH=$("${API_VENV}/bin/python" -m alembic heads 2>/dev/null | grep -oE "^[0-9a-f]{12}" | head -1 || true)
    CUR_HASH=$("${API_VENV}/bin/python" -m alembic current 2>/dev/null | grep -oE "^[0-9a-f]{12}" | head -1 || true)
    if [[ -n "$HEAD_HASH" && "$CUR_HASH" == "$HEAD_HASH" ]]; then
        pass "alembic current == head ($CUR_HASH)"
    else
        fail "alembic current ($CUR_HASH) != head ($HEAD_HASH) — DB needs upgrade"
    fi
else
    warn "GS_DATABASE_URL unset or migrations missing — skipping alembic check"
fi

fi  # RELEASE mode

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "================================================================================"
echo "Preflight summary ($MODE): $PASS passed, $FAIL failed, $WARN warnings"
if [[ -n "$NOTICE" ]]; then
    echo ""
    echo "Warnings:"
    echo "$NOTICE"
fi
if [[ "$FAIL" -gt 0 ]]; then
    echo "RESULT: FAIL — $FAIL blocking issue(s) found ($MODE).  Fix before deploying."
    exit 1
else
    echo "RESULT: PASS — preflight complete (mode=$MODE, environment=$ENVIRONMENT, dry-run=$DRY_RUN)."
    echo "Log saved to: $LOG"
fi