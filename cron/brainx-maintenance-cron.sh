#!/usr/bin/env bash
# BrainX Maintenance - daily/weekly maintenance orchestrator.
# Keeps heavy maintenance separate from the near-event review loop.
set -euo pipefail

PATH="/home/clawd/.local/share/pnpm:/home/clawd/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"

JOB_SLUG="${BRAINX_MAINTENANCE_JOB_SLUG:-brainx-maintenance}"
RUN_TS="$(date +%Y%m%d-%H%M%S)"
STATE_DIR="/home/clawd/.openclaw/state/cron/${JOB_SLUG}"
LOG_DIR="/home/clawd/.openclaw/cron/runs"
LOCK_DIR="/home/clawd/.openclaw/state/cron/locks"
PAYLOAD_FILE="${STATE_DIR}/${JOB_SLUG}-${RUN_TS}.json"
LOG_FILE="${LOG_DIR}/${JOB_SLUG}-${RUN_TS}.log"
FORCE_WEEKLY="${BRAINX_MAINTENANCE_FORCE_WEEKLY:-0}"

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
  job: process.env.BRAINX_MAINTENANCE_JOB_SLUG || 'brainx-maintenance',
  mode: 'maintenance',
  reason: 'already_running',
  paths: { payloadFile, logFile },
};
fs.writeFileSync(payloadFile, JSON.stringify(payload, null, 2) + '\n');
console.log(JSON.stringify(payload, null, 2));
NODE
    exit 0
  fi
fi

today_ast="$(TZ=America/Caracas date +%w)"
is_sunday=0
if [ "$today_ast" = "0" ] || [ "$FORCE_WEEKLY" = "1" ]; then
  is_sunday=1
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
    cat "${out_file}" 2>/dev/null || true
    echo ""
  } >>"${LOG_FILE}"
  if [ "$code" -eq 0 ]; then
    if [ "$name" = "daily-core" ] && grep -q 'BRAINX_CLOSEOUT_EVIDENCE: status=partial' "$out_file"; then
      record_step "$name" "partial" "$code" "$out_file" "daily_core_closeout_partial"
    elif [ "$name" = "daily-core" ] && grep -q 'BRAINX_CLOSEOUT_EVIDENCE: status=fail' "$out_file"; then
      record_step "$name" "error" "$code" "$out_file" "daily_core_closeout_fail"
    elif [ "$name" = "daily-core" ] && grep -q 'RESULT: status=fail' "$out_file"; then
      record_step "$name" "partial" "$code" "$out_file" "daily_core_step_failed"
    else
      record_step "$name" "ok" "$code" "$out_file" ""
    fi
  else
    record_step "$name" "error" "$code" "$out_file" ""
  fi
  return 0
}

skip_step() {
  record_step "$1" "skipped" 0 "" "$2"
}

run_step "daily-core" "${BRAINX_MAINTENANCE_DAILY_CORE_TIMEOUT_SECONDS:-2400}" \
  bash /home/clawd/.openclaw/skills/brainx/cron/brainx-daily-core-wrapper.sh

run_step "injection-health" "${BRAINX_MAINTENANCE_INJECTION_HEALTH_TIMEOUT_SECONDS:-600}" \
  env BRAINX_INJECTION_HEALTH_TOP="${BRAINX_INJECTION_HEALTH_TOP:-6}" \
      BRAINX_INJECTION_HEALTH_WARN_TOP="${BRAINX_INJECTION_HEALTH_WARN_TOP:-4}" \
      bash /home/clawd/.openclaw/skills/brainx/cron/brainx-injection-health.sh

if [ "$is_sunday" -eq 1 ]; then
  run_step "cleanup" "${BRAINX_MAINTENANCE_CLEANUP_TIMEOUT_SECONDS:-900}" \
    bash /home/clawd/.openclaw/skills/brainx/cron/brainx-cleanup-cron.sh
  run_step "skill-curator" "${BRAINX_MAINTENANCE_SKILL_CURATOR_TIMEOUT_SECONDS:-900}" \
    bash /home/clawd/.openclaw/skills/brainx/cron/brainx-skill-curator-cron.sh
else
  skip_step "cleanup" "not_sunday"
  skip_step "skill-curator" "not_sunday"
fi

python3 - "$PAYLOAD_FILE" "$LOG_FILE" "$is_sunday" "$FORCE_WEEKLY" "${STEP_NAMES[@]}" -- "${STEP_STATUS[@]}" -- "${STEP_CODES[@]}" -- "${STEP_OUTPUTS[@]}" -- "${STEP_REASONS[@]}" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

payload_file, log_file, is_sunday, force_weekly = sys.argv[1:5]
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
    steps.append({
        "name": name,
        "status": statuses[i] if i < len(statuses) else "unknown",
        "code": int(codes[i]) if i < len(codes) and str(codes[i]).lstrip("-").isdigit() else None,
        "outputFile": outputs[i] if i < len(outputs) and outputs[i] else None,
        "reason": reasons[i] if i < len(reasons) and reasons[i] else None,
    })
errors = [s for s in steps if s["status"] in ("error", "partial")]
payload = {
    "ok": not errors,
    "status": "ok" if not errors else "error",
    "job": os.environ.get("BRAINX_MAINTENANCE_JOB_SLUG", "brainx-maintenance"),
    "mode": "maintenance",
    "isSunday": is_sunday == "1",
    "forceWeekly": force_weekly == "1",
    "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "summary": {
        "total": len(steps),
        "ok": sum(1 for s in steps if s["status"] == "ok"),
        "partial": sum(1 for s in steps if s["status"] == "partial"),
        "skipped": sum(1 for s in steps if s["status"] == "skipped"),
        "errors": len(errors),
    },
    "steps": steps,
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
