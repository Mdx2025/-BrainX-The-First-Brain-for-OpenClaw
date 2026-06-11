#!/usr/bin/env bash
set -euo pipefail

SCRIPT="/home/clawd/.openclaw/skills/brainx/cron/memory-enforcer.sh"

# shellcheck source=/dev/null
source "$(dirname "$0")/cron-notify.sh"

out="$(bash "$SCRIPT" 2>/tmp/memory-enforcer-cron.err)" || {
  err="$(cat /tmp/memory-enforcer-cron.err 2>/dev/null || true)"
  send_cron_notify "Memory Enforcer" "Error ejecutando memory-enforcer.sh: ${err:0:600}"
  exit 1
}

enforced="$(grep -Eo 'Enforced: [0-9]+' <<<"$out" | awk '{print $2}' | tail -1)"
errors="$(grep -Eo 'Errors: [0-9]+' <<<"$out" | awk '{print $2}' | tail -1)"

enforced="${enforced:-0}"
errors="${errors:-0}"

if [[ "$errors" -gt 0 ]]; then
  send_cron_notify "Memory Enforcer" "enforced=${enforced}, errors=${errors}"
  exit 1
fi

if [[ "$enforced" -gt 0 ]]; then
  send_cron_notify "Memory Enforcer" "enforced=${enforced}, errors=${errors}"
fi
