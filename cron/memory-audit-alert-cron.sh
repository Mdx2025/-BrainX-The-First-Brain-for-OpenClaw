#!/usr/bin/env bash
set -euo pipefail

SCRIPT="/home/clawd/.openclaw/skills/brainx/cron/memory-audit.sh"

# shellcheck source=/dev/null
source "$(dirname "$0")/cron-notify.sh"

out="$(bash "$SCRIPT" 2>/tmp/memory-audit-alert-cron.err)" || rc=$?
rc="${rc:-0}"

if [[ "$rc" -eq 0 ]]; then
  exit 0
fi

if [[ "$rc" -ne 0 && -z "${out:-}" ]]; then
  err="$(cat /tmp/memory-audit-alert-cron.err 2>/dev/null || true)"
  send_cron_notify "Memory Audit Alert" "Error ejecutando memory-audit.sh: ${err:0:600}"
  exit 1
fi

result_line="$(grep -E 'RESULT:' <<<"$out" | tail -1)"
active_line="$(grep -E '^Active:' <<<"$out" | tail -1)"
msg="${active_line}"
if [[ -n "$result_line" ]]; then
  msg+=$'\n'
  msg+="$result_line"
fi

send_cron_notify "Memory Audit Alert" "$msg"
exit 1
