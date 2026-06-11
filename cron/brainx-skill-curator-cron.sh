#!/usr/bin/env bash
# BrainX Skill Curator - Hermes-style weekly library maintenance.
# Only manages BrainX-owned skills through the reversible lifecycle sidecar.
set -euo pipefail

PATH="/home/clawd/.local/share/pnpm:/home/clawd/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"

JOB_SLUG="${BRAINX_SKILL_CURATOR_JOB_SLUG:-brainx-skill-curator}"
RUN_TS="$(date +%Y%m%d-%H%M%S)"
BRAINX_ROOT="/home/clawd/.openclaw/skills/brainx"
SKILLS_ROOT="${BRAINX_SKILL_CURATOR_SKILLS_ROOT:-/home/clawd/.openclaw/skills}"
STATE_DIR="/home/clawd/.openclaw/state/cron/${JOB_SLUG}"
LOG_DIR="/home/clawd/.openclaw/cron/runs"
LOCK_DIR="/home/clawd/.openclaw/state/cron/locks"
PAYLOAD_FILE="${STATE_DIR}/${JOB_SLUG}-${RUN_TS}.json"
LOG_FILE="${LOG_DIR}/${JOB_SLUG}-${RUN_TS}.log"
USAGE_FILE="${SKILLS_ROOT}/.brainx-skill-usage.json"
SNAPSHOT_FILE="${STATE_DIR}/snapshots/${RUN_TS}.brainx-skill-usage.json"
RAW_OUT="${STATE_DIR}/${JOB_SLUG}-${RUN_TS}.raw.json"
RAW_ERR="${STATE_DIR}/${JOB_SLUG}-${RUN_TS}.stderr.log"
STALE_DAYS="${BRAINX_SKILL_CURATOR_STALE_DAYS:-30}"
ARCHIVE_DAYS="${BRAINX_SKILL_CURATOR_ARCHIVE_DAYS:-90}"
TIMEOUT_SECONDS="${BRAINX_SKILL_CURATOR_TIMEOUT_SECONDS:-600}"

mkdir -p "$STATE_DIR" "$LOG_DIR" "$LOCK_DIR" "$(dirname "$SNAPSHOT_FILE")"

exec 9>"${LOCK_DIR}/${JOB_SLUG}.lock"
if command -v flock >/dev/null 2>&1; then
  if ! flock -n 9; then
    node - <<'NODE'
const job = process.env.BRAINX_SKILL_CURATOR_JOB_SLUG || 'brainx-skill-curator';
console.log(JSON.stringify({
  ok: true,
  status: 'noop',
  job,
  mode: 'skill_curator',
  reason: 'already_running'
}, null, 2));
NODE
    exit 0
  fi
fi

if [ -f "$USAGE_FILE" ]; then
  cp "$USAGE_FILE" "$SNAPSHOT_FILE"
else
  printf '{}\n' >"$SNAPSHOT_FILE"
fi

cd "$BRAINX_ROOT"

set +e
timeout "${TIMEOUT_SECONDS}" ./brainx skill-curator run \
  --stale-days "$STALE_DAYS" \
  --archive-days "$ARCHIVE_DAYS" \
  --root "$SKILLS_ROOT" \
  --json >"$RAW_OUT" 2>"$RAW_ERR"
curator_code=$?
set -e

cat "$RAW_OUT" >"$LOG_FILE" 2>/dev/null || true
if [ -s "$RAW_ERR" ]; then
  {
    echo ""
    echo "STDERR:"
    cat "$RAW_ERR"
  } >>"$LOG_FILE"
fi

node - "$RAW_OUT" "$RAW_ERR" "$PAYLOAD_FILE" "$LOG_FILE" "$SNAPSHOT_FILE" "$curator_code" <<'NODE'
const fs = require('fs');

const [rawPath, errPath, payloadPath, logFile, snapshotFile, codeRaw] = process.argv.slice(2);
const code = Number(codeRaw || 0);
const raw = fs.existsSync(rawPath) ? fs.readFileSync(rawPath, 'utf8') : '';
const stderr = fs.existsSync(errPath) ? fs.readFileSync(errPath, 'utf8') : '';

function parseJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch {}
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
  }
  return null;
}

const result = parseJson(raw);
const ok = code === 0 && result && result.ok !== false;
const payload = {
  ok,
  status: ok ? 'ok' : 'error',
  job: process.env.BRAINX_SKILL_CURATOR_JOB_SLUG || 'brainx-skill-curator',
  mode: 'skill_curator',
  result,
  paths: {
    snapshotFile,
    payloadFile: payloadPath,
    logFile,
  },
  error: ok ? null : {
    code,
    stderrTail: stderr.slice(-2000),
    stdoutTail: raw.slice(-2000),
  },
};

fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(payload, null, 2));
if (!ok) process.exit(code || 1);
NODE
