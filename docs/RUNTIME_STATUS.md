# BrainX Runtime Status

Last verified: `2026-05-27 14:05 -04` / `2026-05-27 18:05 UTC`
Scope: `/home/clawd` host only

This document is the human-readable source of truth for what BrainX has on disk versus what is active in OpenClaw runtime on this host.

Machine-readable companion used by `doctor`: `config/surface-policy.json`.

## Audit Snapshot 2026-05-26

Marcelo requested a senior-level matrix audit of active, dormant, and legacy BrainX flows. Safe checks passed:

- Runtime health (2026-05-26 snapshot): `brainx health` OK; `brainx doctor --full --json` 59 passed / 1 recall-quality warning / 0 failures. (Current 2026-06-01: `58 passed / 2 warnings / 0 failures`; warnings are Wiki + Promotion drift, recall-quality is `ok` — see the 2026-06-01 update note below.)
- Skill CLI: `npm test` 43 passed; `npm run test:smoke` OK.
- OpenClaw plugin: `npm test` 129 passed.
- Host regression: `brainx-regression-suite.sh` 25 passed / 0 failed.
- Runtime config/RPC: `openclaw config validate --json` valid; `openclaw gateway call brainx.status --json` OK.
- CLI surfaces checked read-only/safe: search, inject, metrics, runtime-report, agent-metrics, router-quality, recall-health, wiki status/lint/digest, promote-candidates, lifecycle dry-run, skill-promoter dry-run, skill-curator status, self-learning-audit, EIDOS stats, event ledger search.
- Legacy hooks: `brainx-auto-inject` and `brainx-live-capture` syntax OK; live-capture passed a sandbox capture simulation with daily-memory write into a temp workspace and no BrainX DB write.

Authorization boundary:

- Full real bootstrap auto-inject testing would write `brainx_pilot_log` and workspace context files.
- Real live-capture testing with `storeToBrainx=true` would write production BrainX memories.
- Applying maintenance findings would write production DB rows: 2 durable-confidence raises, 17 low-signal demotions, 60 snapshot/trajectory cleanup candidates, 6 dedup pairs, and 187 reclassification candidates.

Conclusion: active production runtime is healthy. Dormant/legacy code compiles and can be simulated, but real activation remains intentionally gated because it mutates production DB/workspace state.

## Naming

- Canonical skill path: `~/.openclaw/skills/brainx`
- Canonical command: `brainx`
- Runtime plugin path: `~/.openclaw/extensions/brainx`
- `BrainX` is the only active product/runtime name on this host

## Ownership Split

- `BrainX skill / CLI`: storage, search, inject, doctor, cron, knowledge sync, wiki compile, lifecycle
- `brainx plugin`: runtime prompt-time behavior inside OpenClaw
- `brainx-auto-inject` and `brainx-live-capture`: legacy hooks kept for compatibility/troubleshooting only

## Current Host Baseline

Runtime is plugin-owned and globally enabled for the main prompt-time surfaces:

- `brainx` plugin enabled: `true`
- `wikiDigest`: `true`
- `wikiDigestPromptSignalsOnly`: `true`
- `jitRecall`: `true`
- `jitRecallDisabledAgents`: `alert`, `monitor`, `monitor-public`
- `jitRecallAllowCrossAgent`: `true`
- `jitRecallCrossAgentTagRequired`: `false`
- `jitRecallCrossAgentRequireVerified`: `false`
- `routerMode`: `active`
- `routerPrimaryModel`: `gpt-5-nano`
- `routerFallbackModel`: `""` (disabled)
- `routerTimeoutMs`: `6000`
- `policyController`: `true`
- `policyDecisionLog`: `true`
- `workingMemory`: `true`
- `toolAdvisories`: `true`
- `captureToolFailures`: `true`
- `projectGround`: `true` via `~/.openclaw/project-ground/registry.json`
- `writeFailuresToDailyMemory`: `true`
- `writeFailuresToBrainx`: `true`
- `bootstrapMode`: `off`
- `captureOutboundMode`: `off`
- `enforceAgentOptIn`: `false`
- legacy hooks in `openclaw.json`: disabled

Host policy: write-path runtime surfaces must be global or off; do not leave per-agent write pilots as stable production state. Calibration should be driven by runtime feedback first: inspect `brainx_runtime_injections` and `brainx_policy_decisions` before changing static thresholds.

## Scheduler Truth

OpenClaw internal cron has **4 direct BrainX jobs**:

1. `BrainX Review Loop` — every 2h at `:35` America/Caracas; calls Background Review every run, Session Snapshot when due, and Knowledge Sync when due
2. `BrainX Maintenance` — daily `06:10` America/Caracas; calls Daily Core and Injection Health daily, plus Cleanup and Skill Curator on Sundays
3. `BrainX Nightly Memory Loop` — daily `23:50` America/Port_of_Spain; calls Memory Daily Consolidate and Memory Daily Closeout as internal steps
4. `BrainX Amnesia Smoke` — hourly at `:05` America/Caracas; lightweight recall canary

Cron ownership:

- BrainX operational/reviewer jobs are owned by `brainx-reviewer` only.
- There is no active `brainx-ops` agent and it should not be recreated for cron ownership.
- Generic Memory jobs stay outside BrainX ownership unless explicitly absorbed; the daily consolidate/closeout pair is now absorbed by `BrainX Nightly Memory Loop`.
- Operational BrainX wrappers live in `/home/clawd/.openclaw/skills/brainx/cron/`; legacy workspace paths are symlinks for rollback compatibility.

If mixed `clawd` crontab wrappers/resilience jobs are included, the BrainX-related count is **7**:

11. `observe-telemetry` — includes `brainx-health-check`
12. `backup-all-dbs` — includes Sunday `brainx-weekly-backup`
13. `brainx-cron-supervisor` — OS cron fallback for direct BrainX/Memory OpenClaw jobs

The Daily Core wrapper currently runs:

- **15 daily steps** every day
- **2 midweek steps** on Wednesday and Sunday
- **7 Sunday-only steps**

Wednesday total: **17 steps**. Sunday total: **24 steps**.

## Recent Evidence

- `brainx health`: OK, pgvector enabled, 20 BrainX tables
- `brainx doctor --full --json`: `ok=true`, `59 passed`, `1 warning`, `0 failures`; warning is `Recall quality`, not schema/runtime integrity.
- `brainx fix --only runtime-scoring-backlog`: closed `1413` stale unscored runtime injection rows as `maintenance_expired_no_response`, clearing the selected-scoring backlog from self-learning audit.
- `brainx fix --only stale-demotion,auto-dedup`: demoted `1` stale import and `70` stale inference rows to cold, then superseded `27` high-similarity duplicate pairs
- `brainx wiki compile --json`: regenerated the wiki at `2026-05-24T01:16:43Z`; doctor reports wiki and wiki lint OK
- `node scripts/trajectory-recorder.js --hours 168 --max-sessions 40`: processed 8 sessions, found/stored 22 trajectories; trajectory freshness is OK
- `HOME=/home/clawd openclaw gateway call brainx.status`: plugin enabled, wiki digest compiled, JIT recall / working memory / tool advisories / tool-failure capture active, bootstrap/outbound bridges off, internal legacy hooks off
- `/home/clawd/.openclaw/cron/jobs.json`: 4 direct BrainX jobs enabled; BrainX operational/reviewer work is consolidated into `BrainX Review Loop`, `BrainX Maintenance`, `BrainX Nightly Memory Loop`, and `BrainX Amnesia Smoke`, all owned by `brainx-reviewer` except memory-core's separate dreaming promotion under `main`.
- `BrainX Review Loop`: active orchestrator id `69bb998f-df4e-4c55-bd6f-d6c1c9acd8d2`; direct scheduler run OK after delivery was set to `none`.
- `BrainX Maintenance`: active orchestrator id `543350b1-9cff-44b5-ab6a-765723b0e74b`; direct scheduler run OK after Daily Core and Injection Health validated cleanly.
- Disabled rollback jobs: Background Review, Session Snapshot, Knowledge Sync, Daily Core, Injection Health, Cleanup, and Skill Curator.
- `brainx runtime-report --days 7 --json`: `1364` runtime injections, `935` memories injected, `7000` gate-dropped candidates, hard signal `5.35%`, soft signal `30.91%`, avg latency `648.2ms`
- `brainx router-quality --json`: 7d JIT router has `136` events, `132` applied, `4` errors, `0` fail-closed, hard signal `0.0%`, soft signal `29.1%`, avg total latency `4081.3ms`
- `BrainX Injection Health`: manually rerun on 2026-04-30 19:48 -04 after hardening; now `lastStatus=ok`, `consecutiveErrors=0`, duration about 10s
- `brainx-cron-supervisor`: installed in OS crontab every 30m; now reads `jobs.json`, skips `enabled=false` rollback jobs, and supervises the two active BrainX orchestrators instead of re-running legacy jobs
- `brainx-weekly-backup`: heartbeat repaired by routing the Sunday substep through `cron-heartbeat-runner.sh`; latest counted SQL backup is `brainx_backup_20260523_2116.sql`, freshness 0d
- `surface-policy.json`: 44 surfaces, reviewed `2026-05-24`
- runtime regression suite: latest live recheck on 2026-05-26 returned `25/25`
- active non-superseded memories: `6,656`
- active distribution at verification time: `1,718 hot`, `655 warm`, `4,019 cold`, `264 archive`
- runtime route governance: plugin sole route, bootstrap/outbound bridges off

Current doctor warnings: `Recall quality` is now surface-aware. High zero-selected `jit_recall` turns caused by the intent gate/router-empty path are reported as notes, `working_memory` empty-state turns are not warnings by themselves, and `project_ground` is treated as a preventive anchor. This is diagnostic quality telemetry; no DB auto-fix is attached.

Update 2026-06-01 (marker `INJECT_SELFTEST_TAG_20260601` + `QUERY_LOG_ADAPTIVE_BASELINE_20260601`): the long-standing query-log `inject` warning was a measurement artifact, not a recall-quality problem. `brainx doctor`'s fixed sentinel inject probe (`openclaw memory prefix duplication`, 0 results by design) was logged as `query_kind='inject'` — the same table/kind `recall-health` reads — so at doctor cadence (~20/day) the probe dominated the surface (~50% zero-result; real rate ~4.7%) and the warning could never clear. Self-test injects are now tagged `inject_selftest` (via `inject --source selftest`, used by doctor's probes) and excluded from recall-health; and `brainx_query_log`-only surfaces now self-calibrate against their own prior-window baseline instead of being pinned to the fixed cold-start threshold forever. Live result: `recall-health` OVERALL `ok` / 0 warnings, `inject` `calls≈150 zero-result≈4.7% mode=adaptive status=ok`. `doctor --json` now `42 passed / 2 warnings / 0 failures` (the 2 warnings are pre-existing `BrainX Wiki` low-confidence ratio and `Promotion suggestion drift`, unrelated to recall). Engine-only change (`skills/brainx`), no dist rebuild or gateway restart. The `59 passed / 1 warning` figures in the dated snapshots below are historical 2026-05-30 values.

Follow-up validation on `2026-05-26 19:10 -04`:

- `brainx health --json`: OK, pgvector enabled, 20 BrainX tables.
- `brainx doctor --json`: `ok=true`, `44 passed`, `0 warnings`, `0 failures`.
- `brainx doctor --full --json`: `ok=true`, `59 passed`, `1 warning`, `0 failures`; test suite and smoke suite OK.
- `openclaw config validate --json`: valid.
- `openclaw gateway call brainx.status --json`: plugin enabled; `wikiDigest`, `jitRecall`, `workingMemory`, `toolAdvisories`, `captureToolFailures`, and `projectGround` active; bootstrap/outbound bridges and legacy hooks off.
- `brainx fix --dry-run --only runtime-scoring-backlog,auto-dedup,stale-demotion --json`: no stale scoring backlog, no duplicates, no stale tiers.
- Direct DB read of `brainx_runtime_injections`: `6` unscored recent rows, `4` selected unscored, `0` stale unscored older than 6h.
- `writer/jit_recall` remains mixed but not broken: 7d router quality showed 49 events, 48 applied, 1 router error, 0 fail-closed, soft signal 30.4%, hard signal 2.2%. This is tuning evidence, not a production failure.

Intentional non-runtime or disabled surfaces:

- `learning_details`: dormant, schedule off
- `EIDOS`: dormant, schedule off
- live capture telemetry: inactive because live capture is intentionally off

Follow-up validation on `2026-05-27 12:08 -04`:

- Moved `doctor-actionable-fix` from Sunday-only to daily Daily Core cadence inside `/home/clawd/.openclaw/skills/brainx/cron/brainx-daily-core-wrapper.sh`.
- The daily step remains scoped to `brainx fix --only stale-demotion,auto-dedup,runtime-scoring-backlog --json`; `durable-confidence`, broad reclassification, deletes, and full-registry fixes stay gated/report-only.
- Pre-apply dry-run showed `54` stale inference memories, `16` duplicate pairs, and `6` stale unscored runtime rows older than 6h.
- Post-apply dry-run showed no stale tiers, no duplicate pairs, and no stale unscored rows older than 6h.
- `bash -n /home/clawd/.openclaw/skills/brainx/cron/brainx-daily-core-wrapper.sh`: OK.
- `brainx doctor --json`: `ok=true`, `44 passed`, `0 warnings`, `0 failures`.
- `openclaw config validate --json`: valid.
- `npm test -- --runInBand`: `43 passed`.
- `npm run test:smoke`: BrainX health OK, pgvector enabled, 20 BrainX tables.
- `/home/clawd/.openclaw/skills/brainx/cron/brainx-regression-suite.sh`: `25 passed`, `0 failed`.
- `HOME=/home/clawd openclaw gateway call brainx.status --json`: plugin enabled; JIT recall, working memory, tool advisories, captureToolFailures, and projectGround active; bootstrap/outbound bridges and internal legacy hooks off.

## Audit 2026-05-06 - Runtime Healthy, Architecture Coupled

Marcelo asked for a live architecture/runtime audit before making BrainX changes. The audit found no outage and no emergency disable candidate: production runtime is healthy, scheduled jobs are running, the gateway status matches the intended plugin-owned route, and the real wiki vault is compiled.

The main finding is architectural coupling, not runtime failure. The plugin at `~/.openclaw/extensions/brainx` owns prompt-time behavior, but it still imports runtime dependencies directly from the skill path `~/.openclaw/skills/brainx`:

- `extensions/brainx/src/bridge.ts` derives `BRAINX_DIR` from `OPENCLAW_STATE_DIR || os.homedir()` and hardcodes `skills/brainx`
- the plugin imports legacy hook handlers from `hook/handler.js` and `hook-live/handler.js`
- the plugin requires skill libraries such as `lib/openai-rag.js`, `lib/advisory.js`, `lib/working-memory.js`, `lib/db.js`, and `lib/brainx-phase2.js`
- the skill still owns CLI, DB access, knowledge sync, wiki compile, cron wrappers, migrations, promotion, snapshots, trajectories, legacy hooks, and runtime docs

This split is acceptable for the current host because runtime governance is clean: plugin route is sole active route, bootstrap/outbound bridges are off, and internal legacy hooks are disabled. The risk is maintainability: changing or publishing the skill can accidentally affect plugin runtime, and isolated agent environments can report false negatives if they resolve `HOME` to an agent-local directory instead of `/home/clawd`.

Operational conclusions:

1. Keep runtime settings as-is for now.
2. Do not re-enable `bootstrapMode`, `captureOutboundMode`, `brainx-auto-inject`, or `brainx-live-capture` as normal runtime paths.
3. Use `/home/clawd/brainx-vault` as the canonical wiki vault in diagnostics; otherwise isolated agent `HOME` values can make `doctor` report a false `not_compiled` wiki.
4. Do not tighten or loosen cross-agent recall blindly. The current control is router/context-broker policy, and the latest telemetry shows low hard-reference signal but meaningful soft signal.
5. Treat plugin/skill separation as the next architecture cleanup: plugin-owned runtime modules should be separated from skill-owned CLI/maintenance modules before adding more prompt-time surfaces.

## Cross-Agent Recall Signal Review 2026-05-06

Follow-up read-only telemetry review over the last 7 days:

- Overall runtime report: `1115` injections, `426` selected memories, hard signal `1.64%`, soft signal `25.12%`, average latency `530.1ms`
- By selected memory ownership:
  - `global_null`: `283` selected, `6` hard refs, `79` soft refs
  - `knowledge_base`: `125` selected, `0` hard refs, `24` soft refs
  - `cross_agent`: `17` selected, `1` hard ref, `4` soft refs
  - `same_agent`: `1` selected, `0` refs
- Cross-agent pairs were sparse and mostly from `main` / `codex-cli` memories into `bill`, `raider`, `echo`, `kron`, `reasoning`, `sonnet`, and `writer`.

Conclusion: do not change cross-agent recall dials yet. Actual cross-agent selected volume is low, and the few selected rows are not showing a safety emergency. The healthier next step is to keep router/context-broker controls in place and gather more targeted telemetry before changing `jitRecallAllowCrossAgent`, tag requirement, or verified requirement in production config.

## Core Surfaces

| Surface | Implemented | Enabled now | Scheduled now | Owner | Notes |
|---|---|---|---|---|---|
| Persistent memory + semantic search | yes | yes | n/a | skill | PostgreSQL + pgvector + OpenAI embeddings |
| Wiki digest | yes | yes | runtime + daily compile | plugin + skill | Digest is compiled by daily wrapper and injected by plugin when gated |
| JIT recall | yes | yes | runtime | plugin | Router-selected memories/snapshots, local-first with governed cross-agent recall |
| Router LLM | yes | yes | runtime | plugin | `gpt-5-nano` primary, no fallback model, strict guard on timeout/error |
| Adaptive policy controller | yes | yes | runtime | plugin | Uses recent per-agent/surface usefulness telemetry to allow, suppress, or explore surfaces without manual threshold churn |
| Working memory | yes | yes | runtime | plugin | Short-lived session state, relevance gated |
| Project ground | yes | yes | runtime | plugin | Deterministic small per-project operational pack from `~/.openclaw/project-ground`; only injects on explicit registry binding/projectKey |
| Tool advisories | yes | yes | runtime | plugin | High-risk tool whitelist |
| Tool-failure capture | yes | yes | runtime | plugin | Scrubbed failures to daily memory + BrainX |
| Session snapshots | yes | yes | every 4h | skill + plugin | Snapshot + handoff-promoter wrapper |
| Handoff promoter | yes | yes | every 4h + daily | skill | Promotes snapshots to hot memories and artifact ledger |
| Event ledger | yes | yes | manual CLI | skill | Deterministic forensic index for fixes/incidents/decisions/handoffs/audits |
| Artifact ledger | yes | yes | write path | skill | Durable final artifact paths used by recovery preflight |
| Semantic recovery preflight | yes | yes | runtime | plugin | LLM classifier detects continuation/context-loss intent beyond regex phrases |
| Trajectories | yes | yes | daily | skill | Problem→solution→outcome records |
| Cleanup snapshots/trajectories | yes | yes | Sunday | skill | Weekly TTL/dedup cleanup |
| Memory distillation | yes | yes | daily | skill | LLM extraction from sessions |
| Session harvester | yes | yes | daily | skill | Regex/heuristic capture |
| Memory bridge | yes | yes | daily | skill | Syncs `memory/*.md` into DB |
| Cross-agent learning | yes | yes | daily | skill | High-signal sharing |
| Context packs | yes | yes | daily | skill | Project/context summaries |
| Error harvester | yes | yes | daily | skill | Converts failures into gotchas |
| Reclassification | yes | yes | daily | skill | Keeps categories current |
| Degrade over-injected | yes | yes | daily | skill | Demotes unused noisy injected memories |
| Runtime regression suite | yes | yes | daily | skill | Guards runtime invariants |
| Lifecycle management | yes | yes | Wed + Sun | skill | Tier decay and stale cleanup |
| Contradiction detection | yes | yes | Wed + Sun | skill | Semantic contradiction checks |
| Memory consolidation | yes | yes | Sunday | skill | Weekly mature same-scope consolidation |
| Auto-promoter / promotion-applier | yes | yes | Sunday | skill | Review-gated rule suggestions |
| Memory enforcer / memory audit | yes | yes | Sunday | skill | Workspace memory health |
| Knowledge sync | yes | yes | every 7h | skill | Syncs canonical knowledge |
| Memory daily consolidate | yes | yes | daily 23:50 via Nightly Memory Loop | skill | Cross-workspace deterministic wrapper, absorbed as BrainX step |
| Memory daily closeout | yes | yes | daily 23:50 via Nightly Memory Loop | skill | Deterministic closeout wrapper, absorbed as BrainX step |
| Injection health | yes | yes | daily 07:30 | skill | Compact top-10/top-5 health report |
| Skill promoter | yes | yes | daily 07:05 + Sunday 08:45 | skill | Review-gated Hermes-style skill candidates |

## Disabled, Dormant, or Manual Surfaces

| Surface | State | Notes |
|---|---|---|
| `brainx-auto-inject` | disabled legacy | Do not treat generated `BRAINX_CONTEXT.md` as normal runtime |
| `brainx-live-capture` | disabled legacy | Telemetry remains visible, outbound capture is off |
| `bootstrapMode` | off | Plugin runtime remains the normal route |
| `captureOutboundMode` | off | Tool-failure capture is separate and active |
| `learning_details` | dormant | Table/script exist; schedule is off |
| `EIDOS` | dormant | Schema + CLI exist, no production runtime |
| Quality scorer | manual | Available for manual evaluation |
| Workspace import/eval dataset | manual | Tooling only, not scheduled |

## Important 2026-04-29 Updates

### Context Broker and Artifact Ledger v2

The runtime is no longer treated as generic "memory injection".

Current prompt-time flow:

1. Classify the turn intent (`artifact_request`, `session_continuity`, `context_loss`, `procedural_query`, `troubleshooting`, etc.).
2. Infer runtime family (`ACP`, `Codex`, embedded, unknown).
3. Derive `active_scope` from prompt text, immediate thread context, `brainx_context_state`, working memory, and path scope.
4. Apply the cheap JIT intent gate: only historical, procedural, troubleshooting, project-state, explicit recall, or recovery-related turns may reach `jit_recall`; generic semantic/domain turns do not pay vector search or router latency.
5. Select one surface: recovery preflight, JIT recall, working memory, or wiki digest.
6. Apply adaptive policy: protect recovery/explicit recall/deterministic project ground, suppress low-signal surfaces after enough samples, and allow a small deterministic exploration budget.
7. Inject only a compact evidence block.

For ambiguous continuations, `active_scope` is strict. It filters recovery snapshots/artifacts/context states and JIT recall rows from other detected projects unless the user explicitly broadens to all memories/workspace/other projects.

JIT intent-gate policy: generic semantic/domain recall is suppressed before vector search for all runtime families unless the turn explicitly needs historical/procedural/project-state/troubleshooting memory or recovery. This keeps `jit_recall` available for real memory work while removing the old "search just in case, then let the router reject it" latency path. Suppressed JIT attempts are observable in `brainx_policy_decisions` with `reason LIKE 'intent_gate:%'`; active JIT rows include `decision_summary.surface_plan.jit_recall_gate`.

ACP policy: ACP agents already carry strong upstream session context, so generic domain recall is suppressed for ACP unless the turn explicitly needs recovery, historical/procedural memory, project-state memory, or troubleshooting evidence. This is an injection policy only: all ACP turns must still pass through BrainX typed runtime hooks for intake gates, working-memory/session state, and scoring telemetry.

Policy controller status: active as of 2026-05-13. Production validation after rebuild/restart showed `brainx.status` reporting `policyController.enabled=true`; journal showed `[brainx] loaded ... policy=adaptive`; plugin tests passed `120/120`. The controller uses `brainx_runtime_injections` as feedback and writes decisions to `brainx_policy_decisions`.

Claude ACP runtime-heal boundary: `claude-cli-runtime-heal` owns ACP process/session health, stale metadata, `acpxSessionId`, prune/observe actions, and upstream resume/handoff consumption. BrainX does not reset ACP sessions, rewrite ACP metadata, or compete with `resumeSessionId`; it only adds compact prompt-time evidence when the current user turn needs memory, recovery, historical/procedural context, or troubleshooting evidence.

Artifact ledger v2 adds:

- `artifact_role`
- `provenance`
- `finality_score`
- `metadata`

Recovery now prefers final deliverables/promoted handoffs and demotes `/tmp`, tool-read, and weak exec artifacts. `brainx_context_state` stores compact latest state by `agent + session_key` so OpenClaw `sessionId` rotation has a deterministic handoff surface. As of 2026-04-29, the plugin reads the previous state before upserting the new turn; if `sessionId` changed for the same `sessionKey`, a meaningful non-ack prompt forces `recovery_preflight` with `trigger=session_rotation`, even when another generic trigger was already present.

Rotation telemetry now has a dedicated event log: `brainx_session_rotation_events`. Each event records `agent`, `session_key`, previous/current `session_id`, whether recovery fired, whether a handoff block was injected, and any missed reason. Timestamps are normalized to ISO before insert so local JS date strings do not break Postgres parsing. The operational monitor is `/home/clawd/.openclaw/workspace/scripts/brainx-session-rotation-monitor.mjs`.

Live audit note: as of 2026-04-29 15:24 -04, the monitor reports 3 production `session_rotation` events, all with recovery fired and handoff injected. Historical rows that had runtime injection but missed the event table were backfilled with `/home/clawd/.openclaw/workspace/scripts/brainx-backfill-rotation-events.mjs`.

Telemetry update: the prior `recovery_preflight` scoring gap for Codex/background turns is fixed and hardened. If the runtime emits exact `NO_REPLY`/`HEARTBEAT_OK`, BrainX keeps the selected-injection cache alive instead of clearing it; a scoring-only `message_sent` observer then scores the user-visible delivery-mirror reply by `sessionKey` without enabling broad live capture. `brainx_runtime_injections.session_key` is now persisted so scoring can fall back to DB lookup if the in-memory cache expires. `brainx-injection-health.sh` finalizes stale selected rows as zero-reference telemetry after the scoring window; latest regression reports `recent_unscored_selected=0`.

## Important 2026-04-28 Updates

### Mandatory Recovery and Handoff

The older handoff model was passive: snapshots could exist without becoming durable memory. That has been corrected.

Current flow:

1. `BrainX Session Snapshot` stores structured state every 4h.
2. `handoff-promoter` immediately promotes stable handoff material to `brainx_memories` and `brainx_artifact_ledger`.
3. The plugin recovery preflight searches recent context state, artifact ledger, and snapshots.
4. A semantic LLM classifier can trigger recovery even when the user's wording is not in a fixed regex list.
5. User-facing delivery sanitizes leaked runtime context if a model repeats internal blocks.

This is robust, but not absolute. It can still fail if no durable artifact/snapshot exists, the router times out, or the model ignores relevant injected context.

### Cron Reliability

Three BrainX/Memory jobs that appeared in error were corrected:

- `BrainX Nightly Memory Loop` absorbing `Memory Daily Consolidate` and `Memory Daily Closeout`
- `BrainX Injection Health`

Rules now enforced:

- wrapper-first execution
- compact stdout
- `thinking=off` for alert-agent cron jobs where appropriate
- no LLM-driven file editing in scheduled maintenance

## Operating Rule

Do not treat "implemented in the repo" as "active in production".

If a future change enables, disables, or reschedules a surface:

1. Update `openclaw.json`, `jobs.json`, or the wrapper first.
2. Verify telemetry reaches DB/logs.
3. Update `docs/CRON.md`, this file, `README.md`, `SKILL.md`, and `brainx.md` in the same change.
4. Add a short entry to `data/bugs.md` if the update fixes an incident or operational trap.
