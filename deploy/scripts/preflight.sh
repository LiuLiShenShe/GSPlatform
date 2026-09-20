#!/usr/bin/env bash
# preflight.sh — Phase 09 host environment validation (non-destructive).
#
# Usage:
#   ./deploy/scripts/preflight.sh --environment staging
#   ./deploy/scripts/preflight.sh --environment production --dry-run
#
# Environment variables:
#   DEPLOY_ROOT       — release root (default /opt/gsplatform)
#   GS_STORAGE_ROOT   — data root (default /srv/gsplatform-data)
#   GS_SCENE_ORIGIN_ROOT — scene origin tree root (default $GS_STORAGE_ROOT/scene-origin)
#   PG_DUMP_CMD       — command prefix for pg_dump (see BACKUP_RESTORE_RUNBOOK)
#   GS_DATABASE_URL   — database URL to test connectivity

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── Defaults ────────────────────────────────────────────────────────────────
ENVIRONMENT=""
DRY_RUN=0
DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/gsplatform}"
GS_STORAGE_ROOT="${GS_STORAGE_ROOT:-/srv/gsplatform-data}"
GS_SCENE_ORIGIN_ROOT="${GS_SCENE_ORIGIN_ROOT:-${GS_STORAGE_ROOT}/scene-origin}"

# ── Parse args ──────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --environment) ENVIRONMENT="$2"; shift 2 ;;
        --dry-run)     DRY_RUN=1; shift ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done
if [[ -z "$ENVIRONMENT" ]]; then
    echo "Usage: $0 --environment <staging|production> [--dry-run]" >&2
    exit 1
fi

# ── Helpers ─────────────────────────────────────────────────────────────────
PASS=0
FAIL=0
WARN=0
NOTICE=""
LOG="/tmp/gsplatform-preflight-$ENVIRONMENT-$(date +%s).log"

pass() { echo "  ✓ $1"; ((PASS++)) || true; }
warn() { echo "  ⚠ $1" ; NOTICE+="$1"$'\n'; ((WARN++)) || true; }
fail() { echo "  ✗ $1" ; ((FAIL++)) || true; }

check_file() { [[ -e "$1" ]] && pass "$1 exists" || fail "$1 missing"; }
check_exec() { command -v "$1" >/dev/null 2>&1 && pass "$1 available ($(command -v "$1"))" || fail "$1 not found on PATH"; }
check_var()  { [[ -n "${!1:-}" ]] && pass "$1 is set" || fail "$1 not set"; }

echo "GSPlatform Preflight — environment=$ENVIRONMENT  dry-run=$DRY_RUN"
echo "================================================================================"

# ── A. Host & filesystem ───────────────────────────────────────────────────
echo "[A] Host & filesystem"
check_exec nginx
check_exec python3
check_exec node
check_exec pnpm
check_exec ffmpeg || true  # optional outside workers

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
echo "Release root"
if [[ -d "${DEPLOY_ROOT}/current" ]]; then
    CURRENT=$(readlink -f "${DEPLOY_ROOT}/current" 2>/dev/null || echo "")
    pass "current symlink points to $CURRENT"
else
    warn "${DEPLOY_ROOT}/current does not exist yet (first deploy will create it)"
fi

# ── B. Database ─────────────────────────────────────────────────────────────
echo ""
echo "[B] Database connectivity"
if [[ -n "${GS_DATABASE_URL:-}" ]]; then
    # Quick liveness via Python (no psql dependency)
    if python3 -c "
import urllib.parse as _up
from sqlalchemy import create_engine, text
url = '${GS_DATABASE_URL}'
engine = create_engine(url, connect_args={'connect_timeout': 5})
with engine.connect() as conn:
    conn.execute(text('SELECT 1'))
print('SELECT 1 OK')
" 2>/dev/null; then
        pass "PostgreSQL reachable (GS_DATABASE_URL)"
    else
        fail "PostgreSQL unreachable (GS_DATABASE_URL set but connection failed)"
    fi
else
    fail "GS_DATABASE_URL not set — cannot test DB connectivity"
fi

# ── C. Redis ────────────────────────────────────────────────────────────────
echo ""
echo "[C] Redis connectivity"
if python3 -c "
import os
import redis as _r
url = os.environ.get('REDIS_URL', 'redis://127.0.0.1:6379/0')
r = _r.Redis.from_url(url, socket_connect_timeout=3)
r.ping()
print('Redis PING OK')
" 2>/dev/null; then
    pass "Redis reachable"
else
    warn "Redis unreachable or REDIS_URL not set (non-blocking for preflight)"
fi

# ── D. Build artifacts ─────────────────────────────────────────────────────
echo ""
echo "[D] Build artifacts"
check_file "${DEPLOY_ROOT}/current/apps/web/dist/index.html"
check_file "${DEPLOY_ROOT}/current/apps/api/app/main.py"
check_file "${DEPLOY_ROOT}/current/deploy/nginx/gsplatform.conf"
check_file "${DEPLOY_ROOT}/current/deploy/systemd/gsplatform-api.service"
check_file "${DEPLOY_ROOT}/current/apps/api/.venv/bin/uvicorn"

# ── E. Nginx configuration syntax ──────────────────────────────────────────
echo ""
echo "[E] Nginx configuration syntax"
if nginx -t 2>/tmp/gsplatform-nginx-test.log; then
    pass "nginx -t passed"
else
    cat /tmp/gsplatform-nginx-test.log >&2
    fail "nginx -t failed (see log above)"
fi

# ── F. Python dependencies ─────────────────────────────────────────────────
echo ""
echo "[F] Python API venv health"
API_VENV="${DEPLOY_ROOT}/current/apps/api/.venv"
if [[ -x "${API_VENV}/bin/python" ]]; then
    if "${API_VENV}/bin/python" -c "import fastapi, sqlalchemy, pydantic, uvicorn; print('deps OK')"; then
        pass "FastAPI/SQLAlchemy/Pydantic/uvicorn importable"
    else
        fail "API venv missing required packages"
    fi
    if "${API_VENV}/bin/python" -c "import celery; print('celery', celery.__version__)"; then
        pass "Celery importable in API venv"
    else
        warn "Celery not importable in API venv (may be in separate worker venv)"
    fi
else
    warn "API venv not found at ${API_VENV} (skip)"
fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "================================================================================"
echo "Preflight summary: $PASS passed, $FAIL failed, $WARN warnings"
if [[ -n "$NOTICE" ]]; then
    echo ""
    echo "Warnings:"
    echo "$NOTICE"
fi
if [[ "$FAIL" -gt 0 ]]; then
    echo "RESULT: FAIL — $FAIL blocking issue(s) found.  Fix before deploying."
    exit 1
else
    echo "RESULT: PASS — preflight complete ($ENVIRONMENT, dry-run=$DRY_RUN)."
    echo "Log saved to: $LOG"
fi
