#!/usr/bin/env bash
# check_nginx_site.sh — validate the shipped Nginx site file standalone.
#
# `nginx -t` alone only proves the HOST's main config is valid; it says nothing
# about the site file this release ships.  This helper assembles a complete,
# throw-away nginx prefix (main config + mime types + the release's site and
# its includes + a temporary self-signed cert) and runs `nginx -t` against it.
#
# The host's real main config path is never assumed: callers that know it can
# run `nginx -t -c <path>` themselves (preflight does when NGINX_MAIN_CONF is
# set).  This script is the fallback that always works in an isolated prefix.
#
# Usage: check_nginx_site.sh <path/to/gsplatform.conf>
# Exit:  0 valid · 1 invalid · 2 cannot validate in this environment
set -euo pipefail

SITE="${1:?usage: check_nginx_site.sh <site.conf>}"
[[ -f "$SITE" ]] || { echo "site file missing: $SITE" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
NGINX_DIR="$(cd "$(dirname "$SITE")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/etc/nginx/gsplatform" "$TMP/logs" "$TMP/client-body" \
         "$TMP/proxy" "$TMP/fastcgi" "$TMP/uwsgi" "$TMP/scgi" "$TMP/certs" \
         "$TMP/root" "$TMP/origin" "$TMP/acme"

# Render deployment placeholders + point TLS at a throw-away cert.
sed -e 's#<DOMAIN>#localhost.test#g' \
    -e "s#/etc/letsencrypt/live/[^/]*/fullchain.pem#$TMP/certs/fullchain.pem#g" \
    -e "s#/etc/letsencrypt/live/[^/]*/privkey.pem#$TMP/certs/privkey.pem#g" \
    -e "s#/opt/gsplatform/current/apps/web/dist#$TMP/root#g" \
    -e "s#/srv/gsplatform-data/scene-origin/#$TMP/origin/#g" \
    -e "s#/var/www/html#$TMP/acme#g" \
    -e "s#/var/log/nginx/#$TMP/logs/#g" \
    "$SITE" > "$TMP/etc/nginx/gsplatform/gsplatform.conf"

for include in proxy-params.conf scenes-streaming.conf; do
    if [[ -f "$NGINX_DIR/$include" ]]; then
        cp "$NGINX_DIR/$include" "$TMP/etc/nginx/gsplatform/$include"
    elif [[ -f "$REPO_ROOT/deploy/nginx/$include" ]]; then
        cp "$REPO_ROOT/deploy/nginx/$include" "$TMP/etc/nginx/gsplatform/$include"
    fi
done
# Absolute include paths inside the site file must resolve inside the prefix.
sed -i "s#/etc/nginx/gsplatform/#$TMP/etc/nginx/gsplatform/#g" \
    "$TMP/etc/nginx/gsplatform/gsplatform.conf"

if command -v openssl >/dev/null 2>&1; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
        -keyout "$TMP/certs/privkey.pem" -out "$TMP/certs/fullchain.pem" \
        -subj "/CN=localhost.test" >/dev/null 2>&1
else
    echo "openssl unavailable — cannot generate a throw-away certificate" >&2
    exit 2
fi

cat > "$TMP/etc/nginx/nginx.conf" <<EOF
worker_processes 1;
pid $TMP/nginx.pid;
error_log $TMP/logs/error.log warn;
events { worker_connections 64; }
http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    access_log off;
    client_body_temp_path $TMP/client-body;
    proxy_temp_path $TMP/proxy;
    fastcgi_temp_path $TMP/fastcgi;
    uwsgi_temp_path $TMP/uwsgi;
    scgi_temp_path $TMP/scgi;
    include $TMP/etc/nginx/gsplatform/gsplatform.conf;
}
EOF

# Prefer a native nginx (real binary), otherwise run the official image with
# the prefix mounted.  The `nginx` on PATH may be a container wrapper script
# whose mounts do not include $TMP, so detect that case explicitly.
NGINX_BIN="$(command -v nginx || true)"
if [[ -n "$NGINX_BIN" ]] && ! head -c 2 "$NGINX_BIN" 2>/dev/null | grep -q '#!'; then
    exec nginx -t -p "$TMP" -c "$TMP/etc/nginx/nginx.conf"
fi
if command -v docker >/dev/null 2>&1; then
    # Mount the prefix at the SAME absolute path inside the container so every
    # rewritten path (includes, certs, roots, logs) resolves identically.
    docker run --rm -v "$TMP:$TMP" nginx:alpine \
        nginx -t -p "$TMP" -c "$TMP/etc/nginx/nginx.conf"
    exit $?
fi
echo "no native nginx and no docker available — cannot validate the site file here" >&2
exit 2
