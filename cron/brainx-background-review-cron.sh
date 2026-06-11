#!/usr/bin/env bash
# BrainX Background Review - Hermes-style near-event skill review loop.
# Runs guarded existing-skill patching and high-confidence new-skill creation
# under one OpenClaw cron job.
set -euo pipefail

PATH="/home/clawd/.local/share/pnpm:/home/clawd/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"

ROOT="/home/clawd"
WRAPPER="${ROOT}/.openclaw/workspace/scripts/brainx-skill-promoter-cron.sh"
JOB_SLUG="${BRAINX_BACKGROUND_REVIEW_JOB_SLUG:-brainx-background-review}"
LOCK_SLUG="${BRAINX_BACKGROUND_REVIEW_LOCK_SLUG:-brainx-background-review}"
RUN_TS="$(date +%Y%m%d-%H%M%S)"
STATE_DIR="${ROOT}/.openclaw/state/cron/${JOB_SLUG}"
LOG_DIR="${ROOT}/.openclaw/cron/runs"
LOCK_DIR="${ROOT}/.openclaw/state/cron/locks"
PATCH_OUT="${STATE_DIR}/${JOB_SLUG}-${RUN_TS}.patch.json"
CREATE_OUT="${STATE_DIR}/${JOB_SLUG}-${RUN_TS}.create.json"
PAYLOAD_FILE="${STATE_DIR}/${JOB_SLUG}-${RUN_TS}.json"
LOG_FILE="${LOG_DIR}/${JOB_SLUG}-${RUN_TS}.log"

mkdir -p "$STATE_DIR" "$LOG_DIR" "$LOCK_DIR"

exec 9>"${LOCK_DIR}/${LOCK_SLUG}.lock"
if command -v flock >/dev/null 2>&1; then
  if ! flock -n 9; then
    node - <<'NODE'
const job = process.env.BRAINX_BACKGROUND_REVIEW_JOB_SLUG || 'brainx-background-review';
console.log(JSON.stringify({
  ok: true,
  status: 'noop',
  job,
  mode: 'background_review',
  reason: 'already_running',
  message: 'Otro BrainX Background Review ya esta corriendo; se evita overlap.'
}, null, 2));
NODE
    exit 0
  fi
fi

run_profile() {
  local kind="$1"
  local out="$2"
  shift 2
  set +e
  env "$@" bash "$WRAPPER" >"$out" 2>>"$LOG_FILE"
  local code=$?
  set -e
  printf '\n# %s exit=%s output=%s\n' "$kind" "$code" "$out" >>"$LOG_FILE"
  cat "$out" >>"$LOG_FILE" 2>/dev/null || true
  printf '\n' >>"$LOG_FILE"
  return "$code"
}

patch_code=0
create_code=0

run_profile "auto-patch" "$PATCH_OUT" \
  BRAINX_SKILL_PROMOTER_JOB_SLUG="${JOB_SLUG}-auto-patch" \
  BRAINX_SKILL_PROMOTER_LOCK_SLUG="${JOB_SLUG}-inner" \
  BRAINX_SKILL_PROMOTER_MODE="background_review_auto_patch" \
  BRAINX_SKILL_PROMOTER_TIMEOUT_SECONDS="${BRAINX_BACKGROUND_REVIEW_TIMEOUT_SECONDS:-540}" \
  BRAINX_SKILL_PROMOTER_DAYS="${BRAINX_BACKGROUND_REVIEW_DAYS:-1}" \
  BRAINX_SKILL_PROMOTER_MIN_RECURRENCE="${BRAINX_BACKGROUND_REVIEW_MIN_RECURRENCE:-2}" \
  BRAINX_SKILL_PROMOTER_LIMIT="${BRAINX_BACKGROUND_REVIEW_LIMIT:-60}" \
  BRAINX_SKILL_PROMOTER_AGENT_LIMIT="${BRAINX_BACKGROUND_REVIEW_AGENT_LIMIT:-60}" \
  BRAINX_SKILL_PROMOTER_PER_AGENT_LIMIT="${BRAINX_BACKGROUND_REVIEW_PER_AGENT_LIMIT:-10}" \
  BRAINX_SKILL_PROMOTER_SESSION_LIMIT="${BRAINX_BACKGROUND_REVIEW_SESSION_LIMIT:-120}" \
  BRAINX_SKILL_PROMOTER_PER_AGENT_SESSION_LIMIT="${BRAINX_BACKGROUND_REVIEW_PER_AGENT_SESSION_LIMIT:-6}" \
  BRAINX_SKILL_PROMOTER_AUTO_PATCH=1 \
  BRAINX_SKILL_PROMOTER_AUTO_PATCH_MIN_CONFIDENCE="${BRAINX_BACKGROUND_REVIEW_AUTO_PATCH_MIN_CONFIDENCE:-0.9}" \
  BRAINX_SKILL_PROMOTER_AUTO_PATCH_MIN_RECURRENCE="${BRAINX_BACKGROUND_REVIEW_AUTO_PATCH_MIN_RECURRENCE:-2}" \
  BRAINX_SKILL_PROMOTER_AUTO_PATCH_MIN_SOURCE_COUNT="${BRAINX_BACKGROUND_REVIEW_AUTO_PATCH_MIN_SOURCE_COUNT:-2}" \
  || patch_code=$?

run_profile "auto-create" "$CREATE_OUT" \
  BRAINX_SKILL_PROMOTER_JOB_SLUG="${JOB_SLUG}-auto-create" \
  BRAINX_SKILL_PROMOTER_LOCK_SLUG="${JOB_SLUG}-inner" \
  BRAINX_SKILL_PROMOTER_MODE="background_review_auto_create" \
  BRAINX_SKILL_PROMOTER_TIMEOUT_SECONDS="${BRAINX_BACKGROUND_REVIEW_TIMEOUT_SECONDS:-540}" \
  BRAINX_SKILL_PROMOTER_DAYS="${BRAINX_BACKGROUND_REVIEW_DAYS:-1}" \
  BRAINX_SKILL_PROMOTER_MIN_RECURRENCE="${BRAINX_BACKGROUND_REVIEW_MIN_RECURRENCE:-2}" \
  BRAINX_SKILL_PROMOTER_LIMIT="${BRAINX_BACKGROUND_REVIEW_LIMIT:-60}" \
  BRAINX_SKILL_PROMOTER_AGENT_LIMIT="${BRAINX_BACKGROUND_REVIEW_AGENT_LIMIT:-60}" \
  BRAINX_SKILL_PROMOTER_PER_AGENT_LIMIT="${BRAINX_BACKGROUND_REVIEW_PER_AGENT_LIMIT:-10}" \
  BRAINX_SKILL_PROMOTER_SESSION_LIMIT="${BRAINX_BACKGROUND_REVIEW_SESSION_LIMIT:-120}" \
  BRAINX_SKILL_PROMOTER_PER_AGENT_SESSION_LIMIT="${BRAINX_BACKGROUND_REVIEW_PER_AGENT_SESSION_LIMIT:-6}" \
  BRAINX_SKILL_PROMOTER_AUTO_CREATE=1 \
  BRAINX_SKILL_PROMOTER_AUTO_CREATE_MIN_CONFIDENCE="${BRAINX_BACKGROUND_REVIEW_AUTO_CREATE_MIN_CONFIDENCE:-0.9}" \
  BRAINX_SKILL_PROMOTER_AUTO_CREATE_MIN_RECURRENCE="${BRAINX_BACKGROUND_REVIEW_AUTO_CREATE_MIN_RECURRENCE:-2}" \
  BRAINX_SKILL_PROMOTER_AUTO_CREATE_MIN_SOURCE_COUNT="${BRAINX_BACKGROUND_REVIEW_AUTO_CREATE_MIN_SOURCE_COUNT:-2}" \
  || create_code=$?

node - "$PATCH_OUT" "$CREATE_OUT" "$PAYLOAD_FILE" "$LOG_FILE" "$patch_code" "$create_code" <<'NODE'
const fs = require('fs');

const [patchPath, createPath, payloadPath, logFile, patchCodeRaw, createCodeRaw] = process.argv.slice(2);
const patchCode = Number(patchCodeRaw || 0);
const createCode = Number(createCodeRaw || 0);

function readPayload(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { ok: false, status: 'error', error: { parseOk: false, message: error.message } };
  }
}

const patch = readPayload(patchPath);
const create = readPayload(createPath);
const ok = patchCode === 0 && createCode === 0 && patch.ok !== false && create.ok !== false;
const candidateCount = Number(patch.candidateCount || 0) + Number(create.candidateCount || 0);
const payload = {
  ok,
  status: ok ? 'ok' : 'error',
  job: process.env.BRAINX_BACKGROUND_REVIEW_JOB_SLUG || 'brainx-background-review',
  mode: 'background_review',
  profiles: {
    autoPatch: patch,
    autoCreate: create,
  },
  summary: {
    candidateCount,
    autoPatchSelected: Number(patch.autoPatch?.selected || 0),
    autoPatchApplied: Array.isArray(patch.autoPatch?.applied) ? patch.autoPatch.applied.length : 0,
    autoPatchErrors: Array.isArray(patch.autoPatch?.errors) ? patch.autoPatch.errors.length : 0,
    autoCreateSelected: Number(create.autoCreate?.selected || 0),
    autoCreateApplied: Array.isArray(create.autoCreate?.applied) ? create.autoCreate.applied.length : 0,
    autoCreateErrors: Array.isArray(create.autoCreate?.errors) ? create.autoCreate.errors.length : 0,
  },
  paths: {
    patchPayload: patchPath,
    createPayload: createPath,
    payloadFile: payloadPath,
    logFile,
  },
};

fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(payload, null, 2));
if (!ok) process.exit(patchCode || createCode || 1);
NODE
