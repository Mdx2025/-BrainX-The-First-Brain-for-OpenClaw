#!/usr/bin/env bash
# BrainX Session Snapshot — cron wrapper.
#
# Captures structured snapshots of recently modified ACP/embedded sessions
# into brainx_session_snapshots (with embeddings + filters). Runs every 4h
# so a handoff that happens at 14:00 is recallable to the next session of
# the same agent within ~4h, not next-day.
#
# The captura layer applies quality filters: minTurnCount=5 (or blocker/
# error compensation), minSummaryChars=200, requires non-trivial state
# signal. See scripts/session-snapshot.js for details.
#
# Outputs JSON expected by the alert agent's "Cron" reply template.
set -uo pipefail

cd /home/clawd/.openclaw/skills/brainx

set -a
# shellcheck disable=SC1091
source /home/clawd/.openclaw/gateway.env
set +a

snapshot_out="$(mktemp)"
promoter_out="$(mktemp)"

cleanup() {
  rm -f "$snapshot_out" "$promoter_out"
}
trap cleanup EXIT

run_retry() {
  local out_file="$1"
  shift
  local max_attempts="${BRAINX_SESSION_SNAPSHOT_ATTEMPTS:-3}"
  local backoff_seconds="${BRAINX_SESSION_SNAPSHOT_BACKOFF_SECONDS:-20}"
  local attempt=1
  local code=1
  : >"$out_file"
  while [ "$attempt" -le "$max_attempts" ]; do
    "$@" >"$out_file" 2>&1
    code=$?
    if [ "$code" -eq 0 ]; then
      return 0
    fi
    if [ "$attempt" -lt "$max_attempts" ]; then
      sleep "$backoff_seconds"
    fi
    attempt=$((attempt + 1))
  done
  return "$code"
}

run_retry "$snapshot_out" timeout 240 node scripts/session-snapshot.js --hours 5 --max-sessions 12
snapshot_code=$?

promoter_code=0
if [ "$snapshot_code" -eq 0 ]; then
  run_retry "$promoter_out" timeout 180 node scripts/handoff-promoter.js --hours 6 --limit 24 --json
  promoter_code=$?
fi

node -e '
const fs = require("fs");
const [snapshotPath, promoterPath, snapshotCodeRaw, promoterCodeRaw] = process.argv.slice(1);
const parse = (file) => {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
  if (!text) return null;
  try { return JSON.parse(text); }
  catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); }
      catch {}
    }
    return { raw: text.slice(0, 4000) };
  }
};
const snapshotCode = Number(snapshotCodeRaw || 0);
const promoterCode = Number(promoterCodeRaw || 0);
console.log(JSON.stringify({
  ok: snapshotCode === 0 && promoterCode === 0,
  snapshot: parse(snapshotPath),
  handoffPromoter: parse(promoterPath),
  codes: { snapshot: snapshotCode, handoffPromoter: promoterCode }
}, null, 2));
' "$snapshot_out" "$promoter_out" "$snapshot_code" "$promoter_code"

if [ "$snapshot_code" -ne 0 ]; then
  exit "$snapshot_code"
fi
if [ "$promoter_code" -ne 0 ]; then
  exit "$promoter_code"
fi
