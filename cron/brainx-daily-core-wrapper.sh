#!/usr/bin/env bash
set -u

BRAINX_DIR="${BRAINX_DIR:-$HOME/.openclaw/skills/brainx}"
MONITOR_SCRIPTS="${MONITOR_SCRIPTS:-$HOME/.openclaw/workspace/scripts}"
RUN_TS="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="${LOG_FILE:-$HOME/.openclaw/cron/runs/brainx-daily-core-wrapper-${RUN_TS}.log}"
TODAY_UTC="$(date -u +%w)"
IS_SUNDAY=0
IS_MIDWEEK_OR_SUNDAY=0
# Day-of-week: 0=Sun, 3=Wed
if [ "$TODAY_UTC" -eq 0 ]; then
  IS_SUNDAY=1
fi
if [ "$TODAY_UTC" -eq 0 ] || [ "$TODAY_UTC" -eq 3 ]; then
  IS_MIDWEEK_OR_SUNDAY=1
fi

mkdir -p "$(dirname "$LOG_FILE")"

if ! cd "$BRAINX_DIR"; then
  echo "BRAINX_CLOSEOUT_EVIDENCE: status=fail reason=cd_failed cwd_expected=$BRAINX_DIR"
  exit 1
fi

declare -a NAMES=()
declare -a CMDS=()

# ── DAILY STEPS (run every day) ────────────────────────────────

NAMES+=("memory-daily-bootstrap")
CMDS+=("bash ${MONITOR_SCRIPTS}/memory-daily-bootstrap-cron.sh")

NAMES+=("memory-distiller")
CMDS+=("timeout ${BRAINX_DAILY_CORE_MEMORY_DISTILLER_TIMEOUT_SECONDS:-360} node scripts/memory-distiller.js --hours 8 --max-sessions ${BRAINX_DAILY_CORE_MEMORY_DISTILLER_MAX_SESSIONS:-3} --max-runtime-seconds ${BRAINX_DAILY_CORE_MEMORY_DISTILLER_MAX_RUNTIME_SECONDS:-300} --llm-timeout-ms ${BRAINX_DAILY_CORE_MEMORY_DISTILLER_LLM_TIMEOUT_MS:-120000}")

NAMES+=("session-harvester")
CMDS+=("timeout 180 node scripts/session-harvester.js --hours 12 --max-sessions 10")

# BRAINX_TURN_HARVESTER_FIDELITY_THROUGHPUT_20260620 (R9-dailies): retention for the
# memory/YYYY-MM-DD.md narrative logs (no retention today; superseded by Postgres memories).
# SAFE BY DEFAULT — BRAINX_DAILY_RETENTION_DAYS unset/0 => no-op (deletes nothing). Set it to
# e.g. 45 to enable pruning of dailies older than 45 days.
NAMES+=("daily-memory-retention")
CMDS+=("timeout 60 node scripts/prune-daily-memory.js --days ${BRAINX_DAILY_RETENTION_DAYS:-0} --apply --json")

# handoff-promoter added 2026-04-28: turns passive session snapshots into
# hot durable memories + artifact ledger rows. This closes the gap where a
# snapshot existed but a rotated session did not recall the prior artifact.
NAMES+=("handoff-promoter")
CMDS+=("timeout 180 node scripts/handoff-promoter.js --hours 24 --limit 30 --json")

# artifact-archiver added 2026-07-16: ledger rows recorded a local path and
# nothing else, so the weekly /tmp purge (cleanup-all.sh, Mondays) silently took
# the bytes with it — 53% of pointers were already dangling. Copies artifacts to
# R2 content-addressed and records the location. Runs after handoff-promoter so
# rows minted this cycle get archived the same night. Copy-only: never deletes
# from disk, and marks a row 'archived' only after verifying the object.
# Kill switch: BRAINX_ARTIFACT_ARCHIVER_ENABLED=0.
NAMES+=("artifact-archiver")
CMDS+=("timeout 600 node scripts/artifact-archiver.js --limit 500 --json")

NAMES+=("memory-bridge")
CMDS+=("timeout 180 node scripts/memory-bridge.js --hours 8 --max-memories 25")

NAMES+=("cross-agent-learning")
CMDS+=("timeout 180 node scripts/cross-agent-learning.js --hours 24 --max-shares 12")

NAMES+=("context-pack-builder")
CMDS+=("timeout 120 node scripts/context-pack-builder.js --days 7")

# Error harvester moved from weekly to daily (2026-04-14): errors lose context
# when they sit 7 days. Daily 24h window is lightweight (regex-only, no LLM).
NAMES+=("error-harvester")
CMDS+=("timeout 120 node scripts/error-harvester.js --hours 24")

# Note: acp-rotation-event-ingest moved to the Review Loop (every ~2h) on
# 2026-05-31 for near-real-time ledger drain; see brainx-review-loop-cron.sh.

# Reclassify added 2026-04-19: keeps category coverage current as new memories
# arrive from distiller/harvester/bridge above. Idempotent — short-circuits when
# row already has the right category + importance, so steady-state cost is low.
NAMES+=("reclassify-memories")
CMDS+=("timeout 180 node scripts/reclassify-memories.js")

# degrade-over-injected added 2026-04-22: closes the injection→usage feedback
# loop. A memory injected >=20 times in the last 7 days without any agent
# referencing it back is over-generic — drops one tier so it stops dominating
# recall. Reversible (only changes tier, tags with noise:over-injected:<date>),
# never marks obsolete or deletes. Data source: brainx_runtime_injections.
# Extended 2026-05-02 with --mode=both: also captures memories never injected
# in 60d that are >30d old and >30d untouched (closes the "1994 hot/warm never
# accessed" stale set the over-injected pass alone could not reach).
NAMES+=("degrade-over-injected")
CMDS+=("timeout 90 node scripts/degrade-over-injected.js --mode both --apply --json")

# reconcile-contradictions added 2026-07-18: the missing VERACITY axis. Every
# other hygiene loop scores UPTAKE (was it referenced?) — none checks whether a
# newer fact CONTRADICTS an older still-live one. A `verified` hot fact that
# silently became false when the world changed keeps a near-perfect recall score
# (and, because recency reads from last_accessed, every injection refreshes it),
# so agents keep acting on stale truth. Incident 2026-07-18: a `verified`
# "prod = <staging host>" fact nearly caused a deploy to the wrong box, 8 days
# after prod migrated. This step scans the ~337 verified hot/warm incumbents,
# LLM-judges each against its nearest NEWER challenger. Autonomous action is
# FLAG-ONLY (reversible: verified->hypothesis + tier down, so the newer truth can
# COMPETE instead of being outranked) — validated 2026-07-18 that the judge over-
# fires ~1/3 on same-incident duplicates, so destructive hard-obsolete is NOT run
# unattended (operator opt-in via --allow-supersede). knowledge_canonical is only
# REVIEW-tagged, never auto-degraded. Conservative floor --min-confidence 0.85.
# Exits 0 on partial (a per-pair LLM failure retries next run) so it never flaps
# daily-core to error.
NAMES+=("reconcile-contradictions")
CMDS+=("timeout ${BRAINX_DAILY_CORE_RECONCILE_TIMEOUT_SECONDS:-300} node scripts/reconcile-contradictions.js --apply --min-confidence 0.85 --max-runtime-seconds ${BRAINX_DAILY_CORE_RECONCILE_MAX_RUNTIME_SECONDS:-180} --json")

# self-learning-audit added 2026-05-23: read-only autonomy layer that crosses
# runtime injection uptake, stale hot/warm memories, repeated failure signals,
# knowledge gaps, and low-recall query summaries. It does not mutate memory;
# write actions remain handled by dedicated gated scripts.
NAMES+=("self-learning-audit")
CMDS+=("timeout 90 node scripts/self-learning-audit.js --days 14 --limit 25 --json")

# doctor-actionable-fix added 2026-05-26, moved to daily cadence 2026-05-27:
# closes doctor/self-audit actionable hygiene without waiting for Sunday.
# Keep this scoped to safe maintenance steps: demote stale tiers, supersede
# high-confidence duplicate pairs, and close stale runtime scoring rows.
# Do not include durable-confidence, reclassification sweeps, deletes, or broad
# fix registry runs here; those stay gated/report-only.
NAMES+=("doctor-actionable-fix")
CMDS+=("timeout 180 ./brainx fix --only stale-demotion,auto-dedup,runtime-scoring-backlog --json")

# wiki-compile added 2026-04-22: recompiles brainx-vault/ (canonical wiki) so
# the digest surface in the plugin has fresh content. The compile reads
# knowledge/*.md + durable memories and is idempotent; previously done ad-hoc,
# letting the wiki drift 6+ days stale. Output lives at $HOME/brainx-vault.
NAMES+=("wiki-compile")
CMDS+=("timeout 120 ./brainx wiki compile --json")

# runtime-regression-suite added 2026-04-26: validates the BrainX runtime
# guardrails that previously regressed silently: monitor JIT denylist, strict
# cross-agent isolation, bridge-only runtime mode, recall ranking precision,
# reference scoring invariants, and noisy archive suppression. This stays in
# the daily core pipeline instead of adding another host cron.
NAMES+=("runtime-regression-suite")
CMDS+=("timeout 90 bash ${MONITOR_SCRIPTS}/brainx-regression-suite.sh")

# trajectory-recorder added 2026-04-26: rebuilds problem→solution trajectories
# from the last 24h of session JSONLs and stores them in brainx_trajectories
# (with embedding) for semantic recall of "we already solved X like this".
# Uses gpt-4.1-mini for extraction; tracker file prevents reprocessing the
# same session. Idempotent. Daily cadence matches the 24h scan window.
# BRAINX_DAILY_CORE_LLM_BUDGET_DEFER_20260614: give the OpenClaw-agent LLM
# calls enough wrapper budget and let the script defer unfinished sessions.
NAMES+=("trajectory-recorder")
CMDS+=("timeout ${BRAINX_DAILY_CORE_TRAJECTORY_RECORDER_TIMEOUT_SECONDS:-420} node scripts/trajectory-recorder.js --hours 24 --max-sessions ${BRAINX_DAILY_CORE_TRAJECTORY_RECORDER_MAX_SESSIONS:-8} --max-runtime-seconds ${BRAINX_DAILY_CORE_TRAJECTORY_RECORDER_MAX_RUNTIME_SECONDS:-360} --llm-timeout-ms ${BRAINX_DAILY_CORE_TRAJECTORY_RECORDER_LLM_TIMEOUT_MS:-150000}")

# method-error-harvester added 2026-05-31: captures METHOD/diagnostic errors
# (agent asserted wrong hypothesis → corrected) that no other loop sees, as
# injectable `gotcha` memories. Two-pass: regex candidates + cost-0 gpt-5.5
# OAuth confirmation (lib/agent-llm.js). Writes verified+cross-agent gotchas
# (tier warm, importance>=7) so the next agent recalls the correction via
# jitRecall. Autonomous safety net: degrade-over-injected demotes any gotcha
# injected without ever being referenced; 2-pass confirm + min-confidence 0.8 +
# dedup + per-episode ledger guard precision. See skills/brainx/docs/CRON.md.
NAMES+=("method-error-harvester")
CMDS+=("timeout ${BRAINX_DAILY_CORE_METHOD_ERROR_TIMEOUT_SECONDS:-420} node scripts/method-error-harvester.js --days 2 --top ${BRAINX_DAILY_CORE_METHOD_ERROR_TOP:-6} --capture --tier warm --min-confidence 0.8 --max-runtime-seconds ${BRAINX_DAILY_CORE_METHOD_ERROR_MAX_RUNTIME_SECONDS:-360} --llm-timeout-ms ${BRAINX_DAILY_CORE_METHOD_ERROR_LLM_TIMEOUT_MS:-120000} --json")

# method-error-promoter: durability layer for the method-error harvester. Moved from
# Sunday-only to DAILY (BRAINX_METHOD_ERROR_PROMOTER_DAILY_20260613) because a useful
# gotcha expired (14d SECONDARY recency) before the weekly run could catch it — 0/23 ever
# promoted. Now runs daily with a signal-OR-usage gate: promotes gotchas referenced by real
# agents (usage) OR repeatedly selected across multiple agents (signal) to PRIMARY
# (knowledge_canonical, no recency cap). Idempotent (promoted rows leave the agent_inference
# filter). Pairs with the last_seen-on-injection bump so used gotchas stay recall-visible
# long enough to earn promotion. See docs/CRON.md + the 2026-06-13 BrainX loop audit.
NAMES+=("method-error-promoter")
CMDS+=("timeout 120 node scripts/method-error-promoter.js --window 90 --min-referenced 1 --apply --json")

# usage-verified-promoter: GENERAL self-regulating trust loop (BRAINX_USAGE_VERIFIED_RECALL_LOOP_20260613).
# Where method-error-promoter is the curated gotcha lane, this is the broad one: promotes ANY
# hypothesis fact/decision/gotcha referenced by real agents across >=2 distinct sessions (hard OR
# soft) to verified+usage_verified (PRIMARY, no recency cap). Pairs with the lowered audition floor
# (importance>=6) in bridge.ts: hypotheses audition -> get referenced -> earn permanent recall here;
# non-referenced auditions decay/expire. Deterministic, idempotent, no LLM, no knob to babysit.
NAMES+=("usage-verified-promoter")
CMDS+=("timeout 120 node scripts/usage-verified-promoter.js --apply --json")

# acp-rotation-tuning-audit added 2026-05-31: READ-ONLY loop-closer for the
# context-budget rotation guard. Measures rotation frequency + how hot each
# Claude ACP session runs vs its window, flags churn / near-cap risk / native
# CLI compaction, and recommends RATIO adjustments. Never mutates. See
# docs/ACP_CONTEXT_CONTINUITY.md.
NAMES+=("acp-rotation-tuning-audit")
CMDS+=("timeout 60 node ${MONITOR_SCRIPTS}/brainx-acp-rotation-tuning-audit.mjs --json")

# learning-detail-extractor revived 2026-06-21 (BRAINX_LEARNING_DETAIL_REVIVE_MINIMAX_20260621):
# was dead since 2026-03-09 (cron removed) with a 5.1k-memory backlog while the
# BrainX Console panel that reads brainx_learning_details sat frozen. Re-wired here
# as a daily step. NOW cost-0: routes through the gateway agent (lib/agent-llm.js)
# with a MiniMax-M3 override (minimax-portal/MiniMax-M3, cost {input:0,output:0})
# instead of the old hardcoded raw OpenAI gpt-4.1-mini — matches the cost-conscious
# multi-provider design. Processes newest-unprocessed first (ORDER BY created_at DESC),
# so the Console's recent-window panel repopulates first; the deep Feb–Mar backlog
# drains slowly behind it (low value, acceptable). Idempotent (ON CONFLICT DO NOTHING);
# a mid-run budget stop just resumes next run.
# BRAINX_LEARNING_DETAIL_RUNTIME_BUDGET_20260621: self-budgets via --max-runtime-seconds
# (< the outer `timeout` hard backstop) so on a slow MiniMax day it exits 0 with partial
# progress instead of being SIGKILLed at the timeout (exit 124 → closeout=partial → false
# page). Same outer/inner ratio as the sibling LLM steps (e.g. trajectory-recorder 420/360).
NAMES+=("learning-detail-extractor")
CMDS+=("timeout ${BRAINX_DAILY_CORE_LEARNING_DETAIL_TIMEOUT_SECONDS:-480} node scripts/learning-detail-extractor.js --limit ${BRAINX_DAILY_CORE_LEARNING_DETAIL_LIMIT:-60} --max-runtime-seconds ${BRAINX_DAILY_CORE_LEARNING_DETAIL_MAX_RUNTIME_SECONDS:-420} --llm-timeout-ms ${BRAINX_DAILY_CORE_LEARNING_DETAIL_LLM_TIMEOUT_MS:-120000}")

# ── MIDWEEK STEPS (Wednesday + Sunday) ─────────────────────────
# Lifecycle + contradiction-detector run twice a week instead of weekly.
# Rationale: a contradictory or stale memory shouldn't live 6 days before
# being detected. Wed + Sun keeps gap to <=4 days.

if [ "$IS_MIDWEEK_OR_SUNDAY" -eq 1 ]; then

  NAMES+=("lifecycle-run")
  CMDS+=("./brainx lifecycle-run --json")

  NAMES+=("contradiction-detector")
  CMDS+=("timeout 240 node scripts/contradiction-detector.js --top 60 --threshold 0.85")

fi

# ── WEEKLY STEPS (run only on Sundays) ─────────────────────────

if [ "$IS_SUNDAY" -eq 1 ]; then

  NAMES+=("memory-consolidation")
  CMDS+=("timeout 180 bash cron/weekly-semantic-consolidation.sh --force")

  # min-recurrence forced to 6 (2026-04-14): the env default is 6 but the
  # script default fallback was 3, which let weak signals get promoted to
  # canonical rules. Always pass 6 explicitly to avoid drift.
  NAMES+=("auto-promoter")
  CMDS+=("timeout 120 node scripts/auto-promoter.js --days 30 --min-recurrence 6 --save")

  # BRAINX_DAILY_CORE_LLM_BUDGET_DEFER_20260614: agent-LLM calls have a 120s
  # floor, so the old 120s outer timeout killed valid dry-run distillation.
  NAMES+=("promotion-applier")
  CMDS+=("timeout ${BRAINX_DAILY_CORE_PROMOTION_APPLIER_TIMEOUT_SECONDS:-420} node scripts/promotion-applier.js --limit ${BRAINX_DAILY_CORE_PROMOTION_APPLIER_LIMIT:-12} --min-recurrence ${BRAINX_DAILY_CORE_PROMOTION_APPLIER_MIN_RECURRENCE:-5} --llm-timeout-ms ${BRAINX_DAILY_CORE_PROMOTION_APPLIER_LLM_TIMEOUT_MS:-150000} --max-runtime-seconds ${BRAINX_DAILY_CORE_PROMOTION_APPLIER_MAX_RUNTIME_SECONDS:-360}")

  NAMES+=("memory-enforcer")
  CMDS+=("bash ${MONITOR_SCRIPTS}/memory-enforcer-cron.sh")

  NAMES+=("memory-audit")
  CMDS+=("bash ${MONITOR_SCRIPTS}/memory-audit-alert-cron.sh")

  # dedup-supersede added 2026-04-26: hash-fingerprint dedup (md5 of
  # type+content+context+agent) marks exact duplicates as superseded_by →
  # newest. Idempotent (filters already-superseded). Low cost (1 SQL with CTE).
  # Belongs in Sunday block: dups accumulate slowly, weekly cadence is fine.
  NAMES+=("dedup-supersede")
  CMDS+=("timeout 60 node scripts/dedup-supersede.js")

  # cleanup-low-signal added 2026-04-26: degrades memories with content
  # length <= 12 chars (typically just an agent name like "coder\n" or
  # "writer\n" that slipped through capture) to tier=cold, importance<=2,
  # and tags them "low_signal". Idempotent. Targets decision/action/
  # learning/note types only — preserves fact/gotcha which can be short
  # by design.
  NAMES+=("cleanup-low-signal")
  CMDS+=("timeout 60 node scripts/cleanup-low-signal.js")

  # method-error-promoter moved to the DAILY block 2026-06-13 (was here, Sunday-only).

fi

ok_count=0
fail_count=0
step_total=${#NAMES[@]}
completed_count=0
last_step_num=0
last_step_name="none"
last_step_status="not_started"
last_step_code=-1
last_step_duration_s=0
closeout_emitted=0

emit_closeout() {
  local status="${1:-unknown}"
  local reason="${2:-none}"
  local line="BRAINX_CLOSEOUT_EVIDENCE: status=${status} reason=${reason} cwd=$(pwd) total=${step_total} completed=${completed_count} ok=${ok_count} fail=${fail_count} run_ts=${RUN_TS} last_step_num=${last_step_num} last_step_name=${last_step_name} last_step_status=${last_step_status} last_step_code=${last_step_code} last_step_duration_s=${last_step_duration_s}"

  if [ "${closeout_emitted}" -eq 0 ]; then
    echo "BRAINX_LOG: ${LOG_FILE}" | tee -a "$LOG_FILE"
    echo "$line" | tee -a "$LOG_FILE"
    closeout_emitted=1
  fi
}

on_signal() {
  local signal="$1"
  emit_closeout "interrupted" "signal_${signal}"
  trap - EXIT
  case "$signal" in
    TERM) exit 143 ;;
    INT) exit 130 ;;
    *) exit 1 ;;
  esac
}

on_exit() {
  local exit_code=$?
  if [ "${closeout_emitted}" -ne 0 ]; then
    return
  fi

  if [ "$exit_code" -eq 0 ] && [ "$fail_count" -eq 0 ] && [ "$completed_count" -eq "$step_total" ]; then
    emit_closeout "ok" "exit_${exit_code}"
  elif [ "$exit_code" -eq 0 ]; then
    emit_closeout "partial" "exit_${exit_code}"
  else
    emit_closeout "interrupted" "exit_${exit_code}"
  fi
}

trap on_exit EXIT
trap 'on_signal TERM' TERM
trap 'on_signal INT' INT

{
  echo "# BrainX Daily Core Wrapper"
  echo "run_ts=${RUN_TS}"
  echo "cwd=$(pwd)"
  echo "steps=${step_total}"
  echo "is_sunday=${IS_SUNDAY}"
  echo "is_midweek_or_sunday=${IS_MIDWEEK_OR_SUNDAY}"
  echo
} | tee -a "$LOG_FILE"

printf '{"run_ts":"%s","cwd":"%s","is_sunday":%s,"is_midweek_or_sunday":%s,"steps":[\n' "$RUN_TS" "$(pwd)" "$IS_SUNDAY" "$IS_MIDWEEK_OR_SUNDAY"

for i in "${!NAMES[@]}"; do
  name="${NAMES[$i]}"
  cmd="${CMDS[$i]}"
  step_num=$((i+1))
  start_s=$(date +%s)

  echo "[STEP ${step_num}/${step_total}] ${name}" | tee -a "$LOG_FILE"
  echo "CMD: ${cmd}" | tee -a "$LOG_FILE"

  out_file="$(mktemp)"
  bash -lc "$cmd" >"$out_file" 2>&1
  code=$?

  end_s=$(date +%s)
  dur=$((end_s-start_s))
  status="ok"
  err_excerpt=""

  if [ "$code" -ne 0 ]; then
    status="fail"
    fail_count=$((fail_count+1))
    err_excerpt="$(head -n 2 "$out_file" | tr '\n' ' ' | sed 's/"/\\"/g')"
  else
    ok_count=$((ok_count+1))
  fi

  cat "$out_file" >> "$LOG_FILE"
  rm -f "$out_file"

  completed_count=$step_num
  last_step_num=$step_num
  last_step_name="$name"
  last_step_status="$status"
  last_step_code=$code
  last_step_duration_s=$dur

  echo "RESULT: status=${status} code=${code} duration_s=${dur}" | tee -a "$LOG_FILE"
  echo | tee -a "$LOG_FILE"

  comma=","
  if [ "$i" -eq $((step_total-1)) ]; then
    comma=""
  fi

  printf '  {"n":%d,"name":"%s","status":"%s","code":%d,"duration_s":%d,"error":"%s"}%s\n' \
    "$step_num" "$name" "$status" "$code" "$dur" "$err_excerpt" "$comma"
done

printf '],"summary":{"ok":%d,"fail":%d,"total":%d,"is_sunday":%d,"is_midweek_or_sunday":%d}}\n' "$ok_count" "$fail_count" "$step_total" "$IS_SUNDAY" "$IS_MIDWEEK_OR_SUNDAY"

if [ "$fail_count" -eq 0 ] && [ "$completed_count" -eq "$step_total" ]; then
  emit_closeout "ok" "normal_exit"
else
  emit_closeout "partial" "normal_exit"
fi
