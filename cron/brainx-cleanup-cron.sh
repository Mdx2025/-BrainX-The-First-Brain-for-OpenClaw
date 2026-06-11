#!/usr/bin/env bash
# BrainX Cleanup — weekly retention sweep.
#
# Purges old/dup session snapshots and unused trajectories. Idempotent;
# emits noop when there's nothing to clean. Default thresholds:
#   - snapshots: 30d (60d for status='blocked'/'critical')
#   - dedup: same agent+project+date keeps newest
#   - trajectories: 60d if times_used=0 (kept indefinitely if used)
set -uo pipefail

cd /home/clawd/.openclaw/skills/brainx

set -a
# shellcheck disable=SC1091
source /home/clawd/.openclaw/gateway.env
set +a

RUN_TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_DIR="/home/clawd/.openclaw/cron/runs"
STATE_DIR="/home/clawd/.openclaw/state/cron"
LOCK_DIR="${STATE_DIR}/locks"
LOG_FILE="${LOG_DIR}/brainx-cleanup-${RUN_TS}.log"
STATE_FILE="${STATE_DIR}/brainx-cleanup-wrapper.json"
LOCK_FILE="${LOCK_DIR}/brainx-cleanup-wrapper.lock"
MAX_ATTEMPTS="${BRAINX_CLEANUP_ATTEMPTS:-3}"
BACKOFF_SECONDS="${BRAINX_CLEANUP_BACKOFF_SECONDS:-20}"

mkdir -p "$LOG_DIR" "$STATE_DIR" "$LOCK_DIR"

exec 9>"$LOCK_FILE"
if command -v flock >/dev/null 2>&1; then
  if ! flock -n 9; then
    printf '{"ok":true,"status":"noop","reason":"already_running","logFile":"%s"}\n' "$LOG_FILE"
    exit 0
  fi
fi

tmp_out="$(mktemp)"
cleanup_tmp() {
  rm -f "$tmp_out"
}
trap cleanup_tmp EXIT

attempt=1
last_attempt=0
code=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  last_attempt="$attempt"
  echo "### attempt=${attempt}/${MAX_ATTEMPTS} ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$LOG_FILE"
  timeout 180 node scripts/cleanup-snapshots-trajectories.js >"$tmp_out" 2>&1
  code=$?
  cat "$tmp_out" >>"$LOG_FILE"
  echo "" >>"$LOG_FILE"
  if [ "$code" -eq 0 ]; then
    break
  fi
  if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
    sleep "$BACKOFF_SECONDS"
  fi
  attempt=$((attempt + 1))
done

status="ok"
if [ "$code" -ne 0 ]; then
  status="error"
fi

python3 - "$STATE_FILE" "$status" "$code" "$last_attempt" "$LOG_FILE" "$tmp_out" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

state_file, status, code, attempts, log_file, out_file = sys.argv[1:]
text = ""
try:
    with open(out_file, "r", encoding="utf-8") as f:
        text = f.read()
except Exception:
    pass

payload = {
    "job": "brainx-cleanup-wrapper",
    "status": status,
    "code": int(code),
    "attempts": int(attempts),
    "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "logFile": log_file,
    "outputPreview": text[-4000:],
}
tmp = f"{state_file}.tmp.{os.getpid()}"
os.makedirs(os.path.dirname(state_file), exist_ok=True)
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(payload, f, ensure_ascii=False, indent=2)
    f.write("\n")
os.replace(tmp, state_file)
PY

if [ "$status" = "ok" ]; then
  python3 - "$tmp_out" <<'PY'
import json
import sys

text = open(sys.argv[1], "r", encoding="utf-8").read()
decoder = json.JSONDecoder()
for index, char in enumerate(text):
    if char != "{":
        continue
    try:
        payload, _ = decoder.raw_decode(text[index:])
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        raise SystemExit(0)
    except json.JSONDecodeError:
        continue
print(text, end="" if text.endswith("\n") else "\n")
PY
else
  printf '{"ok":false,"status":"error","attempts":%s,"code":%s,"logFile":"%s","tail":%s}\n' \
    "$last_attempt" "$code" "$LOG_FILE" "$(python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()[-1200:]))' < "$tmp_out")"
fi

exit "$code"
