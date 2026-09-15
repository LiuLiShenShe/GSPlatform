#!/usr/bin/env bash
# publish_scene.sh — CLI wrapper around the publish pipeline.
# Usage: ./scripts/publish_scene.sh <upload_id> <scene_id> <job_id>
#
# Requires: venv activated, Redis running, workers process or --local flag.
set -euo pipefail

UPLOAD_ID="${1:?Usage: $0 <upload_id> <scene_id> <job_id>}"
SCENE_ID="${2:?}"
JOB_ID="${3:?}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/api"
source .venv/bin/activate

echo ">>> Dispatching publish_scene task..."
python -c "
from celery import Celery
import os
app = Celery('producer', broker=os.environ.get('GS_CELERY_BROKER_URL', 'redis://localhost:6379/0'))
r = app.send_task('tasks.publish_scene', args=['${UPLOAD_ID}', '${SCENE_ID}', '${JOB_ID}'])
print(f'Task dispatched: {r.id}')
" || { echo "Failed to dispatch task"; exit 1; }

echo ">>> Done. Monitor with: celery -A workers.celery_app inspect active"
