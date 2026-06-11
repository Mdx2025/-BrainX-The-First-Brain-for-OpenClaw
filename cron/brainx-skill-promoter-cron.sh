#!/usr/bin/env bash
# BrainX Skill Promoter - review-gated candidate report plus optional
# high-confidence auto-create/low-risk auto-patch. Critical skill patches remain manual-only.
set -euo pipefail

PATH="/home/clawd/.local/share/pnpm:/home/clawd/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"

JOB_SLUG="${BRAINX_SKILL_PROMOTER_JOB_SLUG:-brainx-skill-promoter}"
LOCK_SLUG="${BRAINX_SKILL_PROMOTER_LOCK_SLUG:-brainx-skill-promoter}"
MODE="${BRAINX_SKILL_PROMOTER_MODE:-dry_run_report}"
RUN_TS="$(date +%Y%m%d-%H%M%S)"
BRAINX_ROOT="/home/clawd/.openclaw/skills/brainx"
STATE_DIR="/home/clawd/.openclaw/state/cron/${JOB_SLUG}"
LOG_DIR="/home/clawd/.openclaw/cron/runs"
LOCK_DIR="/home/clawd/.openclaw/state/cron/locks"
CANDIDATE_DIR="${STATE_DIR}/candidates/${RUN_TS}"
PAYLOAD_FILE="${STATE_DIR}/${JOB_SLUG}-${RUN_TS}.json"
LOG_FILE="${LOG_DIR}/${JOB_SLUG}-${RUN_TS}.log"
RAW_OUT="${STATE_DIR}/${JOB_SLUG}-${RUN_TS}.raw.json"
RAW_ERR="${STATE_DIR}/${JOB_SLUG}-${RUN_TS}.stderr.log"

TIMEOUT_SECONDS="${BRAINX_SKILL_PROMOTER_TIMEOUT_SECONDS:-720}"
DAYS="${BRAINX_SKILL_PROMOTER_DAYS:-14}"
MIN_RECURRENCE="${BRAINX_SKILL_PROMOTER_MIN_RECURRENCE:-2}"
LIMIT="${BRAINX_SKILL_PROMOTER_LIMIT:-100}"
AGENT_LIMIT="${BRAINX_SKILL_PROMOTER_AGENT_LIMIT:-80}"
PER_AGENT_LIMIT="${BRAINX_SKILL_PROMOTER_PER_AGENT_LIMIT:-20}"
SESSION_LIMIT="${BRAINX_SKILL_PROMOTER_SESSION_LIMIT:-200}"
PER_AGENT_SESSION_LIMIT="${BRAINX_SKILL_PROMOTER_PER_AGENT_SESSION_LIMIT:-10}"
AUTO_CREATE="${BRAINX_SKILL_PROMOTER_AUTO_CREATE:-0}"
AUTO_CREATE_MIN_CONFIDENCE="${BRAINX_SKILL_PROMOTER_AUTO_CREATE_MIN_CONFIDENCE:-0.86}"
AUTO_CREATE_MIN_RECURRENCE="${BRAINX_SKILL_PROMOTER_AUTO_CREATE_MIN_RECURRENCE:-6}"
AUTO_CREATE_MIN_SOURCE_COUNT="${BRAINX_SKILL_PROMOTER_AUTO_CREATE_MIN_SOURCE_COUNT:-3}"
AUTO_PATCH="${BRAINX_SKILL_PROMOTER_AUTO_PATCH:-0}"
AUTO_PATCH_MIN_CONFIDENCE="${BRAINX_SKILL_PROMOTER_AUTO_PATCH_MIN_CONFIDENCE:-0.9}"
AUTO_PATCH_MIN_RECURRENCE="${BRAINX_SKILL_PROMOTER_AUTO_PATCH_MIN_RECURRENCE:-6}"
AUTO_PATCH_MIN_SOURCE_COUNT="${BRAINX_SKILL_PROMOTER_AUTO_PATCH_MIN_SOURCE_COUNT:-3}"
DRY_RUN="${BRAINX_SKILL_PROMOTER_DRY_RUN:-0}"

mkdir -p "$STATE_DIR" "$LOG_DIR" "$LOCK_DIR" "$CANDIDATE_DIR"

exec 9>"${LOCK_DIR}/${LOCK_SLUG}.lock"
if command -v flock >/dev/null 2>&1; then
  if ! flock -n 9; then
    node - <<'NODE'
const job = process.env.BRAINX_SKILL_PROMOTER_JOB_SLUG || 'brainx-skill-promoter';
const mode = process.env.BRAINX_SKILL_PROMOTER_MODE || 'dry_run_report';
console.log(JSON.stringify({
  ok: true,
  status: "noop",
  job,
  mode,
  reason: "already_running",
  message: "Otro BrainX Skill Promoter ya esta corriendo; se evita overlap."
}, null, 2));
NODE
    exit 0
  fi
fi

load_env() {
  local file="$1"
  if [ -f "$file" ]; then
    # shellcheck disable=SC1090
    set -a; . "$file"; set +a
  fi
}

load_env "/home/clawd/.openclaw/.env"
load_env "/home/clawd/.env"
load_env "${BRAINX_ROOT}/.env"
load_env "/home/clawd/.openclaw/gateway.env"

cd "$BRAINX_ROOT"

cmd=(
  timeout "$TIMEOUT_SECONDS" ./brainx skill-promoter
  --hybrid
  --per-agent
  --days "$DAYS"
  --min-recurrence "$MIN_RECURRENCE"
  --limit "$LIMIT"
  --agent-limit "$AGENT_LIMIT"
  --per-agent-limit "$PER_AGENT_LIMIT"
  --session-limit "$SESSION_LIMIT"
  --per-agent-session-limit "$PER_AGENT_SESSION_LIMIT"
  --json
  --emit-dir "$CANDIDATE_DIR"
)

if [ "$AUTO_CREATE" = "1" ] || [ "$AUTO_CREATE" = "true" ]; then
  cmd+=(
    --auto-create
    --auto-create-min-confidence "$AUTO_CREATE_MIN_CONFIDENCE"
    --auto-create-min-recurrence "$AUTO_CREATE_MIN_RECURRENCE"
    --auto-create-min-source-count "$AUTO_CREATE_MIN_SOURCE_COUNT"
  )
fi

if [ "$AUTO_PATCH" = "1" ] || [ "$AUTO_PATCH" = "true" ]; then
  cmd+=(
    --auto-patch
    --auto-patch-min-confidence "$AUTO_PATCH_MIN_CONFIDENCE"
    --auto-patch-min-recurrence "$AUTO_PATCH_MIN_RECURRENCE"
    --auto-patch-min-source-count "$AUTO_PATCH_MIN_SOURCE_COUNT"
  )
fi

if [ "$DRY_RUN" = "1" ] || [ "$DRY_RUN" = "true" ]; then
  cmd+=(--dry-run)
fi

set +e
"${cmd[@]}" >"$RAW_OUT" 2>"$RAW_ERR"
skill_promoter_code=$?
set -e

cat "$RAW_OUT" >"$LOG_FILE" 2>/dev/null || true
if [ -s "$RAW_ERR" ]; then
  {
    echo ""
    echo "STDERR:"
    cat "$RAW_ERR"
  } >>"$LOG_FILE"
fi

node - "$RAW_OUT" "$RAW_ERR" "$PAYLOAD_FILE" "$LOG_FILE" "$CANDIDATE_DIR" "$skill_promoter_code" <<'NODE'
const fs = require('fs');
const path = require('path');

const [rawPath, errPath, payloadPath, logFile, candidateDir, codeRaw] = process.argv.slice(2);
const code = Number(codeRaw || 0);
const raw = fs.existsSync(rawPath) ? fs.readFileSync(rawPath, 'utf8') : '';
const stderr = fs.existsSync(errPath) ? fs.readFileSync(errPath, 'utf8') : '';
const job = process.env.BRAINX_SKILL_PROMOTER_JOB_SLUG || 'brainx-skill-promoter';
const mode = process.env.BRAINX_SKILL_PROMOTER_MODE || 'dry_run_report';

function parseJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function safeInstruction(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

const payload = parseJson(raw);
const parseOk = Boolean(payload && typeof payload === 'object');
const autoCreate = payload?.autoCreate || null;
const autoPatch = payload?.autoPatch || null;
const candidates = Array.isArray(payload?.candidates)
  ? payload.candidates.map((candidate) => ({
      skillName: candidate.skillName,
      action: candidate.action,
      confidence: candidate.confidence,
      recurrence: candidate.recurrence,
      sourceCount: candidate.sourceCount,
      sourceKinds: candidate.sourceKinds,
      sourceSessions: Array.isArray(candidate.sourceSessions) ? candidate.sourceSessions.length : 0,
      brainxConfirmations: Array.isArray(candidate.brainxConfirmations) ? candidate.brainxConfirmations.length : 0,
      instructions: Array.isArray(candidate.instructions)
        ? candidate.instructions.slice(0, 3).map(safeInstruction).filter(Boolean)
        : [],
    }))
  : [];

const files = Array.isArray(payload?.files)
  ? payload.files.map((file) => path.basename(String(file))).filter(Boolean)
  : [];

const sessionCoverage = payload?.sessionCoverage ? {
  sessionsScanned: payload.sessionCoverage.sessionsScanned,
  agentsScanned: payload.sessionCoverage.agentsScanned,
  messagesScanned: payload.sessionCoverage.messagesScanned,
  messagesSkipped: payload.sessionCoverage.messagesSkipped,
  instructionsExtracted: payload.sessionCoverage.instructionsExtracted,
  instructionRows: payload.sessionCoverage.instructionRows,
  confirmedInstructionRows: payload.sessionCoverage.confirmedInstructionRows,
} : null;

const summary = {
  ok: code === 0 && parseOk && payload?.ok !== false,
  status: code === 0 && parseOk && payload?.ok !== false ? 'ok' : 'error',
  job,
  mode,
  apply: Boolean(autoCreate || autoPatch),
  autoCreate: autoCreate ? {
    selected: autoCreate.selected,
    applied: Array.isArray(autoCreate.applied) ? autoCreate.applied.map((result) => ({
      skillName: result.skillName,
      action: result.action,
      dryRun: result.dryRun === true,
      skillDir: result.skillDir,
      auditFile: result.auditFile,
    })) : [],
    skipped: Array.isArray(autoCreate.skipped) ? autoCreate.skipped.slice(0, 20) : [],
    manualReview: Array.isArray(autoCreate.manualReview) ? autoCreate.manualReview.slice(0, 20) : [],
    errors: Array.isArray(autoCreate.errors) ? autoCreate.errors : [],
    gates: autoCreate.gates || null,
  } : null,
  autoPatch: autoPatch ? {
    selected: autoPatch.selected,
    applied: Array.isArray(autoPatch.applied) ? autoPatch.applied.map((result) => ({
      skillName: result.skillName,
      action: result.action,
      dryRun: result.dryRun === true,
      patchRisk: result.patchRisk || null,
      skillDir: result.skillDir,
      auditFile: result.auditFile,
    })) : [],
    skipped: Array.isArray(autoPatch.skipped) ? autoPatch.skipped.slice(0, 20) : [],
    manualReview: Array.isArray(autoPatch.manualReview) ? autoPatch.manualReview.slice(0, 20) : [],
    errors: Array.isArray(autoPatch.errors) ? autoPatch.errors : [],
    gates: autoPatch.gates || null,
  } : null,
  thresholds: payload?.thresholds || null,
  rowsScanned: payload?.rowsScanned ?? null,
  candidateCount: Number.isFinite(payload?.count) ? payload.count : candidates.length,
  sessionCoverage,
  candidates,
  files,
  paths: {
    candidateDir,
    payloadFile: payloadPath,
    logFile,
  },
  error: code === 0 && parseOk ? null : {
    code,
    parseOk,
    stderrTail: stderr.slice(-2000),
    stdoutTail: raw.slice(-2000),
  },
};

fs.writeFileSync(payloadPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(summary, null, 2));

if (!summary.ok) process.exit(code || 1);
NODE
