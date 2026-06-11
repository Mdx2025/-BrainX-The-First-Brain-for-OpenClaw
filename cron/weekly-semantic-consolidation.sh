#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DAY_UTC="${BRAINX_CONSOLIDATION_WEEKDAY_UTC:-0}"
TODAY_UTC="$(date -u +%w)"
FORCE=0

if [[ "${1:-}" == "--force" ]]; then
  FORCE=1
  shift
fi

if [[ "$FORCE" -ne 1 && "$TODAY_UTC" != "$RUN_DAY_UTC" ]]; then
  printf '{"ok":true,"skipped":true,"reason":"weekly_only","today_utc":%s,"run_day_utc":%s}\n' "$TODAY_UTC" "$RUN_DAY_UTC"
  exit 0
fi

cd "$ROOT"
exec ./brainx consolidate \
  --json \
  --limit "${BRAINX_CONSOLIDATION_LIMIT:-25}" \
  --min-age-days "${BRAINX_CONSOLIDATION_MIN_AGE_DAYS:-7}" \
  --max-seeds "${BRAINX_CONSOLIDATION_MAX_SEEDS:-600}" \
  --min-similarity "${BRAINX_CONSOLIDATION_MIN_SIMILARITY:-0.82}" \
  "$@"
