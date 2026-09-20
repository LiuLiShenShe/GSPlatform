#!/usr/bin/env bash
# backup.sh — Phase 09 automated backup: PostgreSQL + published assets + config.
#
# Usage:
#   ./deploy/scripts/backup.sh --environment production
#
# Produces (under BACKUP_ROOT, default /srv/gsplatform-data/backups-local-buffer):
#   <date>/gsplatform-db.sql.gz          (encrypted postgres dump)
#   <date>/published-assets.tar.zst      (published scene versions)
#   <date>/backup-manifest.json          (checksums, sizes, metadata)
#
# Phase 09 checklist I:
#   - database auto-backup, encrypted, checksummed
#   - published assets + config consistent backup
#   - copy to ANOTHER failure domain (push step; see runbook)
#
# Requirements:
#   - `pg_dump` reachable (or set PG_DUMP_CMD, e.g. docker wrapper)
#   - openssl (encryption), zstd or tar+gzip
#   - GPG optional for stronger encryption: set BACKUP_GPG_RECIPIENT

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

ENVIRONMENT=""
BACKUP_ROOT="${BACKUP_ROOT:-/srv/gsplatform-data/backups-local-buffer}"
GS_STORAGE_ROOT="${GS_STORAGE_ROOT:-/srv/gsplatform-data}"
DATE_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${BACKUP_ROOT}/${DATE_STAMP}"

# Default pg_dump command; allow override e.g.
#   PG_DUMP_CMD="docker run --rm --network host postgres:16-alpine pg_dump"
PG_DUMP_CMD="${PG_DUMP_CMD:-pg_dump}"
# Encryption: use AES-256-CBC with a keyfile (BACKUP_KEYFILE) or GPG recipient.
BACKUP_KEYFILE="${BACKUP_KEYFILE:-/etc/gsplatform/backup.key}"
BACKUP_GPG_RECIPIENT="${BACKUP_GPG_RECIPIENT:-}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --environment) ENVIRONMENT="$2"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done
if [[ -z "$ENVIRONMENT" ]]; then
    echo "Usage: $0 --environment <staging|production>" >&2
    exit 1
fi

echo "GSPlatform backup.sh — $(date -u)  env=$ENVIRONMENT"
echo "  backup_dir: $BACKUP_DIR"
mkdir -p "$BACKUP_DIR"

# ── 1. PostgreSQL dump + encrypt ───────────────────────────────────────────
echo ""
echo "[1] PostgreSQL dump"
DB_FILE="${BACKUP_DIR}/gsplatform-db.sql"
ENC_FILE="${BACKUP_DIR}/gsplatform-db.sql.enc"
if $PG_DUMP_CMD -Fc "$GS_DATABASE_URL" > "$DB_FILE" 2>/tmp/gs-backup-pgdump.log \
   || $PG_DUMP_CMD -Fc "${GS_DATABASE_URL}" > "$DB_FILE" 2>/dev/null; then
    echo "    ✓ pg_dump → $(du -h "$DB_FILE" | cut -f1)"
elif $PG_DUMP_CMD -h 127.0.0.1 -U "${DB_USER:-postgres}" "${DB_NAME:-gsplatform}" -Fc > "$DB_FILE" 2>/tmp/gs-backup-pgdump.log; then
    echo "    ✓ pg_dump (legacy args) → $(du -h "$DB_FILE" | cut -f1)"
else
    echo "    ✗ pg_dump failed:" >&2
    cat /tmp/gs-backup-pgdump.log >&2
    exit 1
fi

# Encrypt: GPG (if recipient) else openssl AES-256-CBC keyfile
if [[ -n "$BACKUP_GPG_RECIPIENT" ]]; then
    if command -v gpg >/dev/null 2>&1; then
        gpg --batch --yes --encrypt --recipient "$BACKUP_GPG_RECIPIENT" \
            --output "$ENC_FILE" "$DB_FILE" && rm -f "$DB_FILE"
        echo "    ✓ encrypted with GPG (recipient $BACKUP_GPG_RECIPIENT)"
    else
        echo "    ✗ BACKUP_GPG_RECIPIENT set but gpg not installed" >&2
        exit 1
    fi
elif [[ -f "$BACKUP_KEYFILE" ]]; then
    openssl enc -aes-256-cbc -pbkdf2 -salt \
        -in "$DB_FILE" -out "$ENC_FILE" -pass file:"$BACKUP_KEYFILE" \
        && rm -f "$DB_FILE"
    echo "    ✓ encrypted with openssl AES-256-CBC"
else
    echo "    ⚠ no encryption configured (no keyfile / GPG) — storing plaintext dump."
    ENC_FILE="$DB_FILE"
fi
sha256sum "$ENC_FILE" | tee "${ENC_FILE}.sha256" >/dev/null
echo "    ✓ checksum: $(cut -c1-16 ${ENC_FILE}.sha256)…"

# ── 2. Published assets ────────────────────────────────────────────────────
echo ""
echo "[2] Published assets"
PUBLISHED_DIR="${GS_STORAGE_ROOT}/published"
if [[ -d "$PUBLISHED_DIR" ]]; then
    if command -v tar >/dev/null && command -v zstd >/dev/null 2>&1; then
        tar --exclude='*.tmp' -C "$GS_STORAGE_ROOT" -cf - published \
            | zstd -3 -o "${BACKUP_DIR}/published-assets.tar.zst" 2>/dev/null
        ASSET_FILE="${BACKUP_DIR}/published-assets.tar.zst"
    else
        tar -C "$GS_STORAGE_ROOT" -czf "${BACKUP_DIR}/published-assets.tar.gz" published
        ASSET_FILE="${BACKUP_DIR}/published-assets.tar.gz"
    fi
    echo "    ✓ published → $(du -h "$ASSET_FILE" | cut -f1)"
    sha256sum "$ASSET_FILE" | tee "${ASSET_FILE}.sha256" >/dev/null
else
    echo "    ⚠ $PUBLISHED_DIR missing — no published assets to back up"
fi

# ── 3. Config snapshot ─────────────────────────────────────────────────────
echo ""
echo "[3] Config snapshot"
CONFIG_DIR="${CONFIG_DIR:-/etc/gsplatform}"
if [[ -d "$CONFIG_DIR" ]]; then
    tar -C / -czf "${BACKUP_DIR}/config.tar.gz" "etc/gsplatform" 2>/dev/null \
        && echo "    ✓ config → config.tar.gz" || echo "    ⚠ config snapshot failed"
else
    echo "    ℹ no /etc/gsplatform — config snapshot skipped"
fi

# ── 4. Manifest ────────────────────────────────────────────────────────────
echo ""
echo "[4] Backup manifest"
MANIFEST="${BACKUP_DIR}/backup-manifest.json"
{
    echo "{"
    echo "  \"date\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
    echo "  \"environment\": \"$ENVIRONMENT\","
    echo "  \"host\": \"$(hostname)\","
    echo "  \"files\": {"
    FIRST=1
    for f in "${BACKUP_DIR}"/*; do
        [[ -f "$f" ]] || continue
        SZ=$(stat -c %s "$f" 2>/dev/null || echo 0)
        if [[ "$FIRST" -eq 1 ]]; then FIRST=0; else echo ","; fi
        printf '    "%s": {"size": %s}' "$(basename "$f")" "$SZ"
    done
    echo ""
    echo "  }"
    echo "}"
} > "$MANIFEST"
echo "    ✓ $MANIFEST"

# ── 5. Cross-failure-domain push (documented; enabled via BACKUP_PUSH_CMD) ─
echo ""
echo "[5] Off-host copy"
if [[ -n "${BACKUP_PUSH_CMD:-}" ]]; then
    if eval "$BACKUP_PUSH_CMD" "$BACKUP_DIR" >/tmp/gs-backup-push.log 2>&1; then
        echo "    ✓ pushed to failure domain: $BACKUP_PUSH_CMD"
    else
        echo "    ✗ push failed:" >&2
        cat /tmp/gs-backup-push.log >&2
        exit 1
    fi
else
    echo "    ℹ BACKUP_PUSH_CMD not set — local backup only."
    echo "       Configure e.g.:  BACKUP_PUSH_CMD='rsync -a --delete /srv/gsplatform-data/backups-local-buffer/ offsite-host:/backups/'"
fi

# ── Retention ─────────────────────────────────────────────────────────────
echo ""
echo "[6] Retention (keep last $BACKUP_KEEP_N days)"
BACKUP_KEEP_N="${BACKUP_KEEP_N:-14}"
find "$BACKUP_ROOT" -maxdepth 1 -type d -name '20*' -mtime "+${BACKUP_KEEP_N}" -print0 \
    | xargs -0 -r rm -rf
echo "    ✓ retention: keeping ${BACKUP_KEEP_N} days"

echo ""
echo "================================================================================"
echo "Backup complete: $BACKUP_DIR"
du -sh "$BACKUP_DIR"
echo "================================================================================"
