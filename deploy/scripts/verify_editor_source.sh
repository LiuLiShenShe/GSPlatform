#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d /tmp/gsplatform-editor-verify-XXXXXX)"
PORT="${GS_EDITOR_GATE_PORT:-18131}"
cleanup() {
    if [[ -f "$WORK/runtime/editor.pid" ]]; then
        "$WORK/source/apps/editor/editor.sh" stop --runtime "$WORK/runtime"
    fi
    if [[ "${GS_EDITOR_GATE_KEEP:-0}" != 1 ]]; then rm -rf -- "$WORK"; fi
}
trap cleanup EXIT
git -C "$ROOT" archive HEAD | tar -x -C "$WORK" --one-top-level=source
ARGS=(build --cache "$WORK/cache")
if [[ -n "${GS_EDITOR_UPSTREAM_CLONE:-}" ]]; then ARGS+=(--local-source "$GS_EDITOR_UPSTREAM_CLONE"); fi
"$WORK/source/apps/editor/editor.sh" "${ARGS[@]}"
"$WORK/source/apps/editor/editor.sh" verify --cache "$WORK/cache"
"$WORK/source/apps/editor/editor.sh" start --cache "$WORK/cache" --runtime "$WORK/runtime" --port "$PORT"
"$WORK/source/apps/editor/editor.sh" health --port "$PORT"
echo "EDITOR_SOURCE_GATE=PASS; upstream build, license, checksums, static resources and startup verified"
echo "BROWSER_EDIT_GATE=SEPARATE; follow apps/editor/README.md with real WebGPU and Gaussian input"
echo "workdir=$WORK"
