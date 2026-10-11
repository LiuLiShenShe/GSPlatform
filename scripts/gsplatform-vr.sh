#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${GS_VR00_ENV_FILE:-$HOME/.local/state/gsplatform-vr00-20261011/runtime.env}"
[[ -f "$ENV_FILE" ]] || { echo 'Missing private VR-00 environment file' >&2; exit 1; }
[[ "$(stat -c %u "$ENV_FILE")" == "$UID" && "$(stat -c %a "$ENV_FILE")" == 600 ]] || {
    echo 'Environment file must be owned by this user with mode 600' >&2; exit 1;
}
set -a
source "$ENV_FILE"
set +a
STATE="${GS_VR00_STATE_DIR:?}"
PYTHON="$ROOT/apps/api/.venv/bin/python"
mkdir -p "$STATE/logs"
exec 9>"$STATE/lifecycle.lock"
flock -x 9
export PYTHONPATH="$ROOT/apps/api:$ROOT"

guard() {
    /usr/bin/python3 - "$STATE/$1.pid" "$2" <<'PY'
import json
import hashlib
import os
import signal
import sys
from pathlib import Path

receipt_path = Path(sys.argv[1])
action = sys.argv[2]
if not receipt_path.exists():
    raise SystemExit(3)
receipt = json.loads(receipt_path.read_text())
process = Path('/proc') / str(receipt['pid'])
try:
    descriptor = os.pidfd_open(receipt['pid'])
except ProcessLookupError:
    receipt_path.unlink()
    raise SystemExit(3)
try:
    fields = (process / 'stat').read_text().split(') ', 1)[1].split()
    if fields[0] == 'Z':
        receipt_path.unlink()
        raise SystemExit(3)
    executable = (process / 'exe').stat()
    if 'executableDevice' in receipt:
        executable_matches = (executable.st_dev, executable.st_ino) == (receipt['executableDevice'], receipt['executableInode'])
    else:
        executable_matches = hashlib.sha256((process / 'cmdline').read_bytes()).hexdigest() == receipt['commandDigest']
    if fields[19] != receipt['startTicks'] or not executable_matches or process.stat().st_uid != os.getuid():
        raise SystemExit('Refusing a foreign or reused PID receipt')
    if action == 'stop':
        signal.pidfd_send_signal(descriptor, signal.SIGTERM)
    else:
        print(receipt['pid'])
finally:
    os.close(descriptor)
PY
}

start_service() {
    local service="$1" directory="$2"
    shift 2
    if guard "$service" status >/dev/null; then
        echo "$service already managed"
        return
    else
        local result=$?
        [[ "$result" == 3 ]] || return "$result"
    fi
    (
        cd "$directory"
        exec setsid nohup "$@" 9>&- >>"$STATE/logs/$service.log" 2>&1 < /dev/null
    ) &
    local process_id=$!
    sleep 1
    "$PYTHON" - "$STATE/$service.pid" "$process_id" <<'PY'
import json
import hashlib
import sys
from pathlib import Path
process_id = int(sys.argv[2])
fields = (Path('/proc') / str(process_id) / 'stat').read_text().split(') ', 1)[1].split()
command_digest = hashlib.sha256((Path('/proc') / str(process_id) / 'cmdline').read_bytes()).hexdigest()
executable = (Path('/proc') / str(process_id) / 'exe').stat()
Path(sys.argv[1]).write_text(json.dumps({'pid': process_id, 'startTicks': fields[19], 'commandDigest': command_digest, 'executableDevice': executable.st_dev, 'executableInode': executable.st_ino}) + '\n')
PY
    guard "$service" status >/dev/null
    echo "$service started"
}

stop_service() {
    local service="$1"
    if guard "$service" stop; then
        for attempt in {1..30}; do
            if guard "$service" status >/dev/null; then
                sleep 1
            else
                local result=$?
                [[ "$result" == 3 ]] || return "$result"
                echo "$service stopped"
                return
            fi
        done
        echo "$service is still draining; not force-killed" >&2
        return 1
    else
        local result=$?
        [[ "$result" == 3 ]] || return "$result"
    fi
}

preflight() {
    [[ "$GS_ENV" == production && "$GS_DEV_IDENTITY_ENABLED" == false && "$GS_SESSION_SECURE_COOKIE" == true ]] || {
        echo 'VR-00 requires real identity and Secure cookies' >&2; return 1;
    }
    [[ ! -e /opt/gsplatform/current ]] || { echo 'Production checkout exists; use its service manager' >&2; return 1; }
    "$PYTHON" - "$STATE/isolation.json" "$ROOT" <<'PY'
import json
import os
import socket
import sys
from pathlib import Path
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from alembic.config import Config
from alembic.script import ScriptDirectory
import redis

state = Path(os.environ['GS_VR00_STATE_DIR']).resolve()
receipt = json.loads(Path(sys.argv[1]).read_text())
address = make_url(os.environ['GS_DATABASE_URL'])
if receipt['environment'] != 'ISOLATED_STAGING' or address.database != receipt['databases'][0] or not address.database.startswith('gsplatform_vr00_'):
    raise SystemExit('Unproven database isolation')
if Path(os.environ['GS_STORAGE_ROOT']).resolve() != state / 'storage':
    raise SystemExit('Unproven storage isolation')
if os.environ['GS_CELERY_BROKER_URL'] != 'redis://127.0.0.1:16384/0':
    raise SystemExit('Unproven broker isolation')
config = Config(str(Path(sys.argv[2]) / 'apps/api/alembic.ini'))
config.set_main_option('script_location', str(Path(sys.argv[2]) / 'apps/api/migrations'))
with create_engine(address).connect() as connection:
    current = connection.execute(text('select version_num from alembic_version')).scalar_one()
if current != ScriptDirectory.from_config(config).get_current_head():
    raise SystemExit('Database is not at the repository head; migration is never automatic')
redis.Redis.from_url(os.environ['GS_CELERY_BROKER_URL']).ping()
from workers.celery_app import celery_app
for node, statistics in (celery_app.control.inspect(timeout=2).stats() or {}).items():
    if not node.startswith(('vr00-publish@', 'vr00-cpu@', 'vr00-gpu@')):
        raise SystemExit('Refusing competing unmanaged workers on the isolated broker')
    service = node.split('@', 1)[0].removeprefix('vr00-')
    worker_receipt = state / (service + '.pid')
    if not worker_receipt.exists() or json.loads(worker_receipt.read_text())['pid'] != statistics['pid']:
        raise SystemExit('Worker ownership receipt is missing or mismatched')
for service, port in (('api', 18001), ('web', 5175), ('proxy', 5174)):
    if (state / (service + '.pid')).exists():
        continue
    with socket.socket() as listener:
        try:
            listener.bind(('127.0.0.1', port))
        except OSError:
            raise SystemExit('Refusing an occupied unmanaged port: ' + str(port))
PY
    "$ROOT/apps/editor/editor.sh" verify >"$STATE/logs/editor-verification.log"
    "$ROOT/apps/editor/editor.sh" health
}

case "${1:-status}" in
    up)
        preflight
        export GS_BUILD_VERSION="$(git -C "$ROOT" rev-parse HEAD)"
        start_service api "$ROOT/apps/api" "$PYTHON" -m uvicorn app.main:app --host 127.0.0.1 --port 18001 --no-access-log
        start_service publish "$ROOT" "$PYTHON" -m celery -A workers.celery_app worker -Q gsplatform --concurrency=1 --loglevel=INFO --hostname=vr00-publish@%h
        start_service cpu "$ROOT" "$PYTHON" -m celery -A workers.celery_app worker -Q cpu --concurrency=1 --loglevel=INFO --hostname=vr00-cpu@%h
        if [[ "${GS_VR00_GPU_ENABLED:-false}" == true ]]; then
            start_service gpu "$ROOT" "$PYTHON" -m celery -A workers.celery_app worker -Q gpu --concurrency=1 --loglevel=INFO --hostname=vr00-gpu@%h
        fi
        start_service maintenance "$ROOT" "$PYTHON" -c 'import os; from workers.celery_app import celery_app; celery_app.conf.beat_schedule={"vr00-recovery":{"task":"tasks.cleanup_expired_uploads","schedule":21600.0,"options":{"queue":"gsplatform"}}}; celery_app.start(["beat","--loglevel=INFO","--schedule",os.environ["GS_VR00_STATE_DIR"]+"/beat-schedule"])'
        start_service web "$ROOT/apps/web" node "$ROOT/apps/web/node_modules/vite/bin/vite.js" --host 127.0.0.1 --port 5175 --strictPort
        sed "s@__SCENE_ORIGIN_ROOT__@$GS_SCENE_ORIGIN_ROOT@g" "$ROOT/deploy/nginx/vr00-staging.conf" > "$STATE/nginx.conf"
        start_service proxy "$ROOT" docker run --rm --pull=never --name gsplatform-vr00-nginx-20261011 --label gsplatform.vr00=20261011 --network host --user "$UID:$(id -g)" --mount "type=bind,src=$STATE/nginx.conf,dst=/etc/nginx/nginx.conf,readonly" --mount "type=bind,src=$STATE,dst=$STATE,readonly" --mount "type=bind,src=$STATE/logs,dst=/logs" --mount type=bind,src=/home/test/gsplatform-data/published,dst=/home/test/gsplatform-data/published,readonly nginx:stable-alpine nginx
        if [[ "${GS_VR00_TUNNEL_ENABLED:-false}" == true ]]; then
            start_service tunnel "$ROOT" cloudflared tunnel --url http://127.0.0.1:5174 --no-autoupdate
        fi
        curl --fail --silent --show-error http://127.0.0.1:18001/health/ready
        echo
        ;;
    down)
        if [[ -f "$STATE/publish.pid" || -f "$STATE/cpu.pid" || -f "$STATE/gpu.pid" ]]; then
            "$PYTHON" - <<'PY'
from workers.celery_app import celery_app
inspection = celery_app.control.inspect(timeout=5)
active = inspection.active()
reserved = inspection.reserved()
if not active or not reserved or any(active.values()) or any(reserved.values()):
    raise SystemExit('Workers unavailable or holding tasks; refusing shutdown')
PY
        fi
        for service in maintenance gpu cpu publish tunnel proxy web api; do stop_service "$service"; done
        echo 'Shared PostgreSQL, Redis, Editor, legacy services and tunnels remain untouched'
        ;;
    status)
        for service in api web proxy publish cpu gpu maintenance tunnel; do
            if process_id="$(guard "$service" status)"; then
                echo "$service MANAGED pid=$process_id"
            else
                result=$?
                [[ "$result" == 3 ]] || exit "$result"
                echo "$service NOT MANAGED"
            fi
        done
        curl --fail --silent --show-error http://127.0.0.1:18001/health/live || true
        echo
        curl --fail --silent --show-error http://127.0.0.1:18001/health/ready || true
        echo
        "$ROOT/apps/editor/editor.sh" health
        ;;
    urls)
        printf 'Local: http://localhost:5174\n'
        printf 'HTTPS: %s\n' "${GS_VR00_HTTPS_URL:-NOT CONFIGURED}"
        for route in upload works xr/test gaussian-editor/; do
            printf '%s/%s\n' "${GS_VR00_HTTPS_URL:-NOT CONFIGURED}" "$route"
        done
        [[ -z "${GS_VR00_SCENE_SLUG:-}" ]] || printf '%s/xr/%s\n' "${GS_VR00_HTTPS_URL:-NOT CONFIGURED}" "$GS_VR00_SCENE_SLUG"
        ;;
    logs)
        for service in api web proxy publish cpu gpu maintenance tunnel editor-verification; do
            [[ ! -f "$STATE/logs/$service.log" ]] || { echo "=== $service ==="; tail -n 25 "$STATE/logs/$service.log"; }
        done
        ;;
    *) echo 'Usage: gsplatform-vr.sh up|status|urls|logs|down' >&2; exit 2 ;;
esac
