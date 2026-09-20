#!/usr/bin/env bash
# rollback.sh — flip current symlink back to the previous release.
#
# Usage:
#   ./deploy/scripts/rollback.sh --root /opt/gsplatform
#   ./deploy/scripts/rollback.sh --root /opt/gsplatform --to 20260917-01
#
# Behavior:
#   - If --to is given, roll back to that specific release.
#   - Otherwise use the release recorded in DEPLOY_ROOT/.previous_release
#     (written by deploy_release.sh).
#   - If no previous release is known, fail loudly (never guess).
#   - After switching the symlink, restart services + reload nginx.
#   - DB note: this flips the *application*; database rollback is a separate,
#     deliberate operation (see BACKUP_RESTORE_RUNBOOK.md).  We do NOT run
#     `alembic downgrade` here — destructive DB changes need a human decision.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/gsplatform}"
TARGET_RELEASE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --root) DEPLOY_ROOT="$2"; shift 2 ;;
        --to)   TARGET_RELEASE="$2"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

CURRENT_LINK="${DEPLOY_ROOT}/current"
CURRENT_RELEASE=$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo "")

echo "GSPlatform rollback.sh — $(date -u)"
echo "  deploy_root: $DEPLOY_ROOT"
echo "  current:     $CURRENT_RELEASE"

if [[ -z "$CURRENT_RELEASE" ]]; then
    echo "ERROR: no current release found at $CURRENT_LINK" >&2
    exit 1
fi

# Decide target
if [[ -n "$TARGET_RELEASE" ]]; then
    TARGET_DIR="${DEPLOY_ROOT}/releases/${TARGET_RELEASE}"
    if [[ ! -d "$TARGET_DIR" ]]; then
        echo "ERROR: target release dir does not exist: $TARGET_DIR" >&2
        exit 1
    fi
else
    TARGET_DIR=""
    if [[ -f "${DEPLOY_ROOT}/.previous_release" ]]; then
        TARGET_DIR=$(cat "${DEPLOY_ROOT}/.previous_release")
    fi
    if [[ -z "$TARGET_DIR" || ! -d "$TARGET_DIR" ]]; then
        echo "ERROR: no previous release recorded and no --to given." >&2
        echo "       Refusing to guess.  Pick a release explicitly:" >&2
        ls -1 "${DEPLOY_ROOT}/releases" 2>/dev/null | sed 's/^/         /' >&2
        exit 1
    fi
fi

if [[ "$TARGET_DIR" == "$CURRENT_RELEASE" ]]; then
    echo "Target equals current release; nothing to do."
    exit 0
fi

echo "  target:      $TARGET_DIR"
echo ""
echo "[1] Switching symlink: current → $(basename "$TARGET_DIR")"
SYMLINK_NEXT="${DEPLOY_ROOT}/current.rollback.$$"
ln -sfn "$TARGET_DIR" "$SYMLINK_NEXT"
mv -Tf "$SYMLINK_NEXT" "$CURRENT_LINK"
echo "    ✓ current now → $TARGET_DIR"

echo ""
echo "[2] Recording rollback event"
echo "$CURRENT_RELEASE" > "${DEPLOY_ROOT}/.rollback-from"
echo "$TARGET_DIR"      > "${DEPLOY_ROOT}/.rollback-to"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${DEPLOY_ROOT}/.rollback-at"

echo ""
echo "[3] Restarting services"
restart_svc() {
    local svc="$1"
    if command -v systemctl >/dev/null 2>&1; then
        sudo systemctl restart "$svc" 2>/dev/null && echo "    ✓ restarted $svc" || echo "    ⚠ restart $svc failed"
    else
        echo "    ℹ systemctl unavailable — restart $svc manually: sudo systemctl restart $svc"
    fi
}
restart_svc gsplatform-api
restart_svc gsplatform-celery-cpu
restart_svc gsplatform-celery-gpu
sudo systemctl reload nginx 2>/dev/null && echo "    ✓ reloaded nginx" || \
    sudo nginx -s reload 2>/dev/null && echo "    ✓ reloaded nginx" || \
    echo "    ⚠ nginx reload failed — check: nginx -t"

echo ""
echo "[4] Post-rollback smoke (best-effort)"
if [[ -x "${TARGET_DIR}/deploy/scripts/smoke_test.sh" ]]; then
    "${TARGET_DIR}/deploy/scripts/smoke_test.sh" --environment production 2>/dev/null \
        && echo "    ✓ Smoke PASSED after rollback" \
        || echo "    ✗ Smoke FAILED after rollback — inspect immediately (see INCIDENT_RUNBOOK)"
else
    echo "    ℹ no smoke_test.sh in target release — skipped"
fi

echo ""
echo "================================================================================"
echo "Rollback complete: $(basename "$CURRENT_RELEASE") → $(basename "$TARGET_DIR")"
echo "Previous (now) : $CURRENT_RELEASE"
echo "================================================================================"
