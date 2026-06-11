# BrainX — Cron Jobs & Pipeline

Last verified: `2026-06-07 16:41 -04`
Scope: `/home/clawd` host only

This file documents the scheduler that is actually active on this host. Do not infer production state from scripts existing on disk; use this file, `docs/RUNTIME_STATUS.md`, `config/surface-policy.json`, and `openclaw cron list --json`.

## ⚠️ READ FIRST — Regla #1 al auditar crons BrainX: `enabled=false` ≠ no corre

**La trampa:** varios crons BrainX standalone aparecen `enabled=false` en `openclaw cron list` / `jobs.json`. Eso **NO significa que estén apagados ni dormidos.** Son *disabled rollback stubs*: su trabajo fue **FUSIONADO a propósito** como *steps* dentro de los 2 orquestadores activos. Concluir "ese script no corre / no llama a su API" mirando solo el flag `enabled` del standalone es **incorrecto** (error real cometido 2026-05-31).

**Qué absorbió a qué (mapa de ejecución efectiva):**

| Orquestador activo | Schedule | Absorbe (corren como steps suyos) |
|---|---|---|
| **BrainX Maintenance** | diario 06:10 → `brainx-maintenance-cron.sh` | step `daily-core` = `brainx-daily-core-wrapper.sh` (15 steps diarios, +Wed/Sun), `injection-health`, y (domingo) `cleanup` + `skill-curator` |
| **BrainX Review Loop** | cada 2h → `brainx-review-loop-cron.sh` | `background-review` (skill-promoter), `session-snapshot` (gated 4h), `knowledge-sync` (gated 7h), `review-loop-guardrails` |
| **BrainX Nightly Memory Loop** | diario 23:50 → `brainx-nightly-memory-loop-cron.sh` | `memory-daily-consolidate`, luego `memory-daily-closeout`; `dreaming-promotion` queda fase guarded/deshabilitada |
| **BrainX Amnesia Smoke** | horario | recall canary (no escribe) |

**Ejemplo de la trampa (verificado):** `memory-distiller`, `session-harvester`, `error-harvester`, `trajectory-recorder` salen `enabled=false` como cron, pero corren **A DIARIO** vía `Maintenance → daily-core` (ver tabla "Daily Steps" abajo). `session-snapshot` corre cada 4h vía Review Loop. `promotion-applier` corre domingos.

**Cómo verificar de verdad (no te saltes esto):**
0. **Vía rápida (recomendada):** `node /home/clawd/.openclaw/workspace/scripts/brainx-cron-effective-map.mjs` — read-only, parsea los wrappers y te imprime cada step → orquestador padre → cadencia real → si llama a OpenAI (chat/embeddings). Hace por vos los pasos 1-3 de abajo. Usá `--json` para máquina.
1. `openclaw cron list --json` → SOLO te dice qué orquestadores están ON (Maintenance, Review Loop, Nightly Memory Loop, Amnesia Smoke). Ignorá los `enabled=false`; están absorbidos, no muertos.
2. Para saber qué scripts corren y a qué cadencia, leé los **steps de los wrappers**: `brainx-daily-core-wrapper.sh`, `brainx-review-loop-cron.sh`, `brainx-maintenance-cron.sh` (o la tabla "Daily Core Pipeline" de este archivo).
3. Para "¿qué llama a APIs externas (OpenAI chat/embeddings)?": `grep -nE "new OpenAI|api.openai.com" skills/brainx/scripts/*.js skills/brainx/lib/*.js` y crúzalo con los steps vivos.
   - **Chat/razonamiento (2026-05-31): YA NO va a OpenAI.** `memory-distiller`, `trajectory-recorder` y `promotion-applier` ahora rutean su llamada de chat por el **gateway agent `brainx-reviewer` (gpt-5.5 OAuth, sin API key metered)** vía `lib/agent-llm.js` (`callAgentLLM`). No reintroducir `fetch api.openai.com/chat/completions` ni `openai.chat.completions.create` en esos scripts.
   - **Embeddings: siguen en OpenAI** (decisión aparte, pendiente). Directos: `session-snapshot.js`, `trajectory-recorder.js` (`/v1/embeddings`). Indirectos al guardar memoria: `lib/openai-rag.js` / `lib/embedding-client.js` (usados por distiller, harvester, bridge, handoff-promoter, guardrails). Migrar a `embeddinggemma` local implica re-embeber ~862 chunks.
   - `lib/working-memory.js` ya usa minimax (baseURL), no OpenAI.

## Scheduling Architecture

BrainX uses OpenClaw internal cron as the primary scheduler for BrainX/Memory jobs.

- **OpenClaw cron config:** `/home/clawd/.openclaw/cron/jobs.json`
- **Executor agents:** `brainx-reviewer` is the sole BrainX executor for operational wrappers and semantic reviewer dry-runs; `alert` remains for generic Memory jobs and failure alerts
- **Delivery:** Discord `channel:1490714485755740290`; `BrainX Review Loop` reports only new actionable skill candidates/changes/errors and replies `NO_REPLY` for quiet or deduped runs. Candidate payloads include `report.humanSummary`, `report.messageText`, instruction previews, evidence counts, gate thresholds, and rejection explanations.
- **Session mode:** isolated
- **Wrapper root:** `/home/clawd/.openclaw/skills/brainx/cron`
- **Legacy wrapper links:** selected `/home/clawd/.openclaw/workspace/scripts/brainx-*` and `memory-*-cron.sh` paths are symlinks only for rollback compatibility
- **BrainX skill root:** `/home/clawd/.openclaw/skills/brainx`

Operational count:

- **4 enabled direct OpenClaw BrainX jobs**
- **7 BrainX-related jobs if mixed `clawd` crontab wrappers/resilience jobs are included**

Latest live check:

- `BrainX Review Loop` is enabled, owned by `brainx-reviewer`, last run `ok`, consecutive errors `0`.
- `BrainX Maintenance` is enabled, owned by `brainx-reviewer`, last run `ok`, consecutive errors `0`.
- `BrainX Nightly Memory Loop` is enabled, owned by `brainx-reviewer`, and absorbs the old daily consolidate/closeout jobs.
- Absorbed BrainX work remains consolidated into three orchestrators plus the hourly canary; no standalone rollback job is required for normal operation.

Do not add OS/package/system crons to this count unless explicitly auditing the whole server.

Ownership rule:

- Active BrainX OpenClaw jobs must use `brainx-reviewer`.
- Do not create a second BrainX cron agent such as `brainx-ops`.
- Generic OpenClaw cron jobs continue to use `alert` unless another owner is explicitly documented.
- Generic Memory jobs are adjacent to BrainX but are not automatically BrainX-owned.

## Direct OpenClaw BrainX/Memory Jobs

| # | Job | Agent | Schedule | Wrapper / command | Status |
|---|---|---|---|---|---|
| 1 | `BrainX Amnesia Smoke` | `brainx-reviewer` | hourly at `:05` America/Caracas | `brainx-amnesia-smoke-cron.sh` | active; lightweight recall canary, alerts after 2 consecutive failures |
| 2 | `BrainX Review Loop` | `brainx-reviewer` | every 2h at `:35` America/Caracas | `brainx-review-loop-cron.sh` | active; runs Background Review + memory guardrails every loop, Session Snapshot when due, Knowledge Sync when due; delivery to reports only when `report.shouldNotify=true` |
| 3 | `BrainX Maintenance` | `brainx-reviewer` | daily `06:10` America/Caracas | `brainx-maintenance-cron.sh` | active |
| 4 | `BrainX Nightly Memory Loop` | `brainx-reviewer` | daily `23:50` America/Port_of_Spain | `brainx-nightly-memory-loop-cron.sh` | active; runs cross-workspace consolidate + deterministic closeout; dreaming phase guarded |
| - | `BrainX Background Review` | `brainx-reviewer` | every 2h at `:35` America/Caracas | `brainx-background-review-cron.sh` | disabled rollback; absorbed by Review Loop |
| - | `BrainX Session Snapshot` | `brainx-reviewer` | every 4h | `brainx-session-snapshot-cron.sh` | disabled rollback; absorbed by Review Loop |
| - | `BrainX Knowledge Sync` | `brainx-reviewer` | every 7h | `brainx-knowledge-sync-wrapper.sh` | disabled rollback; absorbed by Review Loop |
| - | `BrainX Daily Core Pipeline V5` | `brainx-reviewer` | daily `06:10` | `brainx-daily-core-wrapper.sh` | disabled rollback; absorbed by Maintenance |
| - | `BrainX Injection Health (24h)` | `brainx-reviewer` | daily `07:30` America/Caracas | `brainx-injection-health.sh` | disabled rollback; absorbed by Maintenance |
| - | `BrainX Cleanup (snapshots+trajectories)` | `brainx-reviewer` | Sunday `04:00` | `brainx-cleanup-cron.sh` | disabled rollback; absorbed by Maintenance |
| - | `BrainX Skill Curator` | `brainx-reviewer` | Sunday `08:45` America/Caracas | `brainx-skill-curator-cron.sh` | disabled rollback; absorbed by Maintenance |
| - | `BrainX Skill Promoter (daily light dry-run)` | `brainx-reviewer` | daily `07:05` America/Caracas | replaced by Background Review | disabled |
| - | `Memory Daily Consolidate (cross-workspace)` | `brainx-reviewer` | daily `23:50` America/Port_of_Spain | `memory-daily-consolidate-cron.sh` | disabled rollback; absorbed by Nightly Memory Loop |
| - | `Memory Daily Closeout (compact summary)` | `brainx-reviewer` | daily `23:55` America/Port_of_Spain | `memory-daily-closeout-cron.sh` | disabled rollback; absorbed by Nightly Memory Loop |

## Mixed `clawd` Crontab Jobs That Include BrainX

These are not direct BrainX OpenClaw jobs, but they execute BrainX steps.

| # | Job | Schedule | BrainX step |
|---|---|---|---|
| 11 | `observe-telemetry` | every 30 min | `brainx-session-rotation-monitor.mjs` plus `brainx-health-check` via `/home/clawd/.openclaw/skills/brainx/cron/health-check.sh` |
| 12 | `backup-all-dbs` | daily `03:00` | runs `brainx-weekly-backup` on Sundays via `/home/clawd/.openclaw/skills/brainx/scripts/weekly-backup.sh` |
| 13 | `brainx-cron-supervisor` | every 30 min | deterministic fallback supervisor for direct BrainX OpenClaw jobs |

## Resilience Layer

As of `2026-04-30`, the direct OpenClaw BrainX/Memory jobs are hardened with:

- widened `payload.timeoutSeconds` for scheduled agent turns
- `lightContext=true` to reduce prompt overhead for cron sessions
- `toolsAllow=["exec"]` so the alert agent has a narrow execution surface
- `delivery.bestEffort=true` so Discord delivery failure does not mark the job failed after the wrapper has succeeded
- failure alerts after 1 consecutive error with 30 minute cooldown

Additional fallback:

- OS crontab runs `/home/clawd/.openclaw/workspace/scripts/brainx-cron-supervisor.mjs` every 30 minutes through `cron-heartbeat-runner.sh`.
- The supervisor reads `/home/clawd/.openclaw/cron/jobs.json` and `/home/clawd/.openclaw/cron/jobs-state.json`.
- It skips any job whose OpenClaw schedule is `enabled=false`, so disabled rollback jobs cannot be reactivated by fallback.
- If an enabled direct BrainX OpenClaw job has `lastStatus=error` after its grace window, or is stale past `nextRunAtMs`, the supervisor runs the same deterministic wrapper directly with bounded timeout.
- Per failed scheduled run, fallback retries are capped and backoff-gated so it does not loop forever.
- Fallback details are written to `/home/clawd/.openclaw/state/cron/brainx-cron-supervisor-details.json` and `/home/clawd/.openclaw/cron/runs/brainx-cron-supervisor-*.log`.
- `brainx-weekly-backup` is executed inside `backup-all-dbs` on Sundays through `cron-heartbeat-runner.sh`, so its own heartbeat file stays current.

## BrainX Daily Core Pipeline V5

The wrapper is `/home/clawd/.openclaw/skills/brainx/cron/brainx-daily-core-wrapper.sh`.

Production scheduling note: this wrapper is no longer a standalone enabled
OpenClaw cron. It is called as the first step of `BrainX Maintenance`.

Current topology:

- **16 daily steps** run every day.
- **2 midweek steps** run on Wednesday and Sunday.
- **8 Sunday-only steps** run only on Sunday.
- Wednesday total: **18 steps**.
- Sunday total: **26 steps**.

### Daily Steps

| # | Step | Command | Purpose |
|---|---|---|---|
| 1 | `memory-daily-bootstrap` | `bash memory-daily-bootstrap-cron.sh` | Creates today/yesterday `memory/YYYY-MM-DD.md` files across workspaces |
| 2 | `memory-distiller` | `node scripts/memory-distiller.js --hours 8 --max-sessions 4` | LLM extraction from recent session transcripts |
| 3 | `session-harvester` | `node scripts/session-harvester.js --hours 12 --max-sessions 10` | Regex/heuristic capture from session JSONLs |
| 4 | `handoff-promoter` | `node scripts/handoff-promoter.js --hours 24 --limit 30 --json` | Promotes stable session snapshot handoffs into hot memories and artifact ledger rows |
| 5 | `memory-bridge` | `node scripts/memory-bridge.js --hours 8 --max-memories 25` | Syncs workspace `memory/*.md` into BrainX DB |
| 6 | `cross-agent-learning` | `node scripts/cross-agent-learning.js --hours 24 --max-shares 12` | Shares high-signal verified learnings/gotchas across agents |
| 7 | `context-pack-builder` | `node scripts/context-pack-builder.js --days 7` | Builds/upserts compact maintenance context packs; not active runtime retrieval |
| 8 | `error-harvester` | `node scripts/error-harvester.js --hours 24` | Converts recent command failures into gotchas |
| 9 | `acp-rotation-event-ingest` | `node ${MONITOR_SCRIPTS}/brainx-acp-rotation-event-ingest.mjs` | Drains the Claude ACP rotation-event ledger (`state/brainx/acp-rotation-events/pending` → table `brainx_session_rotation_events`) so context-budget rotations are recorded. Lightweight + idempotent; no-op when pending is empty. See `docs/ACP_CONTEXT_CONTINUITY.md`. |
| 10 | `reclassify-memories` | `node scripts/reclassify-memories.js` | Keeps categories/types current |
| 11 | `degrade-over-injected` | `node scripts/degrade-over-injected.js --apply --json` | Demotes over-injected memories that agents never reference |
| 12 | `self-learning-audit` | `node scripts/self-learning-audit.js --days 14 --limit 25 --json` | Read-only autonomy report for noisy/useful memories, stale rows, repeated failures, knowledge gaps, and low-recall query signals |
| 13 | `doctor-actionable-fix` | `./brainx fix --only stale-demotion,auto-dedup,runtime-scoring-backlog --json` | Demotes doctor-actionable stale hot/warm memories, supersedes high-similarity duplicate pairs, and closes stale runtime scoring rows |
| 14 | `wiki-compile` | `./brainx wiki compile --json` | Refreshes `/home/clawd/brainx-vault` and runtime digest source |
| 15 | `runtime-regression-suite` | `brainx-regression-suite.sh` | Verifies runtime guardrails and invariants |
| 16 | `trajectory-recorder` | `node scripts/trajectory-recorder.js --hours 24 --max-sessions 12` | Stores problem→solution→outcome trajectories |
| 17 | `method-error-harvester` | `node scripts/method-error-harvester.js --days 2 --top 10 --shadow --json` | Captures METHOD/diagnostic errors (agent asserted wrong hypothesis → corrected) as injectable `gotcha` memories. 2-pass: regex candidates + cost-0 gpt-5.5 OAuth confirmation. **SHADOW (report-only) durante semana de validación**; flip a `--capture --tier warm` tras revisar precisión. Ver §Method-Error Harvester. |

### Wednesday + Sunday Steps

| Step | Command | Purpose |
|---|---|---|
| `lifecycle-run` | `./brainx lifecycle-run --json` | Tier decay, lifecycle stats and stale cleanup |
| `contradiction-detector` | `node scripts/contradiction-detector.js --top 60 --threshold 0.85` | Finds semantic contradictions and supersedes stale rows |

### Sunday-Only Steps

| Step | Command | Purpose |
|---|---|---|
| `memory-consolidation` | `bash cron/weekly-semantic-consolidation.sh --force` | Consolidates mature same-scope memories |
| `auto-promoter` | `node scripts/auto-promoter.js --days 30 --min-recurrence 6 --save` | Detects recurring rule candidates |
| `promotion-applier` | `node scripts/promotion-applier.js --limit 15 --min-recurrence 5` | Distills review-gated promotion suggestions |
| `memory-enforcer` | `memory-enforcer-cron.sh` | Checks workspace memory structure |
| `memory-audit` | `memory-audit-alert-cron.sh` | Audits memory health and amnesia signals |
| `dedup-supersede` | `node scripts/dedup-supersede.js` | Supersedes exact duplicate memories |
| `cleanup-low-signal` | `node scripts/cleanup-low-signal.js` | Degrades very short low-signal rows |
| `method-error-promoter` | `node scripts/method-error-promoter.js --window 90 --min-referenced 1 --apply --json` | Durability layer: promotes method-error gotchas that were REFERENCED by real agents (`brainx_runtime_injections.referenced_ids`) from `agent_inference` (SECONDARY, ~14d recency cap) to `knowledge_canonical` (PRIMARY, no cap) so durable lessons survive. Criterion = real usage evidence. Idempotent. |

## Method-Error Harvester (errores de método/diagnóstico)

Cierra el gap histórico: ningún loop capturaba **errores de método** (el agente
afirma una hipótesis o fix equivocado → se corrige tras pushback o al hallar la
causa real). No producen fallo de comando/tool, así que `error-harvester` (command
failures) no los ve. Antes solo se capturaban con `brainx add` manual.

Script: `skills/brainx/scripts/method-error-harvester.js`. Dos pasadas:
1. **Pass 1 (regex, gratis):** detecta la firma auto-corrección (admisión + hipótesis previa / pushback del usuario), `score ≥ 3`.
2. **Pass 2 (LLM, cost-0):** `lib/agent-llm.js` → `brainx-reviewer` (gpt-5.5 OAuth) confirma que es real y extrae un gotcha **síntoma-primero y generalizado** (no atado a la plataforma) + `method_tags`.

**Decisión clave:** se guarda como `--type gotcha`, NO `lesson`. Solo `fact|decision|gotcha`
son inyectables por el plugin (`extensions/brainx/src/bridge.ts:77` `ALLOWED_RECALL_TYPES`).
Un `lesson` jamás se inyectaría. Single-shot: se escribe con `recurrence=1` (no espera
recurrencia ≥2, porque el error de método suele pasar una sola vez y de alto impacto).

**Estado: LIVE (capture)** desde 2026-05-31. Step diario del Daily Core:
`--days 2 --top 10 --capture --tier warm --min-confidence 0.8 --json`. Escribe cada gotcha
confirmado con: `--type gotcha`, `--tier warm`, `--verificationState verified`,
`--sourceKind agent_inference`, `--category error`, `--importance` (LLM, ≥7), tags
`method-error,cross-agent,<method_tags>`, `recurrence=1` (single-shot).

**Por qué esa combinación exacta** (`extensions/brainx/src/bridge.ts decideRecallRow`):
- `verified` es obligatorio — L2720 rechaza cualquier otro estado, incluso same-agent.
- `agent_inference` (SECONDARY) pasa por `isVerifiedInferenceRowAllowed` (L2103) porque `category=error` califica (L2112). Es la clasificación honesta: inferencia de agente confirmada por 2º pase LLM, no `tool_verified`.
- tag `cross-agent` → habilita recall por OTRO agente (L2660), el punto del sistema.

**Durabilidad (RESUELTO 2026-05-31):** el path SECONDARY exige `recent` (L2110, 14d/21d) — medido desde `created_at` porque `brainx_memories` NO tiene `updated_at` y `rowAgeDays` cae a created_at (no se refresca por uso). Para que las lecciones durables sobrevivan >14d, el step dominical `method-error-promoter` promueve a `source_kind=knowledge_canonical` (PRIMARY, sin cap, L2709) SOLO los gotchas que fueron **referenciados por agentes reales** (`brainx_runtime_injections.referenced_ids`). Criterio = evidencia de uso, no suposición → honesto. Ver §Sunday-Only Steps.

**OJO — divergencia CLI vs plugin:** `brainx inject` (CLI, `lib/cli.js:490` `trustedInjectRow`) solo acepta source kinds PRIMARY, NO implementa el path `agent_inference`. Por eso `brainx inject` da vacío para estos gotchas aunque el plugin de producción sí los recall. El CLI `inject` NO es un test fiel del recall runtime.

**Trazabilidad (read-only):** `node skills/brainx/scripts/method-error-report.js --days 30 [--json]` muestra el embudo completo desde datos ya registrados: capturado (`brainx_memories` tag method-error) → inyectado (`brainx_runtime_injections.memory_ids`) → referenciado por un agente (`referenced_ids`/`soft_referenced_ids` = lo USÓ) → promovido a durable (`source_kind=knowledge_canonical`). Es la forma de validar empíricamente, en días/semanas, si el loop funcionó.

**Red de seguridad autónoma (no hay gate manual):** 2-pass confirm + `--min-confidence 0.8` + dedup (`minSimilarity 0.85`) + ledger `data/method-errors-seen.json` (solo persiste en `--capture`, no en shadow). `degrade-over-injected` (step diario) demota cualquier gotcha inyectado ≥20× en 7d sin ser referenciado. Modo shadow disponible para auditar: `--shadow`.

## Session Snapshot + Handoff Promoter

`BrainX Session Snapshot` is due-gated every 4h inside `BrainX Review Loop`.

Wrapper:

```bash
bash /home/clawd/.openclaw/skills/brainx/cron/brainx-session-snapshot-cron.sh
```

It performs two steps:

1. `session-snapshot.js --hours 5 --max-sessions 12 --json`
2. `handoff-promoter.js --hours 6 --limit 24 --json`

The snapshot step stores structured state in `brainx_session_snapshots`.

The promoter step makes handoff durable:

- promotes final artifacts and high-signal summaries into `brainx_memories` tier `hot`
- upserts durable paths into `brainx_artifact_ledger`
- rejects `/tmp` as durable artifact path
- redacts emails
- skips password/token/credential summaries
- excludes `alert`, `monitor`, and `heartbeat`
- uses deterministic IDs to avoid duplicate artifacts and needless re-embedding

This is the fix for the prior passive-handoff gap: a snapshot existing in DB is not enough; important handoff state must become durable memory/artifact state.

## Review Loop Guardrails

`BrainX Review Loop` runs `review-loop-guardrails.js` every 2h after the snapshot gate.
`BrainX Amnesia Smoke` runs the same script in `--mode amnesia-smoke` hourly, without quarantine/degrade/write actions, and only alerts after 2 consecutive failed recall canaries.

Wrapper:

```bash
bash /home/clawd/.openclaw/skills/brainx/cron/brainx-review-loop-guardrails.sh
```

The guardrail step is non-destructive: it does not delete rows. It uses existing recall-governance fields and tags:

- amnesia smoke test for 1-2 recently promoted handoff memories
- quarantine for clear secrets/sensitive paths using `tier=archive`, `sensitivity=restricted`, `verification_state=obsolete`, `status=wont_fix`
- degradation for temporary paths such as `/tmp` and `workspace-*`
- artifact liveness checks for `final_deliverable` ledger rows
- recall quality sampler using `brainx_runtime_injections`
- exact normalized duplicate collapse for recent `summary_derived` handoffs
- weak handoff reporting
- light staleness tagging for missing local paths or ephemeral URLs

The JSON payload is included under the Review Loop `guardrails` step and contributes to `report.reasons=["memory_guardrail_activity"]` when it finds actionable activity.

## Mandatory Recovery / Semantic Recovery

Runtime recovery is plugin-owned, not cron-owned.

Current behavior:

- `bridge.ts` builds recovery candidates from recent memories, artifact ledger, and session snapshots.
- If direct rules are not enough, `detectSemanticRecoveryTrigger()` asks the BrainX router LLM whether the prompt depends on prior work.
- If relevant candidates are selected, the plugin injects a compact `BrainX mandatory recovery preflight` block.
- The delivery boundary sanitizes leaked runtime context if a model repeats internal blocks.

Known caveat: this greatly reduces context-loss failures, but it is not a mathematical guarantee. It still depends on there being a usable snapshot/artifact/memory, the router not timing out, and the model following the injected context.

## Supporting Jobs

### Memory Daily Consolidate

Runs daily at `23:50` America/Port_of_Spain.

Wrapper-first job:

```bash
bash /home/clawd/.openclaw/skills/brainx/cron/memory-daily-consolidate-cron.sh
```

### Memory Daily Closeout

Runs daily at `23:55` America/Port_of_Spain.

Wrapper-first job:

```bash
bash /home/clawd/.openclaw/skills/brainx/cron/memory-daily-closeout-cron.sh
```

The wrapper is deterministic. It appends a compact `## Cierre automatico` section if missing and returns `already-present` if the daily file is already closed.

### BrainX Injection Health

Runs daily inside `BrainX Maintenance`.

Wrapper:

```bash
bash /home/clawd/.openclaw/skills/brainx/cron/brainx-injection-health.sh
```

The report is intentionally compact:

- `BRAINX_INJECTION_HEALTH_TOP` defaults to `6`
- `BRAINX_INJECTION_HEALTH_WARN_TOP` defaults to `4`
- SQL calls retry up to `BRAINX_INJECTION_HEALTH_SQL_RETRIES=3`
- a lock prevents overlapping health/finalizer runs

This prevents the `alert` agent from timing out while echoing an oversized health report.

### BrainX Skill Learning

BrainX now mirrors the Hermes split inside the two active orchestrators:

- **Review Loop**: every 2h at `:35` America/Caracas, agent
  `brainx-reviewer`. It calls Background Review on every run, and gates
  Session Snapshot / Knowledge Sync by their old cadences.
- **Maintenance**: daily `06:10` America/Caracas, agent `brainx-reviewer`.
  It calls Daily Core and Injection Health every day, plus Cleanup and Skill
  Curator only on Sunday.

Background Review wrapper:

```bash
bash /home/clawd/.openclaw/skills/brainx/cron/brainx-background-review-cron.sh
```

Skill Curator wrapper:

```bash
bash /home/clawd/.openclaw/skills/brainx/cron/brainx-skill-curator-cron.sh
```

Safety: the old daily light dry-run is disabled and the old weekly
auto-create job has been repurposed as `BrainX Skill Curator`. Background
Review is the only near-event skill promotion loop. Existing-skill autopatch
requires high-confidence evidence, raw-session evidence, BrainX confirmation,
registered skill visibility, and low `classifyPatchRisk`. Authorization-only
skills remain blocked: `agent-core`, `brainx`, `gws`, and
`openclaw-runtime`. The curator only manages BrainX-owned skills and snapshots
the lifecycle sidecar before applying transitions.

### BrainX Cleanup

Runs Sunday inside `BrainX Maintenance`.

Wrapper:

```bash
bash /home/clawd/.openclaw/skills/brainx/cron/brainx-cleanup-cron.sh
```

It cleans long-lived state:

- `brainx_session_snapshots`: TTL 30d, with 60d retention for blocked/critical snapshots
- snapshot dedup by `(agent, project, DATE(session_end))`
- `brainx_trajectories`: TTL 60d when `times_used=0`; used trajectories are kept

## Runtime Surfaces That Are Not Cron

These run at prompt/tool time through the `brainx` OpenClaw plugin:

- `wikiDigest`
- `jitRecall`
- `router_llm`
- `workingMemory`
- `toolAdvisories`
- `captureToolFailures`
- runtime observability / injection telemetry

Legacy hooks `brainx-auto-inject` and `brainx-live-capture` remain on disk for compatibility/troubleshooting. They are not the normal production route on this host.

## Operational Rules

- Cron maintenance jobs should be wrapper-first.
- Scheduled jobs should produce compact, parseable output.
- Avoid LLM-driven file edits inside scheduled jobs.
- The `alert` agent should execute the wrapper and report stdout; it should not independently reinterpret long command output.
- Update this file and `docs/RUNTIME_STATUS.md` the same day any scheduler topology changes.
