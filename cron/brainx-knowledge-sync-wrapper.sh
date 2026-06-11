#!/usr/bin/env bash
set -euo pipefail

cd /home/clawd/.openclaw/skills/brainx

attempt=1
last_attempt=0
max_attempts="${BRAINX_KNOWLEDGE_SYNC_ATTEMPTS:-3}"
backoff_seconds="${BRAINX_KNOWLEDGE_SYNC_BACKOFF_SECONDS:-15}"
tmp_out="$(mktemp)"
trap 'rm -f "$tmp_out"' EXIT

while [ "$attempt" -le "$max_attempts" ]; do
  last_attempt="$attempt"
  if ./brainx knowledge-sync --json >"$tmp_out" 2>&1; then
    cat "$tmp_out"
    exit 0
  fi
  code=$?
  if [ "$attempt" -lt "$max_attempts" ]; then
    sleep "$backoff_seconds"
  fi
  attempt=$((attempt + 1))
done

python3 - "$last_attempt" "$code" "$tmp_out" <<'PY'
import json
import sys

attempts, code, path = sys.argv[1:]
try:
    text = open(path, "r", encoding="utf-8").read()
except Exception:
    text = ""
print(json.dumps({
    "status": "error",
    "step": "knowledge-sync",
    "attempts": int(attempts),
    "code": int(code),
    "message": text[-2000:],
}, ensure_ascii=False, indent=2))
PY
exit "$code"
