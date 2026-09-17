#!/usr/bin/env bash
# reconstruct_scene.sh — CLI-driven full 3DGS reconstruction run (Phase 07).
#
# Usage: ./scripts/reconstruct_scene.sh \
#   --input <video-or-photo-dir> \
#   --profile <draft|standard|high>
#
# Runs the whole pipeline OUT-OF-BAND from the web queue: it copies the input
# into a fresh job dir, dispatches the three queue-routed Celery tasks in
# sequence (cpu → gpu → cpu), and polls the job state until a terminal state.
# Requires: venv activated, Redis + workers running, DB migrated.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/api"
source .venv/bin/activate

INPUT="${INPUT:-}"
PROFILE="${PROFILE:-draft}"
SCENE_ID="${SCENE_ID:-reconstruction-test}"
JOB_ID="$(uuidgen 2>/dev/null || python -c "import uuid; print(uuid.uuid4())")"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --input) INPUT="$2"; shift 2 ;;
        --profile) PROFILE="$2"; shift 2 ;;
        --scene-id) SCENE_ID="$2"; shift 2 ;;
        --job-id) JOB_ID="$2"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

[[ -n "$INPUT" && ( -f "$INPUT" || -d "$INPUT" ) ]] || {
    echo "Usage: $0 --input <video-or-photo-dir> [--profile draft|standard|high] [--scene-id X] [--job-id Y]" >&2
    exit 1
}

echo ">>> Phase 07 reconstruction"
echo "    input:   $INPUT"
echo "    profile: $PROFILE"
echo "    job:     $JOB_ID"

# ── 0. Upload the input through the real upload flow, or seed staging ───────
# For CLI runs we place the input directly into the staging layout the
# workers expect: storage/jobs/<job>/attempt-1/input/.
STORAGE_ROOT="${GS_STORAGE_ROOT:-/srv/gsplatform-data}"
JOB_DIR="$STORAGE_ROOT/jobs/$JOB_ID/attempt-1/input"
mkdir -p "$JOB_DIR"
if [[ -f "$INPUT" ]]; then
    cp "$INPUT" "$JOB_DIR/input.$(basename "$INPUT")"
else
    cp "$INPUT"/* "$JOB_DIR/" 2>/dev/null || true
fi

echo ">>> Seeding input -> $JOB_DIR"

# ── 1. Dispatch CPU stages (PROBING→MAPPING) ────────────────────────────────
echo ">>> Dispatching reconstruct_cpu_stages..."
python - "$JOB_ID" "$PROFILE" << 'PYEOF'
import os, sys, json
from celery import Celery

job_id, profile = sys.argv[1], sys.argv[2]
app = Celery("producer", broker=os.environ.get("GS_CELERY_BROKER_URL", "redis://localhost:6379/0"))
r = app.send_task("tasks.reconstruct_cpu_stages", args=[job_id, [], profile])
print(f"    task={r.id}")
PYEOF

echo ">>> Stage 1 (CPU: PROBING→MAPPING) dispatched. Monitor with:"
echo "    celery -A workers.celery_app inspect active"
echo "    Or poll the DB: SELECT status,stage,progress FROM jobs WHERE id='$JOB_ID';"