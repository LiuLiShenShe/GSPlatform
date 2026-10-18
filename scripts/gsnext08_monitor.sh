#!/usr/bin/env bash
# GS-NEXT-08 resource timeline. Read-only sampling; never signals processes.
# Usage: gsnext08_monitor.sh <out.jsonl> <interval_seconds> [duration_seconds]
set -u
OUT="$1"; INTERVAL="${2:-3}"; DURATION="${3:-0}"
START=$(date +%s)
while :; do
  TS=$(date +%s)
  LOAD=$(cut -d' ' -f1-3 /proc/loadavg)
  MEM=$(awk '/MemAvailable|MemTotal|SwapFree|SwapTotal/{printf "%s=%s ", $1, $2}' /proc/meminfo)
  GPU=$(nvidia-smi --query-gpu=index,utilization.gpu,memory.used --format=csv,noheader 2>/dev/null | tr '\n' ';')
  COMPUTE=$(nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader 2>/dev/null | tr '\n' '|')
  echo "{\"ts\": $TS, \"load\": \"$LOAD\", \"mem\": \"$MEM\", \"gpu\": \"$GPU\", \"compute\": \"$COMPUTE\"}" >> "$OUT"
  sleep "$INTERVAL"
  if [ "$DURATION" -gt 0 ] && [ $(( $(date +%s) - START )) -ge "$DURATION" ]; then break; fi
done
