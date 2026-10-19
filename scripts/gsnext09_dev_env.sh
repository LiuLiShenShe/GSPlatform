#!/usr/bin/env bash
# GS-NEXT-09 — start an ISOLATED dev-identity API + vite for e2e browser testing.
#
# Uses a SEPARATE database (gsplatform_vr00_dev_20261011) created by
# scripts/gsnext09_seed_fix02.py --dev so nothing in the runtime staging DB
# is mutated by dev-identity writes. Listens only on 127.0.0.1.
set -euo pipefail

ROOT=/fj/GSPlatform
STATE="$HOME/.local/state/gsplatform-vr00-20261011"
DEVPORT="${1:-18099}"
WEBPORT="${2:-5199}"
DEVDBSLUG=gsplatform_vr00_tests_20261011

# reuse the staging DB password without echoing it
DBPASS=$(grep '^GS_DATABASE_URL=' "$STATE/runtime.env" | head -1 | sed -E 's#^GS_DATABASE_URL=postgresql\+psycopg2://[^:]+:([^@]+)@.*$#\1#')
if [ -z "$DBPASS" ] || [ "${#DBPASS}" -lt 20 ]; then
  echo "failed to extract DB password from runtime.env" >&2; exit 1
fi

export GS_ENV=development
export GS_DEV_IDENTITY_ENABLED=true
export GS_SESSION_SECURE_COOKIE=false
export GS_SESSION_SAME_SITE=lax
export GS_STORAGE_ROOT="$STATE/dev-storage"
export GS_SCENE_ORIGIN_ROOT="$STATE/scene-origin"
export GS_REDIS_URL=redis://127.0.0.1:16384/7
export GS_CELERY_BROKER_URL=redis://127.0.0.1:16384/7
export GS_CELERY_RESULT_BACKEND=redis://127.0.0.1:16384/8
export GS_RATE_LIMIT_BACKEND=memory
export GS_EDITOR_ENABLED=true
export GS_EDITOR_PROXY_TARGET=http://127.0.0.1:18031
export GS_EDITOR_BUILD_MANIFEST="$ROOT/apps/editor/.cache/dist/editor-build.json"
export GS_DEFAULT_UPLOAD_VISIBILITY=PRIVATE
export GS_DATABASE_URL="postgresql+psycopg2://gsplatform_vr00_20261011:${DBPASS}@127.0.0.1:5432/${DEVDBSLUG}"
export PYTHONPATH="$ROOT/apps/api:$ROOT"

mkdir -p "$STATE/dev-storage"

if ! curl -s -m 3 "http://127.0.0.1:${DEVPORT}/health/ready" >/dev/null 2>&1; then
  echo "starting dev-identity API on 127.0.0.1:${DEVPORT} (db=${DEVDBSLUG})"
  (cd "$ROOT/apps/api" && setsid nohup "$ROOT/apps/api/.venv/bin/python" -m uvicorn app.main:app \
      --host 127.0.0.1 --port "$DEVPORT" --no-access-log \
      >"$STATE/logs/gsnext09-dev-api.log" 2>&1 < /dev/null &)
  for _ in $(seq 1 40); do
    curl -s -m 3 "http://127.0.0.1:${DEVPORT}/health/ready" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi
curl -s -m 5 "http://127.0.0.1:${DEVPORT}/health/ready"; echo

if ! curl -s -m 3 -o /dev/null "http://127.0.0.1:${WEBPORT}/" 2>/dev/null; then
  echo "starting vite on 127.0.0.1:${WEBPORT}"
  (cd "$ROOT/apps/web" && GS_API_PROXY_TARGET="http://127.0.0.1:${DEVPORT}" \
      setsid nohup node "$ROOT/apps/web/node_modules/vite/bin/vite.js" \
      --host 127.0.0.1 --port "$WEBPORT" --strictPort \
      >"$STATE/logs/gsnext09-dev-web.log" 2>&1 < /dev/null &)
  for _ in $(seq 1 60); do
    curl -s -m 3 -o /dev/null "http://127.0.0.1:${WEBPORT}/" 2>/dev/null && break
    sleep 0.5
  done
fi
echo "vite http://127.0.0.1:${WEBPORT}/"
