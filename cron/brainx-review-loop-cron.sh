#!/usr/bin/env bash
# BrainX Review Loop - near-event orchestrator.
# Owns the frequent BrainX review cadence and runs slower review-adjacent
# steps only when due.
set -euo pipefail

PATH="/home/clawd/.local/share/pnpm:/home/clawd/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"

JOB_SLUG="${BRAINX_REVIEW_LOOP_JOB_SLUG:-brainx-review-loop}"
RUN_TS="$(date +%Y%m%d-%H%M%S)"
STATE_DIR="/home/clawd/.openclaw/state/cron/${JOB_SLUG}"
LOG_DIR="/home/clawd/.openclaw/cron/runs"
LOCK_DIR="/home/clawd/.openclaw/state/cron/locks"
PAYLOAD_FILE="${STATE_DIR}/${JOB_SLUG}-${RUN_TS}.json"
LOG_FILE="${LOG_DIR}/${JOB_SLUG}-${RUN_TS}.log"
DUE_FILE="${STATE_DIR}/due-state.json"
FORCE_ALL="${BRAINX_REVIEW_LOOP_FORCE_ALL:-0}"

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
  job: process.env.BRAINX_REVIEW_LOOP_JOB_SLUG || 'brainx-review-loop',
  mode: 'review_loop',
  reason: 'already_running',
  paths: { payloadFile, logFile },
};
fs.writeFileSync(payloadFile, JSON.stringify(payload, null, 2) + '\n');
// Observability: write the skip reason to the run log so it is not a confusing
// 0-byte file. An overlapping run is a healthy no-op — the lock prevents double
// work — not a failure.
fs.writeFileSync(logFile, `### review-loop SKIPPED ts=${new Date().toISOString()} reason=already_running — previous run still holds ${(process.env.BRAINX_REVIEW_LOOP_JOB_SLUG || 'brainx-review-loop')}.lock; this tick did no work by design.\n`);
console.log(JSON.stringify(payload, null, 2));
NODE
    exit 0
  fi
fi

run_step() {
  local name="$1"
  local timeout_seconds="$2"
  local out_file="$3"
  shift 3
  set +e
  local code=0
  {
    echo "### step=${name} ts=$(date -Is) timeout=${timeout_seconds}s"
    timeout "${timeout_seconds}" "$@"
    code=$?
    echo "### step=${name} completed ts=$(date -Is) rc=${code}"
  } >"${out_file}" 2>>"${LOG_FILE}"
  set -e
  {
    echo ""
    echo "# ${name} exit=${code} output=${out_file}"
    cat "${out_file}" 2>/dev/null || true
    echo ""
  } >>"${LOG_FILE}"
  return "${code}"
}

is_due() {
  local key="$1"
  local interval_seconds="$2"
  if [ "$FORCE_ALL" = "1" ]; then
    return 0
  fi
  node - "$DUE_FILE" "$key" "$interval_seconds" <<'NODE'
const fs = require('fs');
const [file, key, intervalRaw] = process.argv.slice(2);
const interval = Number(intervalRaw || 0);
let state = {};
try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
const last = Number(state[key]?.lastOkEpoch || 0);
const now = Math.floor(Date.now() / 1000);
process.exit(!last || now - last >= interval ? 0 : 1);
NODE
}

mark_ok() {
  local key="$1"
  node - "$DUE_FILE" "$key" <<'NODE'
const fs = require('fs');
const [file, key] = process.argv.slice(2);
let state = {};
try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
state[key] = {
  lastOkEpoch: Math.floor(Date.now() / 1000),
  lastOkAt: new Date().toISOString(),
};
fs.mkdirSync(require('path').dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
NODE
}

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

run_named_step() {
  local name="$1"
  local timeout_seconds="$2"
  local due_key="$3"
  local due_interval_seconds="$4"
  local out_file="${STATE_DIR}/${JOB_SLUG}-${RUN_TS}.${name}.out"
  shift 4
  if [ -n "$due_key" ] && ! is_due "$due_key" "$due_interval_seconds"; then
    record_step "$name" "skipped" 0 "" "not_due"
    return 0
  fi
  local code=0
  run_step "$name" "$timeout_seconds" "$out_file" "$@" || code=$?
  if [ "$code" -eq 0 ]; then
    [ -n "$due_key" ] && mark_ok "$due_key"
    record_step "$name" "ok" "$code" "$out_file" ""
  else
    record_step "$name" "error" "$code" "$out_file" ""
  fi
  return 0
}

# Turn Harvester: reads new JSONL session turns since last checkpoint and routes
# extracted insights to brainx_memories, memory/YYYY-MM-DD.md and WORKING_STATE.md.
# Runs every loop (no is_due gate) — it self-checkpoints per session so repeated
# runs are always a fast no-op when there are no new turns.
run_named_step "turn-harvester" "${BRAINX_REVIEW_LOOP_HARVESTER_TIMEOUT_SECONDS:-600}" "" 0 \
  node /home/clawd/.openclaw/skills/brainx/scripts/turn-harvester.js --hours 1 --json

# Background review gated at 30 min when the loop fires every 10 min.
# Previously ran every loop on a 2h schedule; with the new 10-min cadence
# this guard prevents 6x skill-promoter calls per hour (overkill).
run_named_step "background-review" "${BRAINX_REVIEW_LOOP_BACKGROUND_TIMEOUT_SECONDS:-1200}" "backgroundReview" 1800 \
  bash /home/clawd/.openclaw/skills/brainx/cron/brainx-background-review-cron.sh

# Session Snapshot keeps the old 4h cadence, but is now gated inside the 10-min loop.
run_named_step "session-snapshot" "${BRAINX_REVIEW_LOOP_SNAPSHOT_TIMEOUT_SECONDS:-600}" "sessionSnapshot" 14400 \
  bash /home/clawd/.openclaw/skills/brainx/cron/brainx-session-snapshot-cron.sh

# Lightweight memory guardrails run every loop. They do not delete rows; they
# demote/quarantine through existing recall-governance fields and emit evidence.
run_named_step "guardrails" "${BRAINX_REVIEW_LOOP_GUARDRAIL_TIMEOUT_SECONDS:-600}" "" 0 \
  bash /home/clawd/.openclaw/skills/brainx/cron/brainx-review-loop-guardrails.sh

# Knowledge Sync keeps the old 7h cadence.
run_named_step "knowledge-sync" "${BRAINX_REVIEW_LOOP_KNOWLEDGE_TIMEOUT_SECONDS:-600}" "knowledgeSync" 25200 \
  bash /home/clawd/.openclaw/skills/brainx/cron/brainx-knowledge-sync-wrapper.sh

# ACP rotation-event ledger ingest: drains pending context-budget rotation events
# into brainx_session_rotation_events every loop (~2h) for near-real-time
# observability. Moved here from daily-core 2026-05-31 (rotations are frequent).
# Lightweight + idempotent; clean no-op when pending/ is empty.
run_named_step "acp-rotation-event-ingest" "120" "" 0 \
  node /home/clawd/.openclaw/skills/brainx/cron/brainx-acp-rotation-event-ingest.mjs

python3 - "$PAYLOAD_FILE" "$LOG_FILE" "$FORCE_ALL" "${STEP_NAMES[@]}" -- "${STEP_STATUS[@]}" -- "${STEP_CODES[@]}" -- "${STEP_OUTPUTS[@]}" -- "${STEP_REASONS[@]}" <<'PY'
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

payload_file, log_file, force_all = sys.argv[1:4]
parts = []
cur = []
for value in sys.argv[4:]:
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
errors = [s for s in steps if s["status"] == "error"]

def load_step_payload(step):
    path = step.get("outputFile")
    if not path:
        return None
    try:
        text = open(path, "r", encoding="utf-8").read()
    except OSError:
        return None
    decoder = json.JSONDecoder()
    for idx, char in enumerate(text):
        if char != "{":
            continue
        try:
            payload, _ = decoder.raw_decode(text[idx:])
            return payload
        except json.JSONDecodeError:
            continue
    return None

def applied_items(profile_payload, key):
    items = profile_payload.get(key, {}).get("applied", [])
    return items if isinstance(items, list) else []

def error_items(profile_payload, key):
    items = profile_payload.get(key, {}).get("errors", [])
    return items if isinstance(items, list) else []

def skipped_items(profile_payload, key):
    items = profile_payload.get(key, {}).get("skipped", [])
    return items if isinstance(items, list) else []

def manual_review_items(profile_payload, key):
    items = profile_payload.get(key, {}).get("manualReview", [])
    return items if isinstance(items, list) else []

def candidate_items(profile_payload):
    items = profile_payload.get("candidates", [])
    return items if isinstance(items, list) else []

def gate_payload(profile_payload, key):
    gates = profile_payload.get(key, {}).get("gates", {})
    return gates if isinstance(gates, dict) else {}

def bounded_strings(values, max_items=3, max_chars=220):
    out = []
    seen = set()
    for value in values if isinstance(values, list) else []:
        text = str(value or "").strip()
        if text.startswith("- "):
            text = text[2:].strip()
        if not text:
            continue
        if len(text) > max_chars:
            text = text[: max_chars - 1].rstrip() + "..."
        key = text.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(text)
        if len(out) >= max_items:
            break
    return out

def fmt_num(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "unknown"
    return f"{number:.2f}".rstrip("0").rstrip(".")

def find_candidate(candidates, profile, skill_name, action):
    for item in candidates:
        if (
            item.get("profile") == profile
            and item.get("skillName") == skill_name
            and item.get("action") == action
        ):
            return item
    return None

def rejection_explanation(reason, candidate, gates, profile):
    reason = str(reason or "unknown")
    candidate = candidate or {}
    gates = gates or {}
    if reason == "confidence_below_threshold":
        return "confidence " + fmt_num(candidate.get("confidence")) + " menor que el minimo " + fmt_num(gates.get("minConfidence"))
    if reason == "recurrence_below_threshold":
        return "recurrence " + fmt_num(candidate.get("recurrence")) + " menor que el minimo " + fmt_num(gates.get("minRecurrence"))
    if reason == "source_count_below_threshold":
        return "sourceCount " + fmt_num(candidate.get("sourceCount")) + " menor que el minimo " + fmt_num(gates.get("minSourceCount"))
    if reason == "missing_raw_session_evidence":
        return "requiere evidencia raw-session y no habia"
    if reason == "missing_brainx_confirmation":
        return "requiere confirmacion BrainX y no habia"
    if reason == "not_create_new_skill":
        return "autoCreate solo crea skills nuevas; este candidato es " + str(candidate.get("action") or "not create_new_skill")
    if reason == "not_existing_skill_patch":
        return "autoPatch solo parchea skills existentes; este candidato es " + str(candidate.get("action") or "not extend_existing_skill")
    if reason == "target_skill_not_registered":
        return "la skill destino no esta registrada en OpenClaw skills"
    if reason == "similar_existing_skill":
        return "ya existe una skill similar"
    if reason == "invalid_draft":
        return "el draft SKILL.md no tiene frontmatter valido"
    if reason.startswith("patch_risk_"):
        return "bloqueado por riesgo de patch: " + reason.replace("patch_risk_", "")
    return profile + " lo rechazo: " + reason

def candidate_summary(item, gates):
    instructions = bounded_strings(item.get("instructions", []))
    return {
        "profile": item.get("profile"),
        "skillName": item.get("skillName"),
        "action": item.get("action"),
        "decision": "review_only",
        "summary": (
            "Posible mejora para "
            + str(item.get("skillName") or "unknown skill")
            + ": "
            + (instructions[0] if instructions else "sin preview concreto de instrucciones")
        ),
        "instructions": instructions,
        "evidence": {
            "confidence": item.get("confidence"),
            "recurrence": item.get("recurrence"),
            "sourceCount": item.get("sourceCount"),
            "sourceKinds": item.get("sourceKinds", []),
            "sourceSessions": item.get("sourceSessions"),
            "brainxConfirmations": item.get("brainxConfirmations"),
        },
        "gates": gates,
    }

def manual_review_summary(item):
    instructions = bounded_strings(item.get("instructions", []), max_items=3, max_chars=260)
    skill_name = str(item.get("skillName") or "unknown skill")
    reason = str(item.get("reason") or "safety_gate")
    why = str(item.get("why") or "requiere revision humana")
    if reason.startswith("patch_risk_high:critical_skill"):
        why = "la evidencia apunta a una skill critica y el auto-patch esta bloqueado intencionalmente"
    evidence = (
        "confidence "
        + fmt_num(item.get("confidence"))
        + ", recurrence "
        + fmt_num(item.get("recurrence"))
        + ", sourceCount "
        + fmt_num(item.get("sourceCount"))
        + ", sesiones "
        + fmt_num(item.get("sourceSessions"))
        + ", confirmaciones BrainX "
        + fmt_num(item.get("brainxConfirmations"))
    )
    action = "Aplicar en " + skill_name if instructions else "Revisar " + skill_name
    return {
        "skillName": skill_name,
        "action": action,
        "blocker": reason,
        "why": why,
        "evidence": evidence,
        "instructions": instructions,
    }

def build_human_summary(report_reasons, candidates, rejected, applied, auto_errors, manual_review):
    lines = []
    if applied:
        lines.append("BrainX aplico " + str(len(applied)) + " cambio(s) de skill.")
    if manual_review:
        for item in manual_review[:2]:
            summary = manual_review_summary(item)
            first = summary["instructions"][0] if summary["instructions"] else summary["why"]
            lines.append("Manual requerido para " + summary["skillName"] + ": " + first)
            lines.append("Bloqueado por seguridad: " + summary["blocker"] + ". " + summary["why"] + ".")
    if candidates:
        grouped = {}
        for item in candidates:
            key = item.get("skillName") or "unknown skill"
            grouped.setdefault(key, item)
        for skill, item in list(grouped.items())[:3]:
            instructions = item.get("instructions") or []
            first = instructions[0] if instructions else "sin preview de instrucciones"
            lines.append("Candidato detectado para " + skill + ": " + first)
    if rejected and not manual_review:
        explanations = []
        for item in rejected[:4]:
            if item.get("explanation"):
                explanations.append(str(item.get("profile")) + ": " + str(item.get("explanation")))
        if explanations:
            lines.append("No se auto-aplico: " + "; ".join(explanations))
    if auto_errors:
        lines.append("Errores revisando skills: " + str(len(auto_errors)) + ".")
    if not lines and report_reasons:
        lines.append("BrainX Review Loop encontro actividad reportable.")
    return lines[:6]

def build_message_text(human_summary, candidates, rejected, applied, auto_errors, manual_review):
    lines = ["BrainX Review Loop detecto actividad reportable:"]
    if manual_review:
        for item in manual_review[:2]:
            summary = manual_review_summary(item)
            lines.append("- Manual review: " + summary["action"] + ".")
            for instruction in summary["instructions"][:3]:
                lines.append("  - " + instruction)
            lines.append("- Motivo: auto-patch bloqueado por `" + summary["blocker"] + "`; " + summary["why"] + ".")
            lines.append("- Evidencia: " + summary["evidence"] + ".")
        if len(manual_review) > 2:
            lines.append("- Manual review adicional: " + str(len(manual_review) - 2) + " candidato(s).")
    else:
        for line in human_summary:
            lines.append("- " + line)
    if candidates and not manual_review:
        first = candidates[0]
        evidence = first.get("evidence") or {}
        lines.append(
            "- Evidencia: confidence "
            + fmt_num(evidence.get("confidence"))
            + ", recurrence "
            + fmt_num(evidence.get("recurrence"))
            + ", sourceCount "
            + fmt_num(evidence.get("sourceCount"))
            + ", BrainX confirmations "
            + fmt_num(evidence.get("brainxConfirmations"))
        )
    if rejected and not manual_review:
        lines.append("- Decision: revision humana; no hubo cambio automatico.")
    if manual_review:
        lines.append("- Decision: revision humana; no hubo cambio automatico.")
    elif applied:
        lines.append("- Decision: cambio automatico aplicado.")
    if auto_errors:
        lines.append("- Revisar errores antes del proximo run.")
    return "\n".join(lines[:10])

def normalize_internal_error(source, value, fatal=False):
    if isinstance(value, dict):
        message = value.get("message") or value.get("error") or value.get("reason") or value.get("detail")
        err_type = value.get("type") or value.get("code") or value.get("name") or "internal_error"
        item = {k: v for k, v in value.items() if k not in ("message", "error", "reason", "detail", "type", "code", "name")}
        item.update({
            "source": source,
            "type": str(err_type or "internal_error"),
            "message": str(message or value)[:500],
            "fatal": bool(value.get("fatal", fatal)),
        })
        return item
    return {
        "source": source,
        "type": "internal_error",
        "message": str(value)[:500],
        "fatal": bool(fatal),
    }

def collect_guardrail_internal_errors(guardrails):
    if not isinstance(guardrails, dict):
        return []
    internal = []
    for source, values in [
        ("guardrails.quarantine", (guardrails.get("quarantine") or {}).get("errors") if isinstance(guardrails.get("quarantine"), dict) else None),
        ("guardrails.amnesia", (guardrails.get("amnesia") or {}).get("errors") if isinstance(guardrails.get("amnesia"), dict) else None),
        ("guardrails.artifacts", (guardrails.get("artifacts") or {}).get("errors") if isinstance(guardrails.get("artifacts"), dict) else None),
        ("guardrails.recall", (guardrails.get("recall") or {}).get("errors") if isinstance(guardrails.get("recall"), dict) else None),
        ("guardrails.duplicates", (guardrails.get("duplicates") or {}).get("errors") if isinstance(guardrails.get("duplicates"), dict) else None),
        ("guardrails.handoffs", (guardrails.get("handoffs") or {}).get("errors") if isinstance(guardrails.get("handoffs"), dict) else None),
        ("guardrails.staleness", (guardrails.get("staleness") or {}).get("errors") if isinstance(guardrails.get("staleness"), dict) else None),
        ("guardrails", guardrails.get("errors")),
    ]:
        if isinstance(values, list):
            for value in values:
                internal.append(normalize_internal_error(source, value))
        elif values:
            internal.append(normalize_internal_error(source, values))
    seen = set()
    deduped = []
    for item in internal:
        key = (item.get("type"), item.get("message"))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped

def dedupe_manual_review(items):
    best = {}
    priority = {"autoPatch": 0, "autoCreate": 1}
    for item in items if isinstance(items, list) else []:
        key = (
            str(item.get("skillName") or ""),
            str(item.get("action") or ""),
            "|".join([str(x).strip() for x in (item.get("instructions") or [])[:2]]),
        )
        current = best.get(key)
        if current is None or priority.get(str(item.get("profile")), 9) < priority.get(str(current.get("profile")), 9):
            best[key] = item
    return list(best.values())

step_payloads = {s["name"]: load_step_payload(s) for s in steps}
background = step_payloads.get("background-review") or {}
guardrails = step_payloads.get("guardrails") or {}
internal_errors = collect_guardrail_internal_errors(guardrails)
auto_patch = ((background.get("profiles") or {}).get("autoPatch") or {})
auto_create = ((background.get("profiles") or {}).get("autoCreate") or {})
auto_patch_gates = gate_payload(auto_patch, "autoPatch")
auto_create_gates = gate_payload(auto_create, "autoCreate")

applied = [
    {"profile": "autoPatch", **item} for item in applied_items(auto_patch, "autoPatch")
] + [
    {"profile": "autoCreate", **item} for item in applied_items(auto_create, "autoCreate")
]
auto_errors = [
    {"profile": "autoPatch", **item} for item in error_items(auto_patch, "autoPatch")
] + [
    {"profile": "autoCreate", **item} for item in error_items(auto_create, "autoCreate")
]
manual_review = [
    {"profile": "autoPatch", **item} for item in manual_review_items(auto_patch, "autoPatch")
] + [
    {"profile": "autoCreate", **item} for item in manual_review_items(auto_create, "autoCreate")
]
manual_review = dedupe_manual_review(manual_review)
rejected = [
    {
        "profile": "autoPatch",
        "skillName": item.get("skillName"),
        "action": item.get("action"),
        "reason": item.get("reason"),
        "gates": auto_patch_gates,
    }
    for item in skipped_items(auto_patch, "autoPatch")
] + [
    {
        "profile": "autoCreate",
        "skillName": item.get("skillName"),
        "action": item.get("action"),
        "reason": item.get("reason"),
        "gates": auto_create_gates,
    }
    for item in skipped_items(auto_create, "autoCreate")
]
candidates = [
    {
        "profile": "autoPatch",
        "skillName": item.get("skillName"),
        "action": item.get("action"),
        "confidence": item.get("confidence"),
        "recurrence": item.get("recurrence"),
        "sourceCount": item.get("sourceCount"),
        "sourceKinds": item.get("sourceKinds", []),
        "sourceSessions": item.get("sourceSessions"),
        "brainxConfirmations": item.get("brainxConfirmations"),
        "instructions": bounded_strings(item.get("instructions", [])),
        "summary": candidate_summary({"profile": "autoPatch", **item}, auto_patch_gates).get("summary"),
    }
    for item in candidate_items(auto_patch)
] + [
    {
        "profile": "autoCreate",
        "skillName": item.get("skillName"),
        "action": item.get("action"),
        "confidence": item.get("confidence"),
        "recurrence": item.get("recurrence"),
        "sourceCount": item.get("sourceCount"),
        "sourceKinds": item.get("sourceKinds", []),
        "sourceSessions": item.get("sourceSessions"),
        "brainxConfirmations": item.get("brainxConfirmations"),
        "instructions": bounded_strings(item.get("instructions", [])),
        "summary": candidate_summary({"profile": "autoCreate", **item}, auto_create_gates).get("summary"),
    }
    for item in candidate_items(auto_create)
]

for item in rejected:
    match = find_candidate(candidates, item.get("profile"), item.get("skillName"), item.get("action"))
    item["explanation"] = rejection_explanation(item.get("reason"), match, item.get("gates"), item.get("profile") or "profile")

candidate_details = [
    candidate_summary(item, auto_patch_gates if item.get("profile") == "autoPatch" else auto_create_gates)
    for item in candidates
]

report_reasons = []
if errors:
    report_reasons.append("step_error")
if applied:
    report_reasons.append("skill_change_applied")
if auto_errors:
    report_reasons.append("skill_review_error")
if internal_errors:
    report_reasons.append("internal_error")
if manual_review:
    report_reasons.append("manual_skill_review_required")
if candidates or rejected:
    report_reasons.append("skill_candidate_reviewed")

guard_summary = guardrails.get("summary") if isinstance(guardrails, dict) else {}
guard_reportable = False
if isinstance(guard_summary, dict):
    guard_reportable = any(int(guard_summary.get(key) or 0) > 0 for key in [
        "quarantined",
        "degradedMemories",
        "reviewRequired",
        "amnesiaFailed",
        "artifactsDegraded",
        "recallNoiseCandidates",
        "duplicateCollapsed",
        "weakHandoffs",
        "possiblyStale",
    ])
if guard_reportable:
    report_reasons.append("memory_guardrail_activity")

human_summary = build_human_summary(report_reasons, candidate_details, rejected, applied, auto_errors, manual_review)
if internal_errors:
    human_summary = (human_summary + [
        "Errores internos no fatales: " + str(len(internal_errors)) + " en guardrails."
    ])[:6]
if guard_reportable:
    guard_lines = []
    if int(guard_summary.get("quarantined") or 0):
        guard_lines.append("Guardrails: " + str(guard_summary.get("quarantined")) + " memoria(s) en cuarentena.")
    if int(guard_summary.get("degradedMemories") or 0) or int(guard_summary.get("artifactsDegraded") or 0):
        guard_lines.append("Guardrails: degradados " + str(guard_summary.get("degradedMemories") or 0) + " memoria(s) y " + str(guard_summary.get("artifactsDegraded") or 0) + " artifact(s).")
    if int(guard_summary.get("amnesiaFailed") or 0):
        guard_lines.append("Amnesia smoke: " + str(guard_summary.get("amnesiaFailed")) + " memoria(s) recientes no recuperaron.")
    if int(guard_summary.get("recallNoiseCandidates") or 0):
        guard_lines.append("Recall sampler: " + str(guard_summary.get("recallNoiseCandidates")) + " memoria(s) con seleccion repetida sin señal.")
    if int(guard_summary.get("weakHandoffs") or 0):
        guard_lines.append("Handoff check: " + str(guard_summary.get("weakHandoffs")) + " snapshot(s) debiles para revisar.")
    if int(guard_summary.get("possiblyStale") or 0):
        guard_lines.append("Staleness check: " + str(guard_summary.get("possiblyStale")) + " memoria(s) marcadas como posiblemente stale.")
    human_summary = (human_summary + guard_lines)[:6]
message_text = build_message_text(human_summary, candidate_details, rejected, applied, auto_errors, manual_review) if report_reasons else None

def stable_texts(values):
    out = []
    seen = set()
    for value in values if isinstance(values, list) else []:
        text = str(value or "").strip()
        if not text:
            continue
        key = " ".join(text.split()).casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(text)
    return out

def stable_candidate_key(item):
    return {
        "profile": item.get("profile"),
        "skillName": item.get("skillName"),
        "action": item.get("action"),
        "instructions": stable_texts(item.get("instructions", []))[:5],
    }

def stable_manual_review_key(item):
    key = stable_candidate_key(item)
    key["reason"] = item.get("reason")
    key["blocker"] = item.get("blocker")
    key["why"] = item.get("why")
    return key

def stable_rejected_key(item):
    return {
        "profile": item.get("profile"),
        "skillName": item.get("skillName"),
        "action": item.get("action"),
        "reason": item.get("reason"),
        "explanation": item.get("explanation"),
    }

def stable_error_key(item):
    return {
        "profile": item.get("profile"),
        "skillName": item.get("skillName"),
        "type": item.get("type") or item.get("code") or item.get("reason"),
        "message": item.get("message") or item.get("error"),
    }

def stable_internal_error_key(item):
    return {
        "source": item.get("source"),
        "type": item.get("type"),
        "message": item.get("message"),
        "fatal": item.get("fatal"),
    }

def stable_guardrail_key(summary):
    if not isinstance(summary, dict):
        return {}
    # Counts in guardrail summaries naturally drift between runs; use category
    # presence for notification dedupe so the same unresolved bucket does not
    # page the reports channel every two hours.
    return {
        key: int(summary.get(key) or 0) > 0
        for key in [
            "quarantined",
            "degradedMemories",
            "reviewRequired",
            "amnesiaFailed",
            "artifactsDegraded",
            "recallNoiseCandidates",
            "duplicateCollapsed",
            "weakHandoffs",
            "possiblyStale",
        ]
    }

stable_reasons = list(dict.fromkeys(report_reasons))
signature_source = {
    "schema": "brainx_review_loop_stable_v2",
    "reasons": stable_reasons,
    "applied": [stable_candidate_key(item) for item in applied],
    "autoErrors": [stable_error_key(item) for item in auto_errors],
    "internalErrors": [stable_internal_error_key(item) for item in internal_errors],
    "manualReview": [stable_manual_review_key(item) for item in manual_review],
    "candidates": [stable_candidate_key(item) for item in candidates],
    "rejected": [stable_rejected_key(item) for item in rejected],
    "guardrails": stable_guardrail_key(guard_summary),
}
signature = hashlib.sha256(
    json.dumps(signature_source, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
).hexdigest()
report_state_file = os.path.join(os.path.dirname(payload_file), "report-state.json")
previous_signature = None
try:
    previous_signature = json.load(open(report_state_file, "r", encoding="utf-8")).get("lastSignature")
except Exception:
    previous_signature = None
has_reportable = bool(report_reasons)
is_new_report = has_reportable and signature != previous_signature
if is_new_report:
    with open(report_state_file, "w", encoding="utf-8") as f:
        json.dump({
            "lastSignature": signature,
            "lastReportAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "reasons": report_reasons,
        }, f, ensure_ascii=False, indent=2)
        f.write("\n")
payload = {
    "ok": not errors,
    "status": "ok" if not errors else "error",
    "job": os.environ.get("BRAINX_REVIEW_LOOP_JOB_SLUG", "brainx-review-loop"),
    "mode": "review_loop",
    "forceAll": force_all == "1",
    "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "summary": {
        "total": len(steps),
        "ok": sum(1 for s in steps if s["status"] == "ok"),
        "skipped": sum(1 for s in steps if s["status"] == "skipped"),
        "errors": len(errors) + len(internal_errors),
        "stepErrors": len(errors),
        "internalErrors": len(internal_errors),
    },
    "internalErrors": internal_errors[:20],
    "report": {
        "shouldNotify": is_new_report,
        "hasReportable": has_reportable,
        "deduped": has_reportable and not is_new_report,
        "reasons": report_reasons,
        "signature": signature if has_reportable else None,
        "counts": {
            "applied": len(applied),
            "skillReviewErrors": len(auto_errors),
            "internalErrors": len(internal_errors),
            "manualReview": len(manual_review),
            "candidates": len(candidates),
            "rejected": len(rejected),
            "guardrails": guard_summary if isinstance(guard_summary, dict) else {},
        },
        "humanSummary": human_summary,
        "messageText": message_text,
        "applied": applied[:5],
        "errors": auto_errors[:5],
        "internalErrors": internal_errors[:10],
        "candidateDetails": candidate_details[:5],
        "manualReview": manual_review[:5],
        "candidates": candidates[:5],
        "rejected": rejected[:5],
        "guardrails": guardrails if isinstance(guardrails, dict) else None,
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
