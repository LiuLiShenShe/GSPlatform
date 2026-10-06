#!/usr/bin/env bash
# smoke_test.sh — post-deploy verification against the live site.
#
# Usage:
#   ./deploy/scripts/smoke_test.sh --environment staging
#   ./deploy/scripts/smoke_test.sh --environment production --base-url https://gsplatform.example.com
#   ./deploy/scripts/smoke_test.sh --environment staging --base-url https://gsplatform.test --resolve gsplatform.test:443:127.0.0.1 --public-scene test-scene
#   ./deploy/scripts/smoke_test.sh --environment staging --base-url https://localhost:9443 --insecure
#
# --insecure: staging/local diagnostic only (self-signed / temporary certs);
#             REJECTED in production (production verifies the real TLS chain
#             + hostname — FIX-06.2.1 §C/§17/§18).
#
# Verifies:
#   1. HTTPS reachable + redirect from HTTP
#   2. /health/live and /health/ready return 200
#   3. Web SPA serves index.html for / (and SPA routes)
#   4. Public scene manifest: current/* no-cache; versions/<ver>/* immutable,
#      versioned entry bytes reachable (entryUrl parsed via smoke_manifest.py)
#   5. Streamed SOG Range 206 + Content-Range
#   6. Invalid Range 416
#   7. Security headers present (HSTS, X-Content-Type-Options, CSP)
#
# FIX-06.1 §C: when --public-scene is provided, an invalid/missing
# stream.entryUrl is a FAIL (not a skip) — the versioned checks must run.
#
# FIX-06.2.1 §C: TLS is verified by DEFAULT (no -k/--insecure).  A production
# smoke against a broken/expired/mismatched/untrusted certificate must FAIL
# (curl exits non-zero).  --insecure (-k) is an explicit STAGING/LOCAL
# diagnostic opt-in only and is REJECTED in production.
#
# FIX-06.2 §3-§9: all *scene asset* checks (current manifest, version manifest,
# version entry, Range 206, Range 416) use a real GET via the g()/hdr() helper,
# capturing status + headers + body in one request.  The asset API is GET-only,
# so HEAD/curl -I would test a surface the product does not have.  HEAD is used
# only for the SPA routes + root security headers (static Nginx files, where
# HEAD is legitimate and not a scene asset).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PARSE_MANIFEST="$SCRIPT_DIR/smoke_manifest.py"

# ── Args ────────────────────────────────────────────────────────────────────
ENVIRONMENT=""
BASE_URL=""
PUBLIC_SCENE_SLUG=""
INSECURE=0          # FIX-06.2.1 §C: strict TLS by default
RESOLVE_ARGS=()     # array of --resolve host:port:addr (no word-splitting)

while [[ $# -gt 0 ]]; do
    case "$1" in
        --environment)   ENVIRONMENT="$2"; shift 2 ;;
        --base-url)      BASE_URL="$2";    shift 2 ;;
        --public-scene)  PUBLIC_SCENE_SLUG="$2"; shift 2 ;;
        --resolve)       RESOLVE_ARGS+=(--resolve "$2"); shift 2 ;;
        --insecure)      INSECURE=1; shift ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done
if [[ -z "$ENVIRONMENT" ]]; then
    echo "Usage: $0 --environment <staging|production> [--base-url URL] [--resolve host:port:addr] [--public-scene slug] [--insecure]" >&2
    echo "  --insecure: staging/local diagnostic ONLY (self-signed certs). FORBIDDEN in production" >&2
    exit 1
fi
# FIX-06.2.1 §18: never let a production acceptance bypass certificate checks.
if [[ "$ENVIRONMENT" == "production" && "$INSECURE" -eq 1 ]]; then
    echo "ERROR: --insecure is forbidden in production — production smoke MUST verify the real TLS certificate chain and hostname." >&2
    echo "       For an internal CA, install the CA into the system trust store (or use --cacert in a future option)." >&2
    exit 1
fi
[[ -z "$BASE_URL" ]] && BASE_URL="https://${HOSTNAME:-localhost}"

# TLS posture: no -k by default; -k only for explicit --insecure (staging/local).
CURL_TLS_ARGS=()
[[ "$INSECURE" -eq 1 ]] && CURL_TLS_ARGS=(-k)

# Helper: all curl calls share the strict-TLS posture + resolve args.
C() { curl -sS "${CURL_TLS_ARGS[@]}" "${RESOLVE_ARGS[@]}" "$@"; }

# ── Asset GET helper (FIX-06.2 §3-§9) ─────────────────────────────────────
# Scene assets are GET-only (the FastAPI route has no HEAD surface — a HEAD
# request would test something the product does not have and never exercise
# the X-Accel→Nginx body path).  Every asset check below is therefore a REAL
# GET that captures status + response headers + body in ONE request, never
# `curl -I` / `--head` / `-sI`.
ASSET_TMP="$(mktemp -d /tmp/gsplatform-smoke.XXXXXX)"
trap 'rm -rf "$ASSET_TMP"' EXIT
ASSET_HDRS="$ASSET_TMP/hdrs"

# g <url> <body-file-or-/dev/null> [extra curl args...] → prints HTTP status.
# Writes response headers to $ASSET_HDRS so callers read them back via hdr().
g() {
    local url="$1" body="$2"
    shift 2
    C -D "$ASSET_HDRS" -o "$body" -w '%{http_code}' --max-time 15 "$@" "$url" 2>/dev/null || echo 000
}
# hdr <name> → value of a response header from the LAST g() call (lowercase match).
hdr() {
    tr -d '\r' < "$ASSET_HDRS" | awk -F': ' -v n="$1" \
        'tolower($1)==tolower(n){v=$0; sub(/^[^:]*: */, "", v); print v}'
}

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
    REDIRECT=$(C -o /dev/null -w '%{http_code}:%{redirect_url}' --max-time 15 "$HTTP_URL" 2>/dev/null || echo "000:")
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

# ── 4. Public scene manifest (cache semantics per FIX-05C/FIX-05C.1) ────────
# FIX-01: scene bytes are NO LONGER served from a public /local-scenes/ alias.
# The smoke test now goes through the authorized API asset endpoint exactly
# like the viewer does (FastAPI policy + Nginx X-Accel internal redirect).
#
# Cache contract (FIX-05C.1): current/* → no-cache (mutable re-pointable);
# versions/<ver>/* → immutable (content-addressed).  `current/manifest.json`
# MUST NOT carry max-age=60 — that was the historical bug the regression
# suite locks.
echo ""
if [[ -n "$PUBLIC_SCENE_SLUG" ]]; then
    MANIFEST="$BASE_URL/api/v1/scenes/$PUBLIC_SCENE_SLUG/assets/current/manifest.json"
    echo "[4] Public scene manifest ($PUBLIC_SCENE_SLUG)"
    # ONE real GET: status + Cache-Control header + body from the same response.
    CODE=$(g "$MANIFEST" /tmp/gsplatform-manifest.json)
    if [[ "$CODE" == "200" ]]; then
        pass "GET current/manifest.json → 200"
        CACHE=$(hdr "cache-control")
        if [[ "$CACHE" == "public, no-cache" ]]; then
            pass "current/manifest Cache-Control → public, no-cache ($CACHE)"
        else
            fail "current/manifest Cache-Control should be 'public, no-cache', got: $CACHE"
        fi
        python3 -c "import json; json.load(open('/tmp/gsplatform-manifest.json'))" 2>/dev/null && pass "manifest is valid JSON" || fail "manifest not JSON"
        # Parse stream.entryUrl with the shared parser — two stable machine
        # lines: version path, then the REAL entry filename the manifest names
        # (never re-hardcode lod-meta.json — FIX-06.2 §7).
        ENTRY_INFO=$(python3 "$PARSE_MANIFEST" --manifest /tmp/gsplatform-manifest.json 2>/dev/null) || true
        VER_PATH=$(printf '%s\n' "$ENTRY_INFO" | sed -n '1p')
        ENTRY_FILE=$(printf '%s\n' "$ENTRY_INFO" | sed -n '2p')
        if [[ -z "$VER_PATH" || -z "$ENTRY_FILE" ]]; then
            fail "stream.entryUrl invalid/missing — manifest must contain stream.entryUrl=versions/<ver>/<file> (got $(python3 -c "import json;print(repr(json.load(open('/tmp/gsplatform-manifest.json')).get('stream',{}).get('entryUrl','')))" 2>/dev/null))"
        else
            # Versioned manifest → immutable: real GET, status + header together.
            VMAN="$BASE_URL/api/v1/scenes/$PUBLIC_SCENE_SLUG/assets/$VER_PATH/manifest.json"
            VCODE=$(g "$VMAN" /dev/null)
            VCACHE=$(hdr "cache-control")
            if [[ "$VCODE" == "200" && "$VCACHE" == "public, max-age=31536000, immutable" ]]; then
                pass "GET versions/<ver>/manifest.json → 200 + immutable ($VCACHE)"
            elif [[ "$VCODE" == "200" ]]; then
                fail "versions manifest → 200 but cache=$VCACHE (want 'public, max-age=31536000, immutable')"
            else
                fail "versions manifest → $VCODE (want 200 + immutable)"
            fi
            # Versioned ENTRY: fetch the REAL file named by stream.entryUrl.
            VENTRY="$BASE_URL/api/v1/scenes/$PUBLIC_SCENE_SLUG/assets/$VER_PATH/$ENTRY_FILE"
            VENTRY_CODE=$(g "$VENTRY" /dev/null)
            if [[ "$VENTRY_CODE" == "200" ]]; then
                pass "GET $VER_PATH/$ENTRY_FILE → 200"
            else
                fail "GET $VER_PATH/$ENTRY_FILE → $VENTRY_CODE (want 200)"
            fi
        fi
    else
        fail "GET current/manifest.json → $CODE"
    fi
else
    echo "  ℹ No --public-scene provided — skipping manifest / Range checks."
fi

# ── 5. Streamed SOG Range 206 / 416 (real GET, never HEAD) ────────────────
echo ""
if [[ -n "$PUBLIC_SCENE_SLUG" ]]; then
    echo "[5] Range 206 / 416"
    ASSET="$BASE_URL/api/v1/scenes/$PUBLIC_SCENE_SLUG/assets/current/lod-meta.json"
    R206=$(g "$ASSET" /tmp/gsplatform-range.bin -H 'Range: bytes=0-1023')
    if [[ "$R206" == "206" ]]; then
        pass "GET Range bytes=0-1023 → 206"
        CR=$(hdr "content-range")
        [[ -n "$CR" ]] && pass "Content-Range: $CR" || fail "missing Content-Range"
        AR=$(hdr "accept-ranges")
        if [[ -n "$AR" ]]; then
            pass "Accept-Ranges: $AR"
        fi
        SIZE=$(wc -c < /tmp/gsplatform-range.bin 2>/dev/null | tr -d ' ' || echo 0)
        if [[ "$SIZE" -gt 0 ]]; then
            pass "Range response body length = $SIZE bytes (> 0)"
        else
            fail "Range response body is empty (want 1..1024 bytes)"
        fi
        if [[ "$SIZE" -le 1024 ]]; then
            pass "Range response body ≤ 1024 bytes"
        else
            fail "Range response body $SIZE > 1024 bytes"
        fi
    else
        fail "GET Range bytes=0-1023 → $R206"
    fi
    R416=$(g "$ASSET" /dev/null -H 'Range: bytes=999999999999-')
    if [[ "$R416" == "416" ]]; then
        pass "GET invalid Range → 416"
    else
        fail "GET invalid Range → $R416 (want 416)"
    fi
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
