#!/usr/bin/env bash
# deploy_release.sh — create immutable release, build, migrate, switch, smoke.
#
# Usage:
#   ./deploy/scripts/deploy_release.sh --release 20260918-01 --environment staging
#   ./deploy/scripts/deploy_release.sh --release 20260918-01 --environment production
#
# FIX-06 §12: the release is built from **tracked source only** via
# `git archive HEAD` — the working tree is never copied, so a dirty checkout
# cannot leak untracked/copied files (.env, .venv, node_modules, stray
# storage/) into a release.  Every step is fail-closed: a failed install,
# build, migration, scene-origin sync, restart or smoke test aborts the deploy
# instead of printing "⚠ relying on pre-built venv" and continuing.
#
# The script:
#   1. Records the previous release for rollback safety.
#   2. Verifies the source repo is clean (unless --allow-dirty) and archives
#      HEAD into an immutable release dir under DEPLOY_ROOT/releases/<id>.
#   3. Creates a Python virtualenv, installs declared deps (fail-closed).
#   3b. Installs the reconstruction runtime contract (torch/gsplat) + verifies.
#   4. Builds the web frontend (pnpm build --frozen-lockfile, fail-closed).
#   5. Runs Alembic migration (single-head check then upgrade; fail-closed).
#   6. Atomically updates the `current` symlink.
#   6b. Runs RELEASE-mode preflight against the new current release
#       (preflight.sh --mode release) — fail-closed, rolls the symlink back.
#   7. Reloads/restarts services (API, workers, Nginx) — fail-closed.
#   8. Runs smoke_test.sh against the live site (hard gate).
#   9. If any step fails: prints rollback instructions and exits non-zero.
#
# Environment variables (loaded from $GS_ENV_FILE — default /etc/gsplatform/env —
# via lib_env.sh when the operator has not exported them; also read via
# DEPLOY_ROOT/shared/config if present):
#   DEPLOY_ROOT       — /opt/gsplatform (default)
#   DEPLOY_ENV        — staging | production (default from --environment)
#   GS_DATABASE_URL   — required for the migration step
#   SMOKE_BASE_URL    — default: https://$HOSTNAME (staging) or production domain

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── Shared env + rollback helpers (FIX-06.2 §24; FIX-06.2.1 §B/§15) ──────
# lib_env.sh: the systemd units load /etc/gsplatform/env via EnvironmentFile=;
# this script and preflight.sh read the SAME file so the release inherits
# GS_DATABASE_URL / GS_STORAGE_ROOT / SMOKE_PUBLIC_SCENE_SLUG etc. without
# the operator exporting them by hand.  Loaded safely (no shell expansion —
# passwords with $ are preserved), never printed.
# lib_rollback.sh: fail-closed `current` rollback used by step 6b.
. "$SCRIPT_DIR/lib_env.sh"
load_gsplatform_env
. "$SCRIPT_DIR/lib_rollback.sh"

# ── Defaults ────────────────────────────────────────────────────────────────
RELEASE_ID=""
ENVIRONMENT=""
DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/gsplatform}"
DEPLOY_SOURCE="${DEPLOY_SOURCE:-$REPO_ROOT}"
DRY_RUN=0
SKIP_SMOKE=0
ALLOW_DIRTY=0
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
        --allow-dirty)    ALLOW_DIRTY=1; shift ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "$RELEASE_ID" || -z "$ENVIRONMENT" ]]; then
    echo "Usage: $0 --release <id> --environment <staging|production> [--dry-run] [--skip-smoke] [--allow-dirty]" >&2
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
echo "  source:     $DEPLOY_SOURCE (tracked HEAD only, via git archive)"
echo "  deploy_root: $DEPLOY_ROOT"
echo "  dry_run:    $DRY_RUN"
echo "  prev:       $PREV_RELEASE"
echo "================================================================================"

if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[DRY RUN] Would archive git HEAD into: $RELEASE_DIR"
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

# ── 2. Source integrity + immutable release dir (FIX-06 §12) ────────────────
echo ""
echo "[2] Archiving tracked HEAD into release $RELEASE_ID"
if [[ ! -d "$DEPLOY_SOURCE/.git" ]]; then
    echo "ERROR: $DEPLOY_SOURCE is not a git work tree (no .git)." >&2
    echo "       Deploy source must be the git repo — releases come from tracked HEAD only." >&2
    exit 1
fi
cd "$DEPLOY_SOURCE"
if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
    echo "ERROR: no commit at HEAD in $DEPLOY_SOURCE" >&2
    exit 1
fi
if [[ "$ALLOW_DIRTY" -eq 1 ]]; then
    echo "    ⚠ --allow-dirty: skipping the clean working-tree check"
else
    if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
        echo "ERROR: source working tree is dirty — refusing to deploy untracked/uncommitted state." >&2
        echo "       Commit or stash first, or pass --allow-dirty (dangerous) to override." >&2
        exit 1
    fi
    echo "    ✓ working tree clean"
fi

COMMIT_HASH=$(git rev-parse HEAD)
COMMIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)

if [[ -d "$RELEASE_DIR" ]]; then
    echo "ERROR: Release dir $RELEASE_DIR already exists.  Use a unique release ID." >&2
    exit 1
fi
mkdir -p "$DEPLOY_ROOT/releases"
# Archive the committed tree only — never the working copy (no .git, .env,
# .venv, node_modules, or stray untracked storage/ in the release).
STAGE_DIR="${RELEASE_DIR}.staging.$$"
mkdir -p "$STAGE_DIR"
git archive --format=tar HEAD > /tmp/gsplatform-release-$$.tar
tar -xf /tmp/gsplatform-release-$$.tar -C "$STAGE_DIR"
rm -f /tmp/gsplatform-release-$$.tar
mv "$STAGE_DIR" "$RELEASE_DIR"
echo "    ✓ Archived commit $COMMIT_HASH into $RELEASE_DIR"

# Metadata written from the SOURCE repo (the release has no .git to query).
echo "$COMMIT_HASH"  > "${RELEASE_DIR}/.git-commit-hash"
echo "$RELEASE_ID"   > "${RELEASE_DIR}/.release-id"
echo "$TIMESTAMP"    > "${RELEASE_DIR}/.deployed-at"
echo "$ENVIRONMENT"  > "${RELEASE_DIR}/.deploy-environment"
echo "$COMMIT_BRANCH" > "${RELEASE_DIR}/.release-branch"
echo "    Metadata written: commit=$COMMIT_HASH, branch=$COMMIT_BRANCH"

# ── 3. Install declared dependencies ────────────────────────────────────────
echo ""
echo "[3] Installing Python dependencies in release venv"
API_VENV="${RELEASE_DIR}/apps/api/.venv"
python3 -m venv "$API_VENV"
"${API_VENV}/bin/pip" install --upgrade pip >/dev/null 2>&1
if ! "${API_VENV}/bin/pip" install -e "${RELEASE_DIR}/apps/api" >/dev/null 2>&1; then
    echo "ERROR: pip install failed — no pre-built-venv fallback exists." >&2
    echo "       A release must be self-contained; aborting." >&2
    exit 1
fi
echo "    ✓ Python venv ready at $API_VENV"

# ── 3b. Reconstruction runtime (torch/gsplat) — FIX-06.1 §A ────────────────
# The GPU worker starts from this SAME venv (gsplatform-celery-gpu.service
# ExecStart = .../apps/api/.venv/bin/celery ... -Q gpu) and training runs via
# `sys.executable -m workers.reconstruction.train_gsplat_script`, which imports
# torch + gsplat.  Install the tracked contract versions, then verify the
# runtime is actually executable (imports + trainer --help + CUDA rasterization)
# before the release is allowed to go live.  Fail-closed.
echo ""
echo "[3b] Installing reconstruction runtime (deploy/requirements-reconstruction.txt)"
RECON_REQS="${RELEASE_DIR}/deploy/requirements-reconstruction.txt"
RECON_VERIFY="${RELEASE_DIR}/deploy/scripts/verify_reconstruction_runtime.py"
if [[ -f "$RECON_REQS" && -f "$RECON_VERIFY" ]]; then
    if ! "${API_VENV}/bin/pip" install -r "$RECON_REQS" >/tmp/gsplatform-recon-install.log 2>&1; then
        echo "ERROR: reconstruction runtime install failed (torch/gsplat) — see /tmp/gsplatform-recon-install.log" >&2
        exit 1
    fi
    if ! (cd "${RELEASE_DIR}" && "${API_VENV}/bin/python" "$RECON_VERIFY") >/tmp/gsplatform-recon-verify.log 2>&1; then
        echo "ERROR: reconstruction runtime verification FAILED (torch/gsplat/CUDA) — see /tmp/gsplatform-recon-verify.log" >&2
        exit 1
    fi
    echo "    ✓ reconstruction runtime installed + verified (torch/gsplat contract)"
else
    echo "ERROR: deploy/requirements-reconstruction.txt or verify_reconstruction_runtime.py missing in release." >&2
    echo "       GPU reconstruction is part of the product; refusing to deploy without the runtime." >&2
    exit 1
fi

# ── 4. Build web frontend (fail-closed) ─────────────────────────────────────
echo ""
echo "[4] Building web frontend"
WEB_DIR="${RELEASE_DIR}/apps/web"
if [[ -d "$WEB_DIR" ]]; then
    cd "$WEB_DIR"
    if ! pnpm install --frozen-lockfile >/tmp/gsplatform-web-install.log 2>&1; then
        echo "ERROR: pnpm install --frozen-lockfile failed — see /tmp/gsplatform-web-install.log" >&2
        exit 1
    fi
    if ! VITE_API_BASE_URL="/api/v1" pnpm build >/tmp/gsplatform-web-build.log 2>&1; then
        echo "ERROR: web build failed — see /tmp/gsplatform-web-build.log" >&2
        exit 1
    fi
    if [[ ! -f "$WEB_DIR/dist/index.html" ]]; then
        echo "ERROR: dist/index.html missing after build" >&2
        exit 1
    fi
    echo "    ✓ Web build complete: $(du -sh "$WEB_DIR/dist" | cut -f1)"
else
    echo "ERROR: apps/web missing in archive (it is tracked) — cannot build the SPA." >&2
    exit 1
fi

# ── 5. Alembic migration (single head + upgrade, fail-closed) ───────────────
echo ""
echo "[5] Alembic migration"
if [[ -d "${RELEASE_DIR}/apps/api/migrations" ]]; then
    cd "${RELEASE_DIR}/apps/api"
    if [[ -z "${GS_DATABASE_URL:-}" ]]; then
        echo "ERROR: GS_DATABASE_URL not set — cannot run migration preflight." >&2
        exit 1
    fi
    HEADS=$("${API_VENV}/bin/python" -m alembic heads 2>/dev/null | grep -cE "^[0-9a-f]{12}" || true)
    if [[ "$HEADS" -ne 1 ]]; then
        echo "ERROR: alembic heads count is ${HEADS} (expected exactly 1) — refusing to migrate." >&2
        exit 1
    fi
    echo "    ✓ single migration head"
    if ! "${API_VENV}/bin/python" -m alembic upgrade head >/tmp/gsplatform-migrate.log 2>&1; then
        echo "ERROR: alembic upgrade head failed — see /tmp/gsplatform-migrate.log" >&2
        exit 1
    fi
    echo "    ✓ alembic upgrade head applied"
else
    echo "ERROR: migrations directory missing in release" >&2
    exit 1
fi
# FIX-06.2.1 §A/§7: the Alembic step above cd's into apps/api; normalize back
# to the release root so every later step (6/6b/7/8/9) runs from a
# deterministic cwd.  (release preflight is itself cwd-independent now, but the
# deploy's own shell should not wander.)
cd "$RELEASE_DIR"

# ── 6. Atomic symlink switch ────────────────────────────────────────────────
echo ""
echo "[6] Atomic symlink: current → release $RELEASE_ID"
SYMLINK_NEXT="${DEPLOY_ROOT}/current.pending.$$"
ln -sfn "$RELEASE_DIR" "$SYMLINK_NEXT"
mv -Tf "$SYMLINK_NEXT" "$PREVIOUS_LINK"
echo "    ✓ current → $RELEASE_DIR"

# ── 6b. Release preflight (FIX-06.2 §21) ─────────────────────────────────
# The now-current release is validated against its own contract (imports,
# celery, systemd ExecStart, torch/gsplat/CUDA, alembic current==head,
# nginx syntax) BEFORE scene-origin sync, service restart and smoke.  This is
# the RELEASE-mode preflight; the HOST-mode preflight runs before this
# script on a fresh host.
echo ""
echo "[6b] Release preflight (preflight.sh --mode release)"
if ! DEPLOY_ROOT="$DEPLOY_ROOT" "${RELEASE_DIR}/deploy/scripts/preflight.sh" \
        --environment "$ENVIRONMENT" --mode release; then
    echo "ERROR: release preflight FAILED on the new current release" >&2
    echo "       Rolling back the symlink and aborting deploy." >&2
    # FIX-06.2.1 §B/§10: rollback_current implements BOTH rollback contracts —
    # upgrade restores the previous release; FIRST DEPLOY (no previous) removes
    # the failed `current` so an unvalidated release NEVER stays current.  The
    # failed release directory is kept for diagnostics.
    if ! rollback_current "$RELEASE_DIR" "$PREV_RELEASE"; then
        echo "       WARNING: rollback refused — current does not resolve to the failed release; manual inspection required." >&2
    fi
    exit 1
fi
echo "    ✓ release preflight passed"

# ── 7. Sync scene-origin tree (fail-closed) ─────────────────────────────────
echo ""
echo "[7] Syncing scene-origin tree (production asset URL tree)"
SCENE_ORIGIN="${GS_SCENE_ORIGIN_ROOT:-${DEPLOY_ROOT}/data/scene-origin}"
mkdir -p "$SCENE_ORIGIN"
if ! "${API_VENV}/bin/python" -c "
import os, sys, uuid
from pathlib import Path
sys.path.insert(0, '${RELEASE_DIR}/apps/api')
os.environ.setdefault('GS_ENV', '${ENVIRONMENT}')
os.environ.setdefault('GS_STORAGE_ROOT', '${GS_STORAGE_ROOT:-/srv/gsplatform-data}')
os.environ.setdefault('GS_SCENE_ORIGIN_ROOT', '$SCENE_ORIGIN')
from app.core.config import settings
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

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
        print(f'    ERROR: published version missing for {slug}: {pub_path}')
        sys.exit(1)
    slug_dir.mkdir(parents=True, exist_ok=True)
    # versions/<ver> → absolute symlink to published version
    ver_link = slug_dir / 'versions' / version_id
    if ver_link.exists() or ver_link.is_symlink():
        if ver_link.is_symlink() and os.path.realpath(str(ver_link)) == str(pub_path.resolve()):
            pass
        else:
            ver_link.unlink()
            ver_link.symlink_to(str(pub_path.resolve()), target_is_directory=True)
    else:
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
"; then
    echo "ERROR: scene-origin sync failed — aborting deploy" >&2
    exit 1
fi

# ── 8. Reload/restart services (fail-closed) ────────────────────────────────
echo ""
echo "[8] Restarting services"
restart_svc() {
    local svc="$1"
    if command -v systemctl >/dev/null 2>&1; then
        sudo systemctl daemon-reload >/dev/null 2>&1 || true
        if ! sudo systemctl restart "$svc" >/tmp/gsplatform-restart-${svc}.log 2>&1; then
            echo "ERROR: restart $svc failed — see /tmp/gsplatform-restart-${svc}.log" >&2
            exit 1
        fi
        echo "    ✓ restarted $svc"
    else
        echo "ERROR: systemctl unavailable — must restart $svc manually; aborting (no partial state)." >&2
        exit 1
    fi
}
restart_svc gsplatform-api
restart_svc gsplatform-celery-cpu
restart_svc gsplatform-celery-gpu
if ! sudo nginx -t >/tmp/gsplatform-nginx-t.log 2>&1; then
    echo "ERROR: nginx -t failed — see /tmp/gsplatform-nginx-t.log" >&2
    exit 1
fi
if ! sudo systemctl reload nginx >/dev/null 2>&1; then
    if ! sudo nginx -s reload >/dev/null 2>&1; then
        echo "ERROR: nginx reload failed" >&2
        exit 1
    fi
fi
echo "    ✓ reloaded nginx"

# ── 9. Smoke test (hard gate) ───────────────────────────────────────────────
echo ""
if [[ "$SKIP_SMOKE" -eq 1 ]]; then
    echo "[9] Smoke test: SKIPPED (--skip-smoke)"
else
    echo "[9] Running smoke_test.sh"
    # Wait for services to stabilize
    sleep 3
    if [[ -x "${RELEASE_DIR}/deploy/scripts/smoke_test.sh" ]]; then
        # Public-scene slug for the smoke: explicit SMOKE_PUBLIC_SCENE_SLUG or
        # a deterministic DB query (PUBLISHED + PUBLIC + not deleted +
        # current_version_id).  FIX-06.1 §C: smoke must exercise a real
        # published scene; if none is eligible this is a FAIL, not a silent skip.
        SMOKE_SCENE="${SMOKE_PUBLIC_SCENE_SLUG:-}"
        if [[ -z "$SMOKE_SCENE" ]]; then
            SMOKE_SCENE=$(GS_ENV="$ENVIRONMENT" RELEASE_API_DIR="${RELEASE_DIR}/apps/api" "${API_VENV}/bin/python" - <<'PY'
import os, sys
sys.path.insert(0, os.environ["RELEASE_API_DIR"])
os.environ.setdefault("GS_ENV", "production")
from app.core.config import settings
from sqlalchemy import create_engine, text

engine = create_engine(settings.database_url, connect_args={"connect_timeout": 5})
with engine.connect() as conn:
    row = conn.execute(text(
        "SELECT slug FROM scenes "
        "WHERE status = 'PUBLISHED' AND visibility = 'PUBLIC' "
        "AND deleted_at IS NULL AND current_version_id IS NOT NULL "
        "ORDER BY updated_at DESC LIMIT 1"
    )).first()
print(row[0] if row else "")
PY
)
        fi
        if [[ -z "$SMOKE_SCENE" ]]; then
            echo "    ✗ No eligible public published scene for smoke (set SMOKE_PUBLIC_SCENE_SLUG or publish one)." >&2
            exit 1
        fi
        # FIX-06.2.1 §C/§17: staging may opt into TLS-insecure smoke EXPLICITLY
        # (self-signed staging certificates) via SMOKE_INSECURE=1.  Production
        # never passes --insecure — the smoke itself rejects it, so production
        # always verifies the real certificate chain and hostname.
        SMOKE_TLS_ARGS=()
        if [[ "$ENVIRONMENT" == "staging" && "${SMOKE_INSECURE:-0}" == "1" ]]; then
            SMOKE_TLS_ARGS=(--insecure)
        fi
        if ! "${RELEASE_DIR}/deploy/scripts/smoke_test.sh" \
            --environment "$ENVIRONMENT" \
            --public-scene "$SMOKE_SCENE" \
            ${SMOKE_BASE_URL:+--base-url "$SMOKE_BASE_URL"} \
            "${SMOKE_TLS_ARGS[@]}"; then
            echo "    ✗ Smoke test FAILED — triggering rollback instructions" >&2
            echo "    ┌──────────────────────────────────────────────────────────┐"
            echo "    │ ROLLBACK:                                                │"
            echo "    │   ./deploy/scripts/rollback.sh --root $DEPLOY_ROOT       │"
            echo "    │                                                          │"
            echo "    │ Previous release: ${PREV_RELEASE:-none}                  │"
            echo "    └──────────────────────────────────────────────────────────┘"
            exit 1
        fi
        echo "    ✓ Smoke test PASSED"
    else
        echo "ERROR: smoke_test.sh not found in release" >&2
        exit 1
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