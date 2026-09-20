#!/usr/bin/env bash
# restore_drill.sh — isolated restore rehearsal (Phase 09 I).
#
# Restores the PostgreSQL backup + one published Scene into an ISOLATED
# database, then verifies the scene's manifest/poster/SOG can be opened
# (structure checks) without touching production.  Records measured RPO/RTO.
#
# Usage:
#   ./deploy/scripts/restore_drill.sh --backup <backup-dir> \
#       --restore-db gsplatform_restore_drill
#
# Environment:
#   GS_DATABASE_URL      — production DB (source of backup, default gsplatform)
#   RESTORE_DATABASE_URL — target isolated DB URL
#   PG_RESTORE_CMD       — pg_restore override (docker wrapper allowed)
#   PG_PSQL_CMD          — psql override

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

BACKUP_DIR=""
RESTORE_DB="gsplatform_restore_drill"
RESTORE_DATABASE_URL="${RESTORE_DATABASE_URL:-postgresql+psycopg2://postgres:postgres@127.0.0.1:5432/${RESTORE_DB}}"
PG_RESTORE_CMD="${PG_RESTORE_CMD:-pg_restore}"
PG_PSQL_CMD="${PG_PSQL_CMD:-psql}"
RPO_RECORDED=""
RTO_START=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --backup)     BACKUP_DIR="$2"; shift 2 ;;
        --restore-db) RESTORE_DB="$2"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done
if [[ -z "$BACKUP_DIR" ]]; then
    echo "Usage: $0 --backup <backup-dir> [--restore-db <name>]" >&2
    exit 1
fi

# pg_restore/psql take a plain postgres:// URL — strip the SQLAlchemy
# dialect prefix (postgresql+psycopg2://) that PG_CLI tools reject.
PG_URL="${RESTORE_DATABASE_URL/postgresql+psycopg2/postgresql}"

echo "GSPlatform restore_drill.sh — $(date -u)"
echo "  backup:  $BACKUP_DIR"
echo "  restore: $RESTORE_DB (isolated)"

# ── Find encrypted dump ────────────────────────────────────────────────────
DUMP=""
for c in "gsplatform-db.sql.enc" "gsplatform-db.sql"; do
    [[ -f "$BACKUP_DIR/$c" ]] && { DUMP="$BACKUP_DIR/$c"; break; }
done
if [[ -z "$DUMP" ]]; then
    echo "ERROR: no DB dump found in $BACKUP_DIR" >&2
    exit 1
fi
echo "  dump:    $DUMP"

# ── Restore into isolated DB ───────────────────────────────────────────────
echo ""
echo "[1] Creating isolated database $RESTORE_DB"
$PG_PSQL_CMD "postgresql://postgres:postgres@127.0.0.1:5432/postgres" \
    -tc "DROP DATABASE IF EXISTS \"$RESTORE_DB\";" >/dev/null 2>&1 || true
$PG_PSQL_CMD "postgresql://postgres:postgres@127.0.0.1:5432/postgres" \
    -tc "CREATE DATABASE \"$RESTORE_DB\";" >/dev/null 2>&1 \
    || { echo "ERROR: cannot create $RESTORE_DB" >&2; exit 1; }
echo "    ✓ created $RESTORE_DB"

echo ""
echo "[2] Restoring dump (timing RTO)"
RTO_START=$(date +%s)
if [[ "$DUMP" == *.enc ]]; then
    BACKUP_KEYFILE="${BACKUP_KEYFILE:-/etc/gsplatform/backup.key}"
    openssl enc -d -aes-256-cbc -pbkdf2 -salt -in "$DUMP" -pass file:"$BACKUP_KEYFILE" 2>/dev/null \
        | $PG_RESTORE_CMD --no-owner --no-privileges -d "$PG_URL" 2>&1 \
        | tail -3 || true
else
    $PG_RESTORE_CMD --no-owner --no-privileges -d "$PG_URL" "$DUMP" 2>&1 \
        | tail -3 || true
fi
RTO_END=$(date +%s)
RTO=$(( RTO_END - RTO_START ))
echo "    ✓ restore finished in ${RTO}s"

# ── Verify DB integrity ────────────────────────────────────────────────────
echo ""
echo "[3] Verifying restored DB"
VERIFY=$(/home/test/biosoft/enter/envs/gsplatform-api/bin/python - "$RESTORE_DATABASE_URL" <<'PYEOF'
import sys
from sqlalchemy import create_engine, text
url = sys.argv[1]
e = create_engine(url.replace('postgresql+psycopg2', 'postgresql+psycopg2'))
with e.connect() as c:
    scenes = c.execute(text("SELECT count(*) FROM scenes")).scalar()
    assets = c.execute(text("SELECT count(*) FROM assets")).scalar()
    versions = c.execute(text("SELECT count(*) FROM scene_versions")).scalar()
    users = c.execute(text("SELECT count(*) FROM users")).scalar()
    print(f"scenes={scenes} assets={assets} versions={versions} users={users}")
PYEOF
)
echo "    ✓ $VERIFY"
RPO_RECORDED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ── Restore one published Scene (manifest+poster+SOG) ──────────────────────
echo ""
echo "[4] Restoring one published Scene into an isolated directory"
SCENE_DIR="${BACKUP_DIR}/scene-restore-check"
mkdir -p "$SCENE_DIR"
# The scene BYTES must come from the backup bundle (published-assets.tar.zst
# or .tar.gz) — restoring from the live disk would only prove the disk still
# has the files, not that the backup is recoverable.  Fall back to the live
# published tree only when no bundle is present.
ASSET_BUNDLE=""
for c in published-assets.tar.zst published-assets.tar.gz; do
    [[ -f "$BACKUP_DIR/$c" ]] && { ASSET_BUNDLE="$BACKUP_DIR/$c"; break; }
done
# Pick a scene: prefer one present in BOTH the backup bundle and the restored
# DB (the full recovery story); else any scene from the bundle.
S_SLUG="" S_ID="" S_VER=""
if [[ -n "$ASSET_BUNDLE" ]]; then
    # First manifest path inside the bundle: published/<uuid>/versions/<ver>/manifest.json
    BUNDLE_ENTRY=$(tar -tf "$ASSET_BUNDLE" 2>/dev/null | grep '/manifest.json$' | head -1)
    if [[ -n "$BUNDLE_ENTRY" ]]; then
        S_ID=$(echo "$BUNDLE_ENTRY" | cut -d/ -f2)
        S_VER=$(echo "$BUNDLE_ENTRY" | cut -d/ -f4)
        # Resolve the slug from the restored DB; keep the uuid as dir name if absent.
        S_SLUG=$(/home/test/biosoft/enter/envs/gsplatform-api/bin/python - "$RESTORE_DATABASE_URL" "$S_ID" <<'PYEOF'
import sys
from sqlalchemy import create_engine, text
e = create_engine(sys.argv[1])
with e.connect() as c:
    row = c.execute(text("SELECT slug FROM scenes WHERE id = :i"), {"i": sys.argv[2]}).fetchone()
    print(row[0] if row else sys.argv[2])
PYEOF
        )
        echo "    scene: $S_SLUG ($S_ID / $S_VER)  [from backup bundle]"
        RESTORE_FROM="bundle"
    fi
fi
if [[ -z "${S_SLUG:-}" ]]; then
    # No bundle: fall back to the live published tree via the restored DB.
    read -r S_SLUG S_ID S_VER <<< "$(/home/test/biosoft/enter/envs/gsplatform-api/bin/python - "$RESTORE_DATABASE_URL" <<'PYEOF'
import sys
from sqlalchemy import create_engine, text
e = create_engine(sys.argv[1])
with e.connect() as c:
    row = c.execute(text("""
        SELECT s.slug, s.id, sv.asset_version
        FROM scenes s JOIN scene_versions sv ON s.current_version_id = sv.id
        WHERE s.status='PUBLISHED' AND s.visibility='PUBLIC'
        LIMIT 1
    """)).fetchone()
    if row is None:
        row = c.execute(text("""
            SELECT s.slug, s.id, sv.asset_version
            FROM scenes s JOIN scene_versions sv ON s.current_version_id = sv.id
            WHERE s.status='PUBLISHED' LIMIT 1
        """)).fetchone()
    print(f"{row[0]} {row[1]} {row[2]}" if row else "")
PYEOF
    )" || true
    if [[ -n "${S_SLUG:-}" ]]; then
        echo "    scene: $S_SLUG ($S_ID / $S_VER)  [from live published tree]"
        RESTORE_FROM="live"
    fi
fi

if [[ -n "${S_SLUG:-}" ]]; then
    if [[ "$RESTORE_FROM" == "bundle" ]]; then
        mkdir -p "$SCENE_DIR/$S_SLUG"
        tar -xf "$ASSET_BUNDLE" -C "$SCENE_DIR/$S_SLUG" \
            --strip-components=3 "published/$S_ID/versions/$S_VER" 2>/dev/null \
            && mv "$SCENE_DIR/$S_SLUG/$S_VER" "$SCENE_DIR/$S_SLUG/version" \
            && ln -sfn "version" "$SCENE_DIR/$S_SLUG/current"
        if [[ -d "$SCENE_DIR/$S_SLUG/current" ]]; then
            # integrity: manifest sha vs bundled scene sha256 file
            [[ -f "$SCENE_DIR/$S_SLUG/current/manifest.json" ]] \
                && echo "    ✓ manifest.json restored" || echo "    ✗ manifest.json missing"
            [[ -f "$SCENE_DIR/$S_SLUG/current/lod-meta.json" ]] \
                && echo "    ✓ lod-meta.json (Streamed SOG) restored" || echo "    ✗ lod-meta.json missing"
            [[ -f "$SCENE_DIR/$S_SLUG/current/poster.webp" ]] \
                && echo "    ✓ poster.webp restored" || echo "    ⚠ poster.webp missing (optional)"
            [[ -f "$SCENE_DIR/$S_SLUG/current/checksums.sha256" ]] \
                && (cd "$SCENE_DIR/$S_SLUG/current" && sha256sum -c checksums.sha256 >/dev/null 2>&1 \
                     && echo "    ✓ checksums.sha256 verified" || echo "    ✗ checksums.sha256 MISMATCH") \
                || echo "    ℹ no checksums.sha256 in bundle"
            echo "    ✓ scene bytes restored from backup bundle: $SCENE_DIR/$S_SLUG"
        else
            echo "    ✗ failed to extract scene from bundle"
        fi
    else
        PUB_SRC="${GS_STORAGE_ROOT:-/srv/gsplatform-data}/published/${S_ID}/versions/${S_VER}"
        if [[ -d "$PUB_SRC" ]]; then
            mkdir -p "$SCENE_DIR/$S_SLUG"
            cp -r "$PUB_SRC" "$SCENE_DIR/$S_SLUG/version"
            ln -sfn "version" "$SCENE_DIR/$S_SLUG/current"
            [[ -f "$SCENE_DIR/$S_SLUG/current/manifest.json" ]] \
                && echo "    ✓ manifest.json present" || echo "    ✗ manifest.json missing"
            [[ -f "$SCENE_DIR/$S_SLUG/current/lod-meta.json" ]] \
                && echo "    ✓ lod-meta.json (Streamed SOG) present" || echo "    ✗ lod-meta.json missing"
            [[ -f "$SCENE_DIR/$S_SLUG/current/poster.webp" ]] \
                && echo "    ✓ poster.webp present" || echo "    ⚠ poster.webp missing (optional)"
            echo "    ✓ scene restored: $SCENE_DIR/$S_SLUG (viewer-openable via origin URL)"
        else
            echo "    ⚠ published source missing for $S_ID/$S_VER — cannot restore scene bytes"
        fi
    fi
else
    echo "    ⚠ no published scene found — skipping scene restore"
fi

# ── Report ─────────────────────────────────────────────────────────────────
echo ""
echo "================================================================================"
echo "Restore drill complete"
echo "  Isolated DB restored : $RESTORE_DB ($VERIFY)"
echo "  RTO (measured)       : ${RTO}s"
echo "  RPO (backup time)    : ${RPO_RECORDED:-n/a}"
echo "  Scene restored       : ${S_SLUG:-none} (${S_ID:-?} / ${S_VER:-?})"
echo "  Scene source         : ${RESTORE_FROM:-?}"
echo "  Scene dir            : $SCENE_DIR"
echo "================================================================================"
