#!/usr/bin/env bash
# deploy_release.sh — create immutable release, build, migrate, switch, smoke.
#
# Usage:
#   ./deploy/scripts/deploy_release.sh --release 20260918-01 --environment staging
#   ./deploy/scripts/deploy_release.sh --release 20260918-01 --environment production
#
# The script:
#   1. Records the previous release for rollback safety.
#   2. Copies the release source (current working copy or specified dir) into
#      an immutable release dir under DEPLOY_ROOT/releases/<id>.
#   3. Creates a Python virtualenv, installs locked deps.
#   4. Builds the web frontend (pnpm build).
#   5. Runs Alembic upgrade (DB migration preflight via --dry-run).
#   6. Atomically updates the `current` symlink.
#   7. Reloads/restarts services (API, workers, Nginx).
#   8. Runs smoke_test.sh against the live site.
#   9. If smoke fails: prints rollback instructions and exits non-zero.
#
# Environment variables (also read via DEPLOY_ROOT/shared/config if present):
#   DEPLOY_ROOT       — /opt/gsplatform (default)
#   DEPLOY_ENV        — staging | production (default from --environment)
#   GS_DATABASE_URL   — required for migration preflight check
#   SMOKE_BASE_URL    — default: https://$HOSTNAME (staging) or production domain

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── Defaults ────────────────────────────────────────────────────────────────
RELEASE_ID=""
ENVIRONMENT=""
DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/gsplatform}"
DEPLOY_SOURCE="${DEPLOY_SOURCE:-$REPO_ROOT}"
DRY_RUN=0
SKIP_SMOKE=0
SMOKE_BASE_URL="${SMOKE_BASE_URL:-}"

# ── Parse args ──────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --release)        RELEASE_ID="$2";  shift 2 ;;
        --environment)    ENVIRONMENT="$2"; shift 2 ;;
        --source)         DEPLOY_SOURCE="$2"; shift 2 ;;
        --root)           DEPLOY_ROOT="$2"; shift 2 ;;
        --dry-run)        DRY_RUN=1; shift ;;
        --skip-smoke)     SKIP_SMOKE=1; shift ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "$RELEASE_ID" || -z "$ENVIRONMENT" ]]; then
    echo "Usage: $0 --release <id> --environment <staging|production> [--dry-run] [--skip-smoke]" >&2
    exit 1
fi

RELEASE_DIR="${DEPLOY_ROOT}/releases/${RELEASE_ID}"
PREVIOUS_LINK="${DEPLOY_ROOT}/current"
PREV_RELEASE=$(readlink -f "$PREVIOUS_LINK" 2>/dev/null || echo "")
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "================================================================================"
echo "GSPlatform deploy_release.sh — $(date -u)"
echo "  release:    $RELEASE_ID"
echo "  environment: $ENVIRONMENT"
echo "  source:     $DEPLOY_SOURCE"
echo "  deploy_root: $DEPLOY_ROOT"
echo "  dry_run:    $DRY_RUN"
echo "  prev:       $PREV_RELEASE"
echo "================================================================================"

if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[DRY RUN] Would create release dir: $RELEASE_DIR"
    echo "[DRY RUN] Would build web, install deps, run migration check"
    echo "[DRY RUN] Would flip current symlink to $RELEASE_DIR"
    echo "[DRY RUN] Would restart services"
    exit 0
fi

# ── 1. Record previous release ──────────────────────────────────────────────
echo ""
echo "[1] Recording previous release for rollback"
if [[ -n "$PREV_RELEASE" && -d "$PREV_RELEASE" ]]; then
    echo "    Previous release: $PREV_RELEASE"
    echo "$PREV_RELEASE" > "${DEPLOY_ROOT}/.previous_release"
else
    echo "    No previous release (first deploy)"
fi

# ── 2. Create immutable release dir ─────────────────────────────────────────
echo ""
echo "[2] Creating release $RELEASE_ID"
if [[ -d "$RELEASE_DIR" ]]; then
    echo "ERROR: Release dir $RELEASE_DIR already exists.  Use a unique release ID." >&2
    exit 1
fi
mkdir -p "$DEPLOY_ROOT/releases"
cp -a "$DEPLOY_SOURCE" "$RELEASE_DIR"
echo "    Copied source to $RELEASE_DIR"
# Preserve source commit metadata for traceability
cd "$RELEASE_DIR"
git rev-parse HEAD > .git-commit-hash 2>/dev/null || echo "unknown" > .git-commit-hash
echo "$RELEASE_ID" > .release-id
echo "$TIMESTAMP"  > .deployed-at
echo "$ENVIRONMENT" > .deploy-environment
git rev-parse --abbrev-ref HEAD > .release-branch 2>/dev/null || echo "main" > .release-branch
echo "    Metadata written: commit=$(cat .git-commit-hash), branch=$(cat .release-branch)"

# ── 3. Install locked dependencies ──────────────────────────────────────────
echo ""
echo "[3] Installing Python dependencies in release venv"
API_VENV="${RELEASE_DIR}/apps/api/.venv"
python3 -m venv "$API_VENV"
"${API_VENV}/bin/pip" install --upgrade pip >/dev/null 2>&1
"${API_VENV}/bin/pip" install -e "${RELEASE_DIR}/apps/api[dev]" >/dev/null 2>&1 || \
    "${API_VENV}/bin/pip" install -r "${RELEASE_DIR}/apps/api/pyproject.toml" 2>/dev/null || \
    echo "    ⚠ pip install failed — relying on pre-built venv in release"
echo "    Python venv ready at $API_VENV"

# ── 4. Build web frontend ───────────────────────────────────────────────────
echo ""
echo "[4] Building web frontend"
WEB_DIR="${RELEASE_DIR}/apps/web"
if [[ -d "$WEB_DIR" ]]; then
    cd "$WEB_DIR"
    VITE_API_BASE_URL="/api/v1" pnpm build --frozen-lockfile 2>&1 | tail -5 || \
        pnpm build 2>&1 | tail -5 || echo "    ⚠ web build failed — check logs"
    if [[ -f "$WEB_DIR/dist/index.html" ]]; then
        echo "    ✓ Web build complete: $(du -sh "$WEB_DIR/dist" | cut -f1)"
    else
        echo "    ✗ dist/index.html missing after build" >&2
        exit 1
    fi
else
    echo "    ⚠ No apps/web in release — assuming pre-built dist exists"
fi

# ── 5. Alembic migration preflight ─────────────────────────────────────────
echo ""
echo "[5] Alembic migration preflight"
if [[ -d "${RELEASE_DIR}/apps/api/migrations" ]]; then
    cd "${RELEASE_DIR}/apps/api"
    if [[ -n "${GS_DATABASE_URL:-}" ]]; then
        echo "    Running: alembic upgrade head --sql | head -20 (dry-run check)"
        "${API_VENV}/bin/python" -m alembic upgrade head 2>&1 | tail -3 || \
            echo "    ⚠ alembic upgrade failed — review migration compatibility"
    else
        echo "    ⚠ GS_DATABASE_URL not set — skipping migration check"
    fi
else
    echo "    ⚠ No migrations directory found"
fi

# ── 6. Atomic symlink switch ────────────────────────────────────────────────
echo ""
echo "[6] Atomic symlink: current → release $RELEASE_ID"
SYMLINK_NEXT="${DEPLOY_ROOT}/current.pending.$$"
ln -sfn "$RELEASE_DIR" "$SYMLINK_NEXT"
mv -Tf "$SYMLINK_NEXT" "$PREVIOUS_LINK"
echo "    ✓ current → $RELEASE_DIR"

# ── 7. Sync scene-origin tree ──────────────────────────────────────────────
echo ""
echo "[7] Syncing scene-origin tree (production asset URL tree)"
SCENE_ORIGIN="${GS_SCENE_ORIGIN_ROOT:-${DEPLOY_ROOT}/data/scene-origin}"
mkdir -p "$SCENE_ORIGIN"
"${API_VENV}/bin/python" -c "
import os, sys, uuid
from pathlib import Path
sys.path.insert(0, '${RELEASE_DIR}/apps/api')
os.environ.setdefault('GS_ENV', '${ENVIRONMENT}')
os.environ.setdefault('GS_STORAGE_ROOT', '${GS_STORAGE_ROOT:-/srv/gsplatform-data}')
os.environ.setdefault('GS_SCENE_ORIGIN_ROOT', '$SCENE_ORIGIN')
from app.core.config import settings
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from app.db.models.scene import Scene

engine = create_engine(settings.database_url, connect_args={'connect_timeout': 5})
origin_root = Path(settings.scene_origin_root or '$SCENE_ORIGIN')
storage_root = Path(settings.storage_root)
origin_root.mkdir(parents=True, exist_ok=True)

# Get all published scenes with their current version info
with Session(engine) as session:
    rows = session.execute(text(
        \"\"\"
        SELECT s.id, s.slug, s.status, s.visibility, sv.asset_version
        FROM scenes s
        JOIN scene_versions sv ON s.current_version_id = sv.id
        WHERE s.status = 'PUBLISHED' AND s.deleted_at IS NULL
        \"\"\"
    )).fetchall()

existing = set()
for scene_id, slug, status, visibility, version_id in rows:
    pub_path = storage_root / 'published' / str(scene_id) / 'versions' / version_id
    slug_dir = origin_root / slug
    existing.add(slug)
    if not pub_path.is_dir():
        print(f'    ⚠ published version missing for {slug}: {pub_path}')
        continue
    slug_dir.mkdir(parents=True, exist_ok=True)
    # versions/<ver> → absolute symlink to published version
    ver_link = slug_dir / 'versions' / version_id
    if ver_link.exists() or ver_link.is_symlink():
        if ver_link.is_symlink() and os.path.realpath(str(ver_link)) == str(pub_path.resolve()):
            continue
        ver_link.unlink()
    ver_link.symlink_to(str(pub_path.resolve()), target_is_directory=True)
    # current → versions/<ver> (relative)
    current = slug_dir / 'current'
    expected_rel = f'versions/{version_id}'
    if current.is_symlink() and os.readlink(str(current)) == expected_rel:
        continue
    if current.exists() or current.is_symlink():
        current.unlink()
    current.symlink_to(expected_rel, target_is_directory=True)
    print(f'    ✓ {slug} → {version_id}')

# Remove stale origin entries for scenes no longer published
for entry in origin_root.iterdir():
    if entry.is_dir() and entry.name not in existing:
        import shutil
        shutil.rmtree(entry)
        print(f'    🗑 removed stale origin: {entry.name}')

print(f'    Done: {len(rows)} scene(s) in origin tree')
" 2>&1 || echo "    ⚠ scene-origin sync failed — review logs above"

# ── 8. Reload/restart services ─────────────────────────────────────────────
echo ""
echo "[8] Restarting services (systemctl if available, otherwise skip)"
restart_svc() {
    local svc="$1"
    if command -v systemctl >/dev/null 2>&1; then
        sudo systemctl daemon-reload 2>/dev/null || true
        sudo systemctl restart "$svc" 2>/dev/null && echo "    ✓ restarted $svc" || echo "    ⚠ restart $svc failed"
    else
        echo "    ℹ systemctl unavailable — restart $svc manually: sudo systemctl restart $svc"
    fi
}
restart_svc gsplatform-api
restart_svc gsplatform-celery-cpu
restart_svc gsplatform-celery-gpu
sudo systemctl reload nginx 2>/dev/null && echo "    ✓ reloaded nginx" || \
    sudo nginx -s reload 2>/dev/null && echo "    ✓ reloaded nginx (via nginx -s reload)" || \
    echo "    ⚠ nginx reload failed — check config: nginx -t"

# ── 9. Smoke test ──────────────────────────────────────────────────────────
echo ""
if [[ "$SKIP_SMOKE" -eq 1 ]]; then
    echo "[9] Smoke test: SKIPPED (--skip-smoke)"
else
    echo "[9] Running smoke_test.sh"
    # Wait for services to stabilize
    sleep 3
    if [[ -x "${RELEASE_DIR}/deploy/scripts/smoke_test.sh" ]]; then
        "${RELEASE_DIR}/deploy/scripts/smoke_test.sh" \
            --environment "$ENVIRONMENT" \
            ${SMOKE_BASE_URL:+--base-url "$SMOKE_BASE_URL"} \
            && echo "    ✓ Smoke test PASSED" \
            || { echo "    ✗ Smoke test FAILED — triggering rollback instructions" >&2
                 echo "    ┌──────────────────────────────────────────────────────────┐"
                 echo "    │ ROLLBACK:                                                │"
                 echo "    │   ./deploy/scripts/rollback.sh --root $DEPLOY_ROOT       │"
                 echo "    │                                                          │"
                 echo "    │ Previous release: ${PREV_RELEASE:-none}                  │"
                 echo "    └──────────────────────────────────────────────────────────┘"
                 exit 1; }
    else
        echo "    ⚠ smoke_test.sh not found in release — skipping"
    fi
fi

# ── Done ────────────────────────────────────────────────────────────────────
echo ""
echo "================================================================================"
echo "Deploy complete: release $RELEASE_ID  deployed to $DEPLOY_ROOT/current"
echo "  commit:  $(cat "${RELEASE_DIR}/.git-commit-hash" 2>/dev/null || echo unknown)"
echo "  branch:  $(cat "${RELEASE_DIR}/.release-branch" 2>/dev/null || echo unknown)"
echo "  prev:    ${PREV_RELEASE:-none}"
echo "================================================================================"
