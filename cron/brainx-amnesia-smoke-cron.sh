#!/usr/bin/env bash
# BrainX Amnesia Smoke - hourly lightweight recall canary.
set -euo pipefail

PATH="/home/clawd/.local/share/pnpm:/home/clawd/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"

set -a
# shellcheck disable=SC1091
source /home/clawd/.openclaw/gateway.env
set +a

JOB_SLUG="${BRAINX_AMNESIA_SMOKE_JOB_SLUG:-brainx-amnesia-smoke}"
LOCK_DIR="/home/clawd/.openclaw/state/cron/locks"
mkdir -p "$LOCK_DIR"

exec 9>"${LOCK_DIR}/${JOB_SLUG}.lock"
if command -v flock >/dev/null 2>&1; then
  if ! flock -n 9; then
    printf '{"ok":true,"status":"noop","job":"%s","mode":"amnesia-smoke","reason":"already_running"}\n' "$JOB_SLUG"
    exit 0
  fi
fi

node /home/clawd/.openclaw/skills/brainx/scripts/review-loop-guardrails.js \
  --mode amnesia-smoke \
  --hours "${BRAINX_AMNESIA_SMOKE_HOURS:-1}" \
  --amnesia-hours "${BRAINX_AMNESIA_SMOKE_LOOKBACK_HOURS:-6}" \
  --limit "${BRAINX_AMNESIA_SMOKE_LIMIT:-50}" \
  --alert-after "${BRAINX_AMNESIA_SMOKE_ALERT_AFTER:-2}" \
  --state-file "${BRAINX_AMNESIA_SMOKE_STATE_FILE:-/home/clawd/.openclaw/state/cron/brainx-amnesia-smoke/state.json}" \
  --json
