#!/usr/bin/env bash
# BrainX Nightly Memory Loop
# --------------------------
# Consolidates cross-workspace daily memory, appends the deterministic daily
# closeout, and reserves an explicit guarded phase for Memory Dreaming Promotion.
set -euo pipefail

PATH="/home/clawd/.local/share/pnpm:/home/clawd/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"

if [ -f /home/clawd/.openclaw/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /home/clawd/.openclaw/.env
  set +a
elif [ -f /home/clawd/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /home/clawd/.env
  set +a
fi

export TZ="${TZ:-America/Port_of_Spain}"

JOB_SLUG="${BRAINX_NIGHTLY_MEMORY_JOB_SLUG:-brainx-nightly-memory-loop}"
RUN_TS="$(date +%Y%m%d-%H%M%S)"
STATE_DIR="/home/clawd/.openclaw/state/cron/${JOB_SLUG}"
LOG_DIR="/home/clawd/.openclaw/cron/runs"
LOCK_DIR="/home/clawd/.openclaw/state/cron/locks"
PAYLOAD_FILE="${STATE_DIR}/${JOB_SLUG}-${RUN_TS}.json"
LOG_FILE="${LOG_DIR}/${JOB_SLUG}-${RUN_TS}.log"
DRY_RUN="${BRAINX_NIGHTLY_MEMORY_DRY_RUN:-0}"
ENABLE_DREAMING="${BRAINX_NIGHTLY_MEMORY_ENABLE_DREAMING:-0}"

mkdir -p "$STATE_DIR" "$LOG_DIR" "$LOCK_DIR"

exec 9>"${LOCK_DIR}/${JOB_SLUG}.lock"
if command -v flock >/dev/null 2>&1; then
  if ! flock -n 9; then
    node - "$PAYLOAD_FILE" "$LOG_FILE" <<'NODE'
const fs = require('fs');
const [payloadFile, logFile] = process.argv.slice(2);
const payload = {
  ok: true,
  status: 'noop',
  job: process.env.BRAINX_NIGHTLY_MEMORY_JOB_SLUG || 'brainx-nightly-memory-loop',
  mode: 'nightly-memory',
  reason: 'already_running',
  summary: { total: 0, ok: 0, skipped: 0, errors: 0 },
  steps: [],
  shouldNotify: false,
  paths: { payloadFile, logFile },
};
fs.writeFileSync(payloadFile, JSON.stringify(payload, null, 2) + '\n');
console.log(JSON.stringify(payload, null, 2));
NODE
    exit 0
  fi
fi

declare -a STEP_NAMES=()
declare -a STEP_STATUS=()
declare -a STEP_CODES=()
declare -a STEP_OUTPUTS=()
declare -a STEP_REASONS=()

record_step() {
  STEP_NAMES+=("$1")
  STEP_STATUS+=("$2")
  STEP_CODES+=("$3")
  STEP_OUTPUTS+=("$4")
  STEP_REASONS+=("$5")
}

run_step() {
  local name="$1"
  local timeout_seconds="$2"
  local out_file="${STATE_DIR}/${JOB_SLUG}-${RUN_TS}.${name}.out"
  shift 2

  if [ "$DRY_RUN" = "1" ]; then
    {
      echo "### step=${name} dry_run=1 timeout=${timeout_seconds}s"
      printf 'command:'
      printf ' %q' "$@"
      printf '\n'
    } >"${out_file}"
    record_step "$name" "skipped" 0 "$out_file" "dry_run"
    return 0
  fi

  set +e
  {
    echo "### step=${name} ts=$(date -Is) timeout=${timeout_seconds}s"
    timeout "${timeout_seconds}" "$@"
    echo "### step=${name} completed ts=$(date -Is)"
  } >"${out_file}" 2>>"${LOG_FILE}"
  local code=$?
  set -e

  {
    echo ""
    echo "# ${name} exit=${code} output=${out_file}"
    sed -n '1,220p' "${out_file}" 2>/dev/null || true
    echo ""
  } >>"${LOG_FILE}"

  if [ "$code" -eq 0 ]; then
    record_step "$name" "ok" "$code" "$out_file" ""
  else
    record_step "$name" "error" "$code" "$out_file" ""
  fi
  return 0
}

skip_step() {
  record_step "$1" "skipped" 0 "" "$2"
}

run_step "cross-workspace-consolidate" "${BRAINX_NIGHTLY_MEMORY_CONSOLIDATE_TIMEOUT_SECONDS:-180}" \
  bash /home/clawd/.openclaw/skills/brainx/cron/memory-daily-consolidate-cron.sh

if [ "${STEP_STATUS[0]:-error}" = "error" ]; then
  skip_step "daily-closeout" "consolidate_failed"
else
  run_step "daily-closeout" "${BRAINX_NIGHTLY_MEMORY_CLOSEOUT_TIMEOUT_SECONDS:-180}" \
    bash /home/clawd/.openclaw/skills/brainx/cron/memory-daily-closeout-cron.sh
fi

if [ "$ENABLE_DREAMING" = "1" ]; then
  # Keep this phase explicit and guarded. The current OpenClaw Memory Dreaming
  # Promotion is runtime-managed by memory-core, so this loop does not execute it
  # until a dedicated deterministic wrapper exists.
  skip_step "dreaming-promotion" "guarded_runtime_managed_phase_disabled"
else
  skip_step "dreaming-promotion" "disabled_by_env"
fi

python3 - "$PAYLOAD_FILE" "$LOG_FILE" "$DRY_RUN" "$ENABLE_DREAMING" "${STEP_NAMES[@]}" -- "${STEP_STATUS[@]}" -- "${STEP_CODES[@]}" -- "${STEP_OUTPUTS[@]}" -- "${STEP_REASONS[@]}" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

payload_file, log_file, dry_run, enable_dreaming = sys.argv[1:5]
parts = []
cur = []
for value in sys.argv[5:]:
    if value == "--":
        parts.append(cur)
        cur = []
    else:
        cur.append(value)
parts.append(cur)
names, statuses, codes, outputs, reasons = (parts + [[]] * 5)[:5]

steps = []
for i, name in enumerate(names):
    code = None
    if i < len(codes) and str(codes[i]).lstrip("-").isdigit():
        code = int(codes[i])
    steps.append({
        "name": name,
        "status": statuses[i] if i < len(statuses) else "unknown",
        "code": code,
        "outputFile": outputs[i] if i < len(outputs) and outputs[i] else None,
        "reason": reasons[i] if i < len(reasons) and reasons[i] else None,
    })

errors = [s for s in steps if s["status"] == "error"]
payload = {
    "ok": not errors,
    "status": "ok" if not errors else "error",
    "job": os.environ.get("BRAINX_NIGHTLY_MEMORY_JOB_SLUG", "brainx-nightly-memory-loop"),
    "mode": "nightly-memory",
    "dryRun": dry_run == "1",
    "dreamingPromotionEnabled": enable_dreaming == "1",
    "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "summary": {
        "total": len(steps),
        "ok": sum(1 for s in steps if s["status"] == "ok"),
        "skipped": sum(1 for s in steps if s["status"] == "skipped"),
        "errors": len(errors),
    },
    "steps": steps,
    "shouldNotify": bool(errors),
    "paths": {
        "payloadFile": payload_file,
        "logFile": log_file,
    },
}

os.makedirs(os.path.dirname(payload_file), exist_ok=True)
with open(payload_file, "w", encoding="utf-8") as f:
    json.dump(payload, f, ensure_ascii=False, indent=2)
    f.write("\n")
print(json.dumps(payload, ensure_ascii=False, indent=2))
raise SystemExit(0 if payload["ok"] else 1)
PY
