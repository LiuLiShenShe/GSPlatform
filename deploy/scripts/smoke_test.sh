#!/usr/bin/env bash
# smoke_test.sh — post-deploy verification against the live site.
#
# Usage:
#   ./deploy/scripts/smoke_test.sh --environment staging
#   ./deploy/scripts/smoke_test.sh --environment production --base-url https://gsplatform.example.com
#   ./deploy/scripts/smoke_test.sh --environment staging --base-url https://gsplatform.test --resolve gsplatform.test:443:127.0.0.1 --public-scene test-scene
#
# Verifies:
#   1. HTTPS reachable + redirect from HTTP
#   2. /health/live and /health/ready return 200
#   3. Web SPA serves index.html for / (and SPA routes)
#   4. Public scene manifest served with short Cache-Control
#   5. Streamed SOG Range 206 + Content-Range
#   6. Invalid Range 416
#   7. Security headers present (HSTS, X-Content-Type-Options, CSP)

set -euo pipefail

# ── Args ────────────────────────────────────────────────────────────────────
ENVIRONMENT=""
BASE_URL=""
PUBLIC_SCENE_SLUG=""
RESOLVE_FLAG=""   # repeated: "--resolve host:port:addr --resolve ..."

while [[ $# -gt 0 ]]; do
    case "$1" in
        --environment)   ENVIRONMENT="$2"; shift 2 ;;
        --base-url)      BASE_URL="$2";    shift 2 ;;
        --public-scene)  PUBLIC_SCENE_SLUG="$2"; shift 2 ;;
        --resolve)       RESOLVE_FLAG+=" --resolve $2"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done
if [[ -z "$ENVIRONMENT" ]]; then
    echo "Usage: $0 --environment <staging|production> [--base-url URL] [--resolve host:port:addr] [--public-scene slug]" >&2
    exit 1
fi
[[ -z "$BASE_URL" ]] && BASE_URL="https://${HOSTNAME:-localhost}"

# Helper: all curl calls use $RESOLVE_FLAG for non-public-DNS hosts.
C() { curl -sk $RESOLVE_FLAG "$@"; }

PASS=0; FAIL=0
pass() { echo "  ✓ $1"; ((PASS++)) || true; }
fail() { echo "  ✗ $1"; ((FAIL++)) || true; }

echo "GSPlatform Smoke Test — env=$ENVIRONMENT  base=$BASE_URL"
echo "================================================================================"

# ── 1. HTTPS reachable ─────────────────────────────────────────────────────
echo "[1] HTTPS reachable"
if C -o /dev/null -w '%{http_code}' --max-time 15 "$BASE_URL/" 2>/dev/null | grep -q "^200"; then
    pass "GET $BASE_URL/ → 200"
else
    CODE=$(C -o /dev/null -w '%{http_code}' --max-time 15 "$BASE_URL/" 2>/dev/null || echo "000")
    fail "HTTPS GET $BASE_URL/ → $CODE (expected 200)"
fi

if [[ "$BASE_URL" =~ ^https:// ]]; then
    HTTP_URL="http://${BASE_URL#https://}"
    REDIRECT=$(curl -s $RESOLVE_FLAG -o /dev/null -w '%{http_code}:%{redirect_url}' --max-time 15 "$HTTP_URL" 2>/dev/null || echo "000:")
    HTTP_CODE="${REDIRECT%%:*}"
    if [[ "$HTTP_CODE" == "301" ]]; then
        pass "HTTP → HTTPS redirect (301)"
    else
        fail "HTTP redirect missing (got $REDIRECT)"
    fi
fi

# ── 2. Health endpoints ────────────────────────────────────────────────────
echo ""; echo "[2] Health endpoints"
for ep in /health/live /health/ready; do
    CODE=$(C -o /dev/null -w '%{http_code}' --max-time 15 "$BASE_URL$ep" 2>/dev/null || echo 000)
    [[ "$CODE" == "200" ]] && pass "$ep → 200" || fail "$ep → $CODE"
done

# ── 3. Web SPA ─────────────────────────────────────────────────────────────
echo ""; echo "[3] Web SPA"
for route in "/" "/works" "/upload"; do
    CT=$(C -sI --max-time 15 "$BASE_URL$route" 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type"{print $2}')
    [[ "$CT" == *"text/html"* ]] && pass "SPA $route → text/html" || fail "SPA $route → content-type=$CT"
done

# ── 4. Public scene manifest (short cache) ─────────────────────────────────
echo ""
if [[ -n "$PUBLIC_SCENE_SLUG" ]]; then
    MANIFEST="$BASE_URL/local-scenes/$PUBLIC_SCENE_SLUG/current/manifest.json"
    echo "[4] Public scene manifest ($PUBLIC_SCENE_SLUG)"
    CODE=$(C -o /tmp/gsplatform-manifest.json -w '%{http_code}' --max-time 15 "$MANIFEST" 2>/dev/null || echo 000)
    if [[ "$CODE" == "200" ]]; then
        pass "manifest.json → 200"
        CACHE=$(C -sI --max-time 15 "$MANIFEST" 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')
        [[ "$CACHE" == *"max-age=60"* ]] && pass "Cache-Control short: $CACHE" || fail "Cache-Control: $CACHE"
        python3 -c "import json; json.load(open('/tmp/gsplatform-manifest.json'))" 2>/dev/null && pass "manifest is valid JSON" || fail "manifest not JSON"
    else
        fail "manifest.json → $CODE"
    fi
else
    echo "  ℹ No --public-scene provided — skipping manifest / Range checks."
fi

# ── 5. Streamed SOG Range 206 ─────────────────────────────────────────────
echo ""
if [[ -n "$PUBLIC_SCENE_SLUG" ]]; then
    echo "[5] Range 206 / 416"
    ASSET="$BASE_URL/local-scenes/$PUBLIC_SCENE_SLUG/current/lod-meta.json"
    R206=$(C -o /tmp/gsplatform-range.json -w '%{http_code}' -H 'Range: bytes=0-1023' --max-time 15 "$ASSET" 2>/dev/null || echo 000)
    if [[ "$R206" == "206" ]]; then
        pass "Range bytes=0-1023 → 206"
        CR=$(C -sI -H 'Range: bytes=0-1023' --max-time 15 "$ASSET" 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1)=="content-range"{print $2}')
        [[ -n "$CR" ]] && pass "Content-Range: $CR" || fail "missing Content-Range"
    else
        fail "Range bytes=0-1023 → $R206"
    fi
    R416=$(C -o /dev/null -w '%{http_code}' -H 'Range: bytes=999999999999-' --max-time 15 "$ASSET" 2>/dev/null || echo 000)
    [[ "$R416" == "416" ]] && pass "invalid Range → 416" || fail "invalid Range → $R416"
fi

# ── 6. Security headers ────────────────────────────────────────────────────
echo ""; echo "[6] Security headers"
HDRS=$(C -sI --max-time 15 "$BASE_URL/" 2>/dev/null | tr -d '\r' | tr '[:upper:]' '[:lower:]')
for h in strict-transport-security x-content-type-options content-security-policy x-frame-options referrer-policy; do
    grep -q "^${h}:" <<< "$HDRS" && pass "present: $h" || fail "missing: $h"
done

# ── Summary ────────────────────────────────────────────────────────────────
echo ""; echo "================================================================================"
echo "Smoke: $PASS passed, $FAIL failed  (env=$ENVIRONMENT base=$BASE_URL)"
[[ "$FAIL" -gt 0 ]] && { echo "RESULT: FAIL"; exit 1; }
echo "RESULT: PASS"
