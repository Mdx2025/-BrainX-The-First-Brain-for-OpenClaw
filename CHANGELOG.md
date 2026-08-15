# Changelog — BrainX V5

All notable changes to BrainX V5 are documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased] - 2026-07-19

### Added — Reactive error-recall (fingerprint exact-match + vector fallback)
- **`lib/error-recall.js`** (marker `BRAINX_REACTIVE_ERROR_RECALL_FINGERPRINT_20260719`): a reactive post-failure recall path so an agent that HITS a tool/runtime error automatically surfaces the fix that already resolved the SAME error (fleet-shared corpus). Complements `lib/advisory.js`, which is PRE-call/preventive and never fired reactively on failure. Motivation (audited 2026-07-18): free-text symptom→fix vector match measured weak (~0.53) once an agent rephrases the error, below the 0.55 jit_recall gate; the industry answer (Sentry-style error grouping) is a deterministic fingerprint with exact-match first, vector fallback second.
  - Fingerprint `tool|error_class|normalized-message` (paths/ids/numbers/timestamps/units → placeholders so recurrences collapse to one key). Explicit errno set + semantic classes (no loose `/e[a-z]+/` that mis-classified `exec`/`error`).
  - Exact-match first on `error_fingerprint`; vector fallback second at gate `BRAINX_ERROR_SURFACE_GATE` (0.48) — rescues the ~0.53 band the 0.55 jit gate dropped.
  - Feedback re-weighting (Cognee-style): a resolved retry boosts the surfaced fix (`feedback_score`/`importance`), an unresolved one demotes it.
  - `error_recall` surface stats for observability (the advisory surface was blind in runtime-report).
  - Idempotent `backfillFingerprints()` (plugin write path stays untouched; backfilled 7961/7961 failure gotchas).
- **Migration `2026-07-19_error_fingerprint_reactive_recall.sql`**: additive nullable `error_fingerprint` column + partial index (catalog-only ALTER, safe on the ~37k-row live table).
- **`lib/openai-rag.js` `storeMemory`**: persists `error_fingerprint` (additive param) so NEW failure gotchas carry a clean, exact-matchable signature.
- **CLI**: `brainx error-recall <lookup|backfill|stats|fingerprint|outcome>`.
- Gated behind `BRAINX_REACTIVE_ERROR_RECALL` (**off by default**); fail-open everywhere. Runtime wiring lives in the plugin (extensions/brainx). Validation: pure-fn unit 6/6, live backfill + lookup on/off, feedback +/- with restore, doctor 45/1/0.

## [Unreleased] - 2026-07-18

### Fixed
- **`brainx fix` Migrations nunca convergía** (`lib/fix.js`, marker `BRAINX_FIX_MIGRATION_CHECKS_COMPLETE_20260718`): `migrationChecks` no tenía entrada para 10 migraciones (017–023, `2026-06-01_*`, `2026-06-11_domain_ledger`) y `if (checkFn && checkFn(snapshot)) continue` re-aplicaba y re-reportaba "applied 10" en cada corrida — el paso jamás llegaba a `ok` y enmascaraba el estado real (DDL idempotente, sin corrupción). Se agregaron las 10 check functions (022 acepta el supersede de 023: índice de expresión reemplazado por columna `content_tsv` almacenada) + guard estructural: archivos sin check registrado ahora se reportan con `WARN ... missing a migrationChecks entry` en vez de esconderse en "applied".
- **`Cron registration → warn | cannot read cron config` permanente** (`lib/fix.js`, marker `BRAINX_FIX_CRON_STORE_MIGRATION_FALLBACK_20260718`): el check leía `~/.openclaw/cron/jobs.json`, ruta muerta desde la migración del cron store de OpenClaw (solo quedan `jobs-state.json.migrated` y backups). Fallback a `openclaw cron list --json` (timeout 20s) cuando el archivo no existe; ahora reporta `ok | orchestrated pipeline detected: review_loop=on, maintenance=on`.

### Applied (operación, mismo día)
- `brainx fix` aplicó de verdad las 10 migraciones pendientes de facto: `brainx_plan_capsules`/`brainx_plan_steps` creadas, `content_tsv` generada + backfill 37.316/37.316 + `brainx_memories_tsv_idx` (cierra el gap FTS de la auditoría 07-16), constraint `query_kind` con `*_selftest`; además confidence raise de 2.102 memorias durables, demotion de 37 stale inference→cold y cierre de 8 scores runtime huérfanos. Backup previo: `~/.openclaw/backups/brainx-pre-fix-20260718.dump` (549M, pg_dump -Fc). Validación: `fix --dry-run` converge a `nothing to apply`, doctor 45/1/0, regression suite 60/60.

## [Unreleased] - 2026-07-17 (consolidación retroactiva 2026-07-06 → 2026-07-17)

> Entrada de backfill escrita el 2026-07-17: el CHANGELOG estuvo 12 días detrás
> del working tree. Consolida los cambios en disco entre 07-06 y 07-17 según
> diff del repo + Inventory F + openclaw:bugs; el detalle por incidente vive en
> esas dos fuentes.

### Added
- **Artifact storage / archivo en R2 (2026-07-16)** — `sql/migrations/2026-07-16_artifact_storage.sql`, `scripts/artifact-archiver.js` (+ `scripts/test-artifact-archiver.js`): fases 0–2 del archivo de artefactos del ledger a R2 (bucket `mdxspace-brainx`). El ledger sigue siendo observacional; el archiver copia el contenido antes del purge de `/tmp` para cortar la pérdida silenciosa de punteros (53,6% rotos detectados en la auditoría 07-16). Detalle: openclaw:bugs `m_1784187055513_5c2425fb`.
- **Trajectory extraction (07-12/13, remediación auditoría LCM)** — `lib/trajectory-extractor.js`, `lib/trajectory-session-selection.js` + tests: extracción problema→solución desde sesiones seleccionadas (starvation de trajectories corregida).
- **Canonical continuity** — `lib/canonical-continuity.js` + `tests/canonical-continuity.test.js`.
- **Project-ground drift sentinel** — `scripts/project-ground-drift-sentinel.js` + test unitario: detecta drift del project_ground.
- **Reembed self-heal standalone** — `scripts/reembed-openai.js`.
- Tests nuevos: `fix-quality-hygiene`, `flat-channel-daily-cap`, `maintenance-status-guard`, `skill-candidate-reservoir`, `skill-probation`, `skill-promoter-reservoir-wiring`, `skill-proposal-sweep`, `ws-size-cap` (los archivos `lib/skill-candidate-reservoir.js`, `lib/skill-probation.js`, `scripts/skill-probation-run.js`, `scripts/skill-proposal-sweep.js` descritos en la entrada 07-05 entran al repo recién en este commit).

### Fixed
- **`--minSimilarity` explícito respetado en la ruta FTS** — `lib/openai-rag.js`: el umbral explícito era ignorado por los candidatos FTS del rank fusion (hallazgo de la auditoría integral 2026-07-16).
- **Quality hygiene en `fix`** — `lib/fix.js` + test: higiene de calidad en reparaciones automáticas.
- Guards de mantenimiento/status y cap diario por canal en crons (`cron/brainx-maintenance-cron.sh`, `cron/brainx-review-loop-cron.sh`, `cron/brainx-background-review-cron.sh`, `cron/brainx-acp-rotation-tuning-audit.mjs`).

### Changed
- `config/runtime-policy.json` / `config/surface-policy.json` — versión 7, superficies retrieval/capture/maintenance/observability revisadas 2026-07-13.
- Docs actualizados: `RUNTIME_STATUS.md`, `RUNTIME_POLICY.md`, `RUNTIME_CONTINUITY_REGRESSION_GUARD.md`, `CRON.md`, `TESTS.md`, `CLI.md`.
- **SKILL.md (2026-07-17)**: inventario CLI completado — 26 comandos core + 14 wrappers documentados (antes 15); agregado `brainx-live-capture` (`hook-live/`) a la tabla de hooks.
- `knowledge/` — resync masivo de bloques auto-gestionados (2026-07-12) + `knowledge/development/webgl-texture-pipelines.md` nuevo.

## [Unreleased] - 2026-07-05

### Added
- `BRAINX_SKILL_RESERVOIR_20260705` — `lib/skill-candidate-reservoir.js`: ledger→promoter feedback stage. Post-turn skill proposals parked in `brainx_skill_candidates` (`manual_review`/`post_turn_proposal`) are now aggregated by skill+action and fed into the background promoter with accumulated recurrence, bounded corroboration confidence (cap 0.97), and cross-agent confirmation (needs ≥3 proposals across ≥2 distinct agents — one agent can never confirm itself). Gates and adversarial verifier unchanged. Applied groups are resolved out of the pool (`markGroupResolved` → `approved`/`reservoir_promoted`). Kill switch `BRAINX_SKILL_RESERVOIR=0`.
- `BRAINX_SKILL_APPLY_DAILY_CAP_20260705` — daily budget of real skill auto-applies (`BRAINX_SKILL_APPLY_DAILY_CAP`, default 3), counted from ledger `applied_at`. FAIL-CLOSED when the count is unknown. Excess candidates skip with mutable reason `daily_cap_reached`.
- `BRAINX_SKILL_PROBATION_20260705` — `lib/skill-probation.js` + `scripts/skill-probation-run.js`: outcome-driven probation wired into the background review cron. Wrong-dominant (`wrong ≥ 3` and `wrong > helpful` within `BRAINX_SKILL_PROBATION_DAYS`, default 14) brainx-CREATED skills are auto-reverted (archived to `.brainx-skill-applies/reverts/` first, lifecycle forgotten, ledger `reverted` → suppressed); wrong-dominant PATCHES are only flagged `manual_unpatch_required`. Never touches skills lifecycle does not confirm as brainx-created. Kill switch `BRAINX_SKILL_PROBATION=0`. Probation reverts/flags/errors are announced by the review loop (`skill_probation_*` report reasons).

### Changed
- `BRAINX_SKILL_SWEEP_SPLIT_20260705` — skill proposing moved OUT of the per-turn reviewer into an hourly batched sweep (`scripts/skill-proposal-sweep.js`, wired as a review-loop step). The per-turn reviewer now focuses exclusively on memory/context/active_state (`BRAINX_POST_TURN_SKILL_CANDIDATES=1` re-enables the old per-turn emission). The sweep reads the last hour of processed post-turn jobs, batches per agent (1 LLM call/agent, skips heartbeat/cron sessions), and feeds the SAME funnel: normalize + scope-vetter → ledger `manual_review/post_turn_proposal` with `ptr:<agent>` runId → reservoir → gates → panel. Cursor state in `state/brainx/skill-proposal-sweep.json`; kill switch `BRAINX_SKILL_PROPOSAL_SWEEP=0`.
- `BRAINX_REVIEWER_CHAIN_PER_CALL_20260705` — `callReviewerDirect` accepts a per-call provider chain. Post-turn reviewer + sweep now run Gemini-first (`BRAINX_POST_TURN_REVIEW_PROVIDER_CHAIN=google/gemini-2.5-flash-lite,openai-brainx-reviewer/gpt-5-mini` in `.env`, watcher recycled to pick it up); the adversarial skill verifier pins its own gpt-5-mini-first chain in code (`BRAINX_SKILL_VERIFY_CHAIN` overrides) so the cost flip never downgrades the final judgment before a skill write.
- `scripts/skill-promoter.js` — `autoPatchGate` now requires `lifecycle.findSkillDir` to resolve (`target_skill_dir_not_found`) so runtime-registered plugin skills outside the patchable root become clean skips instead of apply errors (seen live with `video-frames`).
- `BRAINX_SKILL_APPLIED_DETAIL_REPORT_20260705` — review-loop channel report now details every applied skill change: created vs patched, evidence (confidence/recurrence/sources), the rule(s) written (preview), path, and the probation note. No more bare "aplico 1 cambio(s)".

### Fixed
- Ledger row `project-intake-flow` (status `applied` 2026-07-02) marked `reverted`/`test_residue_never_applied_on_disk`: synthetic test source_ids, no SKILL.md on disk, no applier audit — residue of the pre-fix `getDb({db:null})` test leak, not a real apply.
- `BRAINX_SKILL_SUPPRESS_PROFILE_AWARE_20260705` — cross-profile suppression bug: the auto-patch profile recorded every create-action candidate as `not_existing_skill_patch` (immutable within that profile) and after 3 runs the profile-blind suppression buried valid CREATE candidates for the create profile too (seen live: 3 candidates). Suppression verdicts whose reason is purely the other profile's action mismatch are now ignored when the candidate's action matches the current run's profile.

### Calibrated (2026-07-05, from 2 weeks of live ledger data — first real auto-applies landed)
- `BRAINX_SKILL_RESERVOIR_CALIBRATION_20260705` — confirmation now `(proposals ≥ 2 AND agents ≥ 2) OR proposals ≥ 8 (single-agent high bar)`; the two largest evidence pools were single-agent and permanently blocked before.
- `BRAINX_SKILL_VERIFY_CALIBRATION_20260705` — refuter prompt judges substance, not tone: fleet-environment WORKFLOWS (OpenClaw tools, pty, Playwright, gh) are valid skill content; refutation stays fail-closed for safety, staleness, instance-specifics, one-off narratives, and environment-dependent FAILURES.
- First live auto-applies: patch to `playwright-browser-automation` (conf 0.963, 4 proposals / 2 agents, panel 3/3 accept) and created `skills/design-system-audit-workflow/` (conf 0.915, 2 proposals / 2 agents, panel accept). Daily cap 2/3 consumed; member rows resolved out of the reservoir pool; both under probation.

## [Unreleased] - 2026-06-24

### Added
- `OPENCLAW_BRAINX_REVIEWER_EXEC_DENY_SECURITY_FIX_20260629` — security-audit cleanup for the `brainx-reviewer` OpenClaw agent. `Autogilly Sentinel` now runs as a deterministic `payload.kind="command"` cron and `brainx-reviewer` uses `tools.profile="minimal"` with shell/filesystem mutation tools explicitly denied.
- `BRAINX_POST_TURN_REVIEW_CANARY_GATE_20260625` — read-only canary gate for the Hermes-style post-turn review rollout. It checks active work, queued/running tasks, gateway event-loop health, config validity, post-turn queue state, live `brainx.status`, and whether the running gateway predates the rebuilt BrainX bundle before any observe-mode activation.
- `BRAINX_POST_TURN_REVIEW_HERMES_REVIEWER_JAIL_GATE_20260625` — `post-turn-review-canary-gate.js` now has a `pre-dry-run` phase that checks the semantic reviewer route before enabling reviewer LLM calls. It requires the configured reviewer agent to use `tools.profile="minimal"`, blocks dangerous explicit tool allowlists such as `exec`/`process`, and blocks wildcard sub-agent delegation.
- `post-turn-review-canary-gate.js --phase post-dry-run` — post-activation gate that requires live `postTurnReview.mode="dry-run"`, queue noop, healthy OpenClaw runtime, loaded BrainX bundle, and the Hermes-jailed semantic reviewer policy.
- `brainx-semantic-reviewer` — dedicated OpenClaw agent for BrainX semantic reviewer calls. It uses the `openai-brainx-reviewer/gpt-5-nano` route, `tools.profile="minimal"`, no wildcard sub-agent delegation, and explicit denials for shell/filesystem mutation tools.

### Changed
- `BRAINX_DOCTOR_CRON_TOPOLOGY_20260629` — `brainx doctor` now matches the current command-payload topology: required direct BrainX OpenClaw jobs are `BrainX Review Loop`, `BrainX Maintenance`, and `BrainX Nightly Memory Loop`; retired `BrainX Amnesia Smoke` and missing absorbed rollback stubs are no longer failures. This keeps the doctor aligned with the rule that `brainx-reviewer` is not a shell executor.
- `lib/agent-llm.js` now defaults to `brainx-semantic-reviewer`. Deterministic cron wrappers run as OpenClaw command payloads; do not reintroduce `agentTurn` shell execution through `brainx-reviewer`.
- Production post-turn review canary advanced from `observe` to `dry-run` for `coder` only. Dry-run writes proposal JSON under the post-turn review queue and keeps memory writes disabled.
- BrainX embeddings now prefer `BRAINX_OPENAI_EMBEDDINGS_API_KEY` and still fall back to `OPENAI_API_KEY` for compatibility.
- BrainX model calls now tag the local cost ledger with provider `openai:brainx_models`; embedding calls tag `openai:brainx_embeddings`, so embeddings and distillation/model work separate cleanly in cost reports.
- BrainX Review Loop delivery now has a deterministic command formatter, so the scheduled job can run the review wrapper directly instead of relying on the reviewer model to discover and invoke shell tools through the deferred tool surface.
- Post-turn review worker now treats current `postTurnReviewMode` in `openclaw.json` as the maximum allowed behavior for queued jobs. Downgrading config to `observe` or `off` prevents already-queued higher-mode jobs from invoking reviewer/apply paths beyond the new safety cap.

### Validation
- `node -c lib/embedding-client.js`
- `node -c lib/agent-llm.js`
- `node -c lib/cost-tracker.js`
- `node --test tests/post-turn-review-canary-gate.test.js`
- `node --test tests/post-turn-review-worker.test.js`
- `openclaw agent --agent brainx-semantic-reviewer --session-key agent:brainx-semantic-reviewer:semantic-reviewer-smoke-20260625b --message "Return exactly: SEMANTIC_REVIEWER_OK" --json --timeout 120 --thinking low`
- `node scripts/post-turn-review-canary-gate.js --phase pre-dry-run --json --timeout-ms 120000`
- `node scripts/post-turn-review-canary-gate.js --phase post-dry-run --json --timeout-ms 120000`
- `openclaw agent --agent coder --session-key agent:coder:brainx-post-turn-dry-run-canary-20260625 --message "BrainX post-turn dry-run canary. Reply exactly: DRY_RUN_CANARY_OK. No tools." --json --timeout 120 --thinking low`
- `node scripts/post-turn-review-worker.js --json --max-jobs 1` processed `ptr_7252c6cb2353a9d7668d515067b38d16` as `proposal_only`, `memoriesApplied=0`, `proposals=1`.
- DB check returned `count=0` for `brainx_memories.source_path LIKE 'post-turn-review:%'` after the dry-run worker.
- `brainx health` returned OK.
- `openclaw doctor --lint --json` returned `ok=true`, `checksRun=22`, `findings=[]` after the `brainx-reviewer` tools lockdown.
- `openclaw security audit --deep --json` no longer emits `tools.exec.fs_tools_disabled_but_exec_enabled` for `agents.list.brainx-reviewer.tools`.

## [2026-06-13] — BrainX loop audit fixes (ACP harvest + promotion loop)

### Added
- `BRAINX_ACP_TRANSCRIPT_HARVEST_20260612` — new shared module `lib/session-sources.js` (ACP discovery + dual-format record normalization). Every transcript-reading harvester now also reads the Claude ACP fleet transcripts at `~/.claude-<agent>/projects/**/*.jsonl` (~2GB, fresher than the OpenClaw session copies) which were previously invisible to all of them — the single largest coverage gap. Wired into `session-harvester`, `memory-distiller`, `turn-harvester` (12MB per-file cap to protect the 20-min loop), `trajectory-recorder`, `method-error-harvester`, `session-snapshot`, `domain-ledger-audit`. Maps only real fleet agents (excludes operator terminal config dirs, `.lock`/`.bak` siblings, ops agents). Kill-switch `BRAINX_HARVEST_ACP_TRANSCRIPTS=0`. Unit-tested (`tests/unit/session-sources.test.js`).

### Fixed
- `BRAINX_METHOD_ERROR_PROMOTER_SIGNAL_GATE_20260613` + `BRAINX_METHOD_ERROR_PROMOTER_DAILY_20260613` — the method-error promoter was a dead loop (0/23 ever promoted): the gate required a real reference, but a gotcha expired from recall (14d) before it could earn one, and it ran Sunday-only. Now runs **daily** with a **signal-OR-usage** gate (promote on a real reference OR repeated cross-agent injection: `times_injected≥3 ∧ distinct_agents≥2 ∧ importance≥8`). Paired with the bridge's `last_seen`-on-injection bump. First real promotion applied (0→1).
- `BRAINX_BACKGROUND_REVIEW_DOWNCADENCE_20260613` — background-review (skill-promoter + auto-create + auto-patch) down-cadenced 30min→6h; it applied 0 of 558 runs while re-materializing duplicate candidate dirs every tick. Cleaned 562 orphan candidate dirs (backed up). Tunable via `BRAINX_REVIEW_LOOP_BACKGROUND_INTERVAL_SECONDS`.
- `BRAINX_WORKING_STATE_REFRESH_20260613` — turn-harvester `updateWorkingState` no longer fossilizes durable state. It wrote `## Current` once (only on the default seed) then skipped forever as "human-managed", so a cut turn (rotation / native auto-compact / gateway restart / 401) resumed from a task days old or from another project — an agent answered about an unrelated audit after doing a merge; another answered about a different client while on an outbound task (its custom `## Tarea actual` doc never even matched the old `## Current` regex). Now keeps a marker-delimited block (`<!-- brainx-current:begin/end -->`) at the top, ALWAYS refreshed with the freshest detected task + a hard scope-verification warning, idempotent, never clobbering human sections. Pairs with the ACP harvest fix (harvester now both reads ACP transcripts and writes the freshest state). Tested: `tests/unit/working-state-refresh.test.js` 4/4, unit suite 53/53.
- `BRAINX_HARVESTER_TIMEOUT_VIGILANCE_20260613` — `brainx-cron-supervisor.mjs` now watches the review-loop's `turn-harvester` step-level health (rc=124 timeouts), paging only when timeouts recur within a window (default 3 in 3h) with a 6h re-notify guard. The job-level supervision missed these because the review-loop job still exits 0. Tunable via `BRAINX_HARVESTER_TIMEOUT_{WINDOW_HOURS,THRESHOLD,RENOTIFY_HOURS}`.

### Validation
- All harvesters: `node --check` OK + dry-runs confirm ACP discovery; real `session-harvester` runs wrote 36 memories from ACP reasoning. skills/brainx unit suite `49/49`. Plugin suite `213/213`.

## [Unreleased] - 2026-06-01

### Fixed

- **Superseded historical note:** BrainX Review Loop once projected `exec` to the reviewer agent so an agentTurn cron could run `brainx-review-loop-cron.sh`. Current topology supersedes that: Review Loop is a direct `command` payload and `brainx-reviewer` must keep shell tools denied.
- **Superseded historical note:** `brainx doctor` previously required `BrainX Amnesia Smoke` as part of the active topology. Current topology is the 2026-06-29 rule above: three direct command-payload orchestrators, with Amnesia Smoke retired and consolidate/closeout absorbed by Nightly Memory Loop.
- **Runtime regression suite wrapper resolves the live runner.** `cron/brainx-regression-suite.sh` now falls back to the workspace scripts directory (`brainx-regression-suite.mjs`), fixing the missing local `cron/brainx-regression-suite.mjs` failure while preserving the compatibility command path used by docs and Daily Core.
- **Runtime regression scoring invariant now follows the real operational denylist.** `brainx-regression-suite.mjs` reads `jitRecallDisabledAgents` from `openclaw.json` and excludes `brainx-reviewer` turn-harvester sessions, so maintenance/extraction runs do not fail the conversational injection scoring canary.
- **recall-health `inject` surface now self-calibrates instead of measuring itself.** `brainx doctor`'s fixed sentinel inject probe (always 0 results by design) was logged under `query_kind='inject'` — the same table/kind recall-health reads — so at doctor cadence (~20/day) the probe dominated the `inject` surface (~50% zero-result, 139/146 zeros) and the warning could never clear; real inject zero-result is ~4.7%. Self-test injects are now tagged `query_kind='inject_selftest'` via `--source selftest` / `BRAINX_QUERY_SOURCE` (`cmdInject`, marker `INJECT_SELFTEST_TAG_20260601`) and excluded from recall-health; `brainx doctor`'s two inject probes pass `--source selftest`.
- **`inject` (and other `brainx_query_log`-only surfaces) joined the adaptive baseline.** Previously stuck on the fixed cold-start threshold forever — the one surface that could not self-calibrate. recall-health now builds a prior-window baseline from `brainx_query_log` so `inject` judges itself against its own 30d norm and warns only on a genuine regression (marker `QUERY_LOG_ADAPTIVE_BASELINE_20260601`).
- Schema: expanded `brainx_query_log_query_kind_check` to allow `inject_selftest`/`search_selftest` (and re-assert `contradiction_check`, which had drifted out of the canonical schema). Migration `sql/migrations/2026-06-01_query_log_selftest_kind.sql` also backfills historical doctor-probe rows. Added regression test `testRecallHealthInjectSelfCalibratesVsBaseline` (cli-v5 46 passed).

### Added

- **Global Domain Ledger for personal/business candidates.** Added `brainx_domain_ledger` plus `scripts/domain-ledger-audit.js` and migration `sql/migrations/2026-06-11_domain_ledger.sql`. The BrainX Review Loop now runs the auditor after `turn-harvester` and writes only `candidate/hypothesis` rows for user-stated finance/accounting/crypto/proposal/email/client/personal signals. It is regex-only, checkpointed, filters OpenClaw notices/media/product UI invoice noise, and keeps workspace memories as local continuity instead of source-of-truth.
- **Per-agent attribution for query-log recall (`AGENT_ATTRIBUTION_20260601`).** Added `brainx_query_log.agent` (migration `sql/migrations/2026-06-01_query_log_agent_attribution.sql`) so `recall-health` can flag a single agent whose `inject` recall regressed even when the aggregate looks healthy — the same per-agent outlier detection `brainx_runtime_injections` already had. `cmdInject` resolves the agent from `--agent` / `OPENCLAW_AGENT` (set by the inject hook), so it auto-populates at runtime; historical rows stay `NULL` and are skipped until data accumulates. Per-agent inject outliers are merged into `recall-health` outliers and covered by `testCmdRecallHealth`.

## [Unreleased] - 2026-05-26

### Changed

- Added read-only `brainx recall-health` and wired it into `doctor --full` as a recall-quality warning surface covering runtime injections plus query-log recall (`jit_recall`, `inject`, `contradiction_check`, `recovery_preflight`, `working_memory`, and `project_ground`).
- Added a 2026-05-26 runtime audit snapshot covering active production surfaces, safe dormant/legacy simulations, and the explicit authorization boundary for DB-writing legacy/full-flow checks.
- Consolidated BrainX OpenClaw cron execution into two `brainx-reviewer` orchestrators:
  - `BrainX Review Loop` runs every 2h and absorbs Background Review, due-gated Session Snapshot, and due-gated Knowledge Sync.
  - `BrainX Maintenance` runs daily and absorbs Daily Core, Injection Health, Sunday Cleanup, and Sunday Skill Curator.
- Added `brainx-review-loop-cron.sh` and `brainx-maintenance-cron.sh` with locks, per-step logs, JSON payloads, and failure-preserving step status.
- Disabled the seven legacy BrainX cron jobs as rollback entries instead of deleting them.
- Set BrainX Maintenance to silent success delivery and BrainX Review Loop to actionable-only reports: skill candidates, applied skill changes, and skill review errors go to reports only when new; quiet/deduped runs respond `NO_REPLY`. Both active BrainX orchestrators keep failure alerts to the alerts channel.
- Enriched BrainX Review Loop skill-candidate reports with `humanSummary`, `messageText`, instruction previews, evidence counts, gates, and rejection explanations so reports show the possible improvement and why automation did not apply it.
- Added `doctor-actionable-fix` to Daily Core using `brainx fix --only stale-demotion,auto-dedup --json`, so BrainX Maintenance clears doctor-actionable stale hot/warm memories and high-similarity duplicate pairs without running the whole fix registry from cron.
- Extended daily `doctor-actionable-fix` with `runtime-scoring-backlog`, closing stale unscored runtime injection telemetry as `maintenance_expired_no_response` so old sessions cannot permanently pollute scoring metrics.

### Fixed

- Fixed `scripts/eval-memory-quality.js` so the evaluation command closes the BrainX DB pool and exits cleanly instead of hanging until external timeout.
- Added an explicit per-request LLM timeout to `scripts/memory-distiller.js` via `BRAINX_DISTILLER_TIMEOUT_MS` / `--llm-timeout-ms`, preventing dry-runs or cron execution from hanging indefinitely on a stalled OpenAI request.
- Made `scripts/memory-distiller.js` return `ok=false` and a non-zero exit code when every processed session fails, so Daily Core cannot silently treat total distillation failure as success.
- Suppressed `dotenv` stdout noise in `scripts/memory-distiller.js` so JSON output remains parseable by cron wrappers and audits.
- Suppressed `dotenv` stdout noise in JSON-emitting maintenance scripts: `memory-consolidator.js`, `cleanup-snapshots-trajectories.js`, `cleanup-low-signal.js`, and `dedup-supersede.js`.
- Hardened `brainx-maintenance-cron.sh` so a `Daily Core` `BRAINX_CLOSEOUT_EVIDENCE: status=partial` marks the orchestrator partial/error even when the underlying wrapper exits 0.
- Removed the active scheduling path that still referenced old MiniMax payload models for BrainX Session Snapshot, Injection Health, and Cleanup.
- Hardened `brainx-cron-supervisor.mjs` so fallback respects `enabled=false`, supervises active BrainX orchestrators, and cannot re-run disabled legacy BrainX jobs.
- Updated `brainx-regression-suite.mjs` so the selected-injection scoring invariant excludes internal `:cron:` scheduler sessions. Cron prompts are not conversational usefulness samples.
- Increased the `brainx.status` regression-suite RPC timeout to avoid false negatives during temporary OpenClaw event-loop/CPU starvation.
- Updated BrainX docs to reflect the then-current `44/0/0` fast doctor, `59/0/0` full doctor, `126/126` plugin tests, `25/25` runtime regression suite, and direct BrainX/Memory jobs. Current topology is documented above under `BRAINX_DOCTOR_CRON_TOPOLOGY_20260629`.
- Updated CLI tests with recall-health fake-DB coverage proving low-yield warnings and read-only query behavior.

## [0.4.0] - 2026-04-05

### Critical Bug Fixes

- **Stale memory injection** — All 5 hook query functions (`queryTopMemories`, `queryAgentMemories`, `queryByType`, `queryFacts`, `queryScopedMemories`) now filter out resolved, expired, and obsolete memories. Previously, a memory with `status='resolved'` would keep being injected into agent context indefinitely, causing agents to act on already-fixed issues.
- **Cross-agent learning unblocked** — Relaxed `verification_state` filter from `= 'verified'` to `IN ('verified', 'hypothesis')`. The old filter rejected 99.6% of candidates; only 2 memories had ever been tagged cross-agent out of 3,400+.
- **Auto-promotion unblocked** — Expanded `source_kind` whitelist from `('consolidated', 'llm_distilled')` to include `auto_harvested`, `memory_bridge`, `agent_inference`, `tool_verified`, `regex_extraction`. The old whitelist matched 0 real memories, so auto-promotion never found candidates.

### Security Audit — Standardized Injection Filters

All agent-facing query paths now enforce 4 mandatory safety filters:

```sql
AND superseded_by IS NULL
AND COALESCE(status, 'pending') NOT IN ('resolved', 'wont_fix')
AND (expires_at IS NULL OR expires_at > NOW())
AND COALESCE(verification_state, 'hypothesis') != 'obsolete'
```

**Files patched:** `hook/handler.js` (5 functions), `lib/openai-rag.js` (search), `lib/advisory.js` (trajectories + patterns JOIN), `lib/cli.js` (cmdFacts, cmdFeatures), `scripts/context-pack-builder.js`, `scripts/cross-agent-learning.js`.

### Added
- **39 differentiated agent profiles** — Replaced 33 identical profiles with role-specific configurations. 22 unique context sets, 11 unique boost sets, 21 agents with cross-agent enabled (was 0). Technical agents prioritize gotchas/infrastructure; writers prioritize business/client; researchers get broadest context with highest cross-agent ratio (0.30).
- **4 missing agent profiles** — Added `claude`, `codex`, `gemini`, `kimi`, `opencode` profiles for bare CLI workspaces that were falling back to DEFAULT_SAFE_PROFILE.
- **Advisory trajectory staleness guard** — `queryTrajectories` now limits to last 180 days, preventing advisories based on years-old problem-solution paths.
- **Advisory pattern memory filters** — `queryPatterns` JOIN now filters the representative memory by `superseded_by`, `status`, and `expires_at`, preventing pattern advisories backed by stale memories.
- **Documentation for 5 under-documented features** in `brainx.md`: Memory Feedback (#27), Learning Details (#29), Session Snapshots (#33), Low-Signal Cleanup (#34), Memory Reclassification (#35).

### Changed

- **Daily pipeline restructured from 16 to 10 steps** — 6 steps run daily (bootstrap, distiller, harvester, bridge, cross-agent, context-packs), 8 steps run weekly on Sundays (lifecycle, consolidation, contradiction, error-harvester, auto-promoter, promotion-applier, enforcer, audit). Estimated daily runtime reduced from ~120s to ~75s.
- **Removed `auto-distiller` from pipeline** — Produced only 2 memories/day, redundant with memory-distiller (17/day) and session-harvester (40/day).
- **Removed `memory-md-harvester` from pipeline** — 67% of its output was duplicate of session-harvester and memory-bridge. The unique 33% is already covered by memory-bridge.
- **Consolidation weekly guard fixed** — Consolidation now runs with `--force` on Sundays only, controlled by the wrapper instead of the broken `weekly-semantic-consolidation.sh` day-of-week check.
- **Error harvester expanded to 168h on Sundays** — Covers the full week instead of 48h daily.

### Fixed

- **Dotenv loading** — `import-workspace-memory-md.js` and `migrate-v2-to-v3.js` used `require('dotenv/config')` without explicit path, loading `.env` from CWD instead of BrainX directory.

## [Unreleased]

### Changed
- Replaced the three Skill Promoter cron profiles with the Hermes-style two-loop
  model: `BrainX Background Review` every 2h for near-event guarded
  auto-patch/auto-create, and `BrainX Skill Curator` weekly for lifecycle
  maintenance. The former daily light dry-run is disabled, and the former weekly
  auto-create job is repurposed as the curator.
- Hardened scheduled auto-patch ownership: existing-skill autopatch now requires
  high-confidence evidence and low patch risk for any registered skill, while
  authorization-only skills stay blocked: `agent-core`, `brainx`, `gws`,
  and `openclaw-runtime`.
- Lowered Background Review auto-patch and auto-create evidence gates to the
  Hermes-like threshold Marcelo requested: two strong recurring signals from
  two sources, while keeping confidence, raw-session evidence, BrainX
  confirmation, low-risk patching, and the four authorization-only skills.
- Consolidated BrainX OpenClaw cron ownership on `brainx-reviewer` only: Daily Core, Knowledge Sync, Session Snapshot, Cleanup, Injection Health, Background Review, and Skill Curator. Do not recreate a second BrainX cron agent such as `brainx-ops`; generic non-BrainX crons continue to use `alert` by default, and generic Memory jobs remain on `alert`.
- Enabled phase-2 auto-patch observation for the near-event BrainX reviewer:
  the cron now runs `BRAINX_SKILL_PROMOTER_AUTO_PATCH=1` with
  `BRAINX_SKILL_PROMOTER_DRY_RUN=1`, evaluating existing-skill patch gates
  without writing skill files.
- Enabled phase-3 guarded auto-patch for the near-event BrainX reviewer:
  replaced the dry-run observation job with `near_event_autopatch`, removed
  `BRAINX_SKILL_PROMOTER_DRY_RUN=1`, and kept the hard ban on `--apply`,
  `--auto-create`, and `--allow-existing-patch`. Real writes are limited to
  registered non-critical existing skills with confidence >= 0.9, recurrence >=
  2, sourceCount >= 2, raw-session evidence, BrainX confirmation, and
  `patchRisk=low`.

### Documentation
- Documented the 2026-05-06 BrainX runtime/architecture audit in `docs/RUNTIME_STATUS.md`, including current live validation, warning posture, canonical wiki vault nuance, and the plugin-to-skill coupling risk.
- Added an architecture note to `docs/ARCHITECTURE.md` clarifying that production runtime is healthy but still coupled to skill-owned modules, so runtime/plugin separation is the next cleanup before adding more prompt-time surfaces.
- Documented the 2026-05-06 cross-agent recall signal review: cross-agent selections are sparse (`17` selected rows over 7 days) and do not justify changing production dials yet.
- Updated `docs/INDEX.md` so the runtime audit is discoverable from the documentation entrypoint.
- Added [`docs/OPENCLAW_ALIGNMENT_2026-03-28.md`](./docs/OPENCLAW_ALIGNMENT_2026-03-28.md) to capture the current BrainX V5/OpenClaw alignment, validation status, current freeze policy, and future pending work.

### Added
- Added `BrainX Reviewer (near-event dry-run)`, an OpenClaw cron job owned by
  the dedicated `brainx-reviewer` agent on GPT-5.5. It runs the hybrid
  skill-promoter wrapper every 2h in dry-run mode, uses semantic review to
  reject project-specific/one-off noise, reports only actionable candidates,
  and never runs `--apply`, `--auto-create`, or
  `--allow-existing-patch`.
- Added `self-learning-audit`, a read-only autonomy report that combines
  runtime injection uptake, noisy/useful memory candidates, stale hot/warm
  rows, repeated failure signals, knowledge gaps, low-recall query summaries,
  and stale scoring backlog into prioritized recommendations. It is wired into
  the Daily Core wrapper as a non-mutating step.
- Added controlled `skill-promoter --auto-create` mode. It only creates
  high-confidence `create_new_skill` candidates with raw-session evidence,
  BrainX confirmation, sufficient recurrence/source count, no similar existing
  skill, agent-core registry regen, `openclaw skills check`, apply audit, and
  rollback.
- Added controlled `skill-promoter --auto-patch` mode for existing skills. It
  only applies candidates that pass high-confidence evidence gates and low-risk
  `classifyPatchRisk`; authorization-only operational skills `agent-core`,
  `brainx`, `gws`, and `openclaw-runtime` stay manual-only.
- Added `skill-promoter --hybrid` to read recent raw OpenClaw session JSONL, extract procedural user/assistant instructions, group them by inferred skill, confirm raw evidence against BrainX memories/patterns, and expose `sessionCoverage` metrics in dry-run payloads.
- Added `skill-promoter --per-agent` with `--agent-limit` and `--per-agent-limit` so dry-runs can fairly sample recurring procedural candidates across many active agents instead of relying only on the global top rows.
- Added Hermes-style BrainX skill apply/lifecycle mode: `skill-promoter --apply` can create `brainx-created` skills or explicitly patch existing skills with validation and rollback, and `skill-curator` adds status/list/pin/archive/restore/prune for BrainX-owned skills.
- Added brainx skill-promoter, a Hermes-style procedural promotion bridge that scans recurring BrainX patterns/memories and emits review-gated SKILL.md candidates without writing directly to the OpenClaw skills directory.
- Added `brainx router-quality` to report read-only router decision quality, including proposed IDs, selected overlap, strict/signal gate drops, hard/soft signal, latency, and recent decision labels.
- Added `brainx agent-metrics` to consolidate OpenClaw agent config, plugin coverage, and runtime injection telemetry into a per-agent operator report with JSON/plain output and media-generation agents excluded by default.
- Added migration `015_runtime_injections_session_key.sql` so runtime injection telemetry persists `session_key` for DB-backed scoring fallback.
- Added `brainx-backfill-rotation-events.mjs` to repair historical `session_rotation` runtime rows that missed `brainx_session_rotation_events`.
- Added conservative scoring fallback for Codex/background `NO_REPLY` + delivery-mirror turns: exact non-answer outputs keep selected-injection cache alive, and typed `message_sent` is observed as scoring-only by `sessionKey`.
- Added `brainx_session_rotation_events` plus `brainx-session-rotation-monitor.mjs` to audit real OpenClaw `sessionId` rotations by agent/sessionKey.
- Added hard `session_rotation` recovery: the plugin reads previous `brainx_context_state` before updating it, detects a changed OpenClaw `sessionId` for the same `sessionKey`, and forces compact recovery for meaningful non-ack prompts.
- Added context broker planning in the BrainX plugin: classify turn intent, infer runtime family, choose one surface, and suppress generic ACP recall unless the turn needs recovery, historical/procedural memory, or troubleshooting evidence.
- Added artifact ledger v2 fields (`artifact_role`, `provenance`, `finality_score`, `metadata`) plus `brainx_context_state` for compact `agent + session_key` handoff state across OpenClaw `sessionId` rotation.
- Added migration `013_context_broker_artifact_v2.sql`.
- Added `handoff-promoter.js` to promote recent session snapshots into durable hot memories and `brainx_artifact_ledger` rows.
- Added semantic recovery preflight in the BrainX plugin so continuation/context-loss requests are detected by router-assisted intent classification, not only fixed regex phrases.
- Added compact deterministic cron wrappers for `Memory Daily Closeout`, `Memory Daily Consolidate`, and `BrainX Injection Health` reliability.
- Added `hook-live/` with a new managed hook `brainx-live-capture` that listens on `message:sent` and persists high-signal outbound recommendations into daily memory and BrainX V5 in near-real-time.
- Added `lib/live-capture-stats.js` so the runtime hook, `doctor`, and `metrics` share the same live-capture telemetry parser/writer.

### Changed
- `brainx-skill-promoter-cron.sh` now supports optional high-confidence
  auto-create via `BRAINX_SKILL_PROMOTER_AUTO_CREATE=1` and optional low-risk
  auto-patch via `BRAINX_SKILL_PROMOTER_AUTO_PATCH=1`; critical existing skill
  patches remain review-gated with manual `--allow-existing-patch`.
- `brainx-skill-promoter-cron.sh` now supports
  `BRAINX_SKILL_PROMOTER_DRY_RUN=1`, letting cron jobs observe auto-create or
  auto-patch behavior through the real applier path without mutating skills.
- Skill apply validation now regenerates agent-core skill references before
  `openclaw skills check`, confirms the target skill appears in the check
  output when available, and writes successful apply audit JSON.
- `skill-promoter` now merges OpenClaw runtime skill discovery with filesystem skill slugs when classifying existing skills, preventing local skills such as `brainx` from being misclassified as new-skill candidates.
- `skill-promoter` now has an explicit apply path with selector gates (`--skill`, `--candidate-file`, or `--all`), sidecar ownership, and rollback on failed `openclaw skills check` or agent-core registry regen.
- `brainx skill-promoter` now follows the agent-core skill registration model by using `openclaw skills list --json` as the primary existing-skill source, adding an agent-core registration checklist to candidates, and documenting the required `openclaw skills check` plus `regen-references.sh skills --apply` closeout.
- Rotation event logging now normalizes `previous_updated_at` to ISO before DB insert and logs insert failures instead of swallowing them silently.
- `brainx-injection-health.sh` now finalizes stale selected rows as zero-reference telemetry after the scoring window and exits non-zero if stale selected rows remain unscored.
- `context-pack-builder.js` now upserts stable pack IDs by context/window instead of appending timestamped duplicate rows on every run.
- `session_rotation` now overrides generic triggers so rotation recovery cannot be masked by `domain`, `explicit`, or other earlier trigger reasons.
- Documented the ACP runtime-heal ownership boundary: the runtime-heal agent owns Claude ACP process/session repair and upstream resume; BrainX owns prompt-time memory/evidence and must not reset or rewrite ACP state.
- Replaced the former `recovery_preflight` delivery-mirror telemetry caveat with the implemented scoring fallback and refreshed regression status.
- `alert`, `monitor`, and `monitor-public` are now excluded from JIT recall to keep cron/heartbeat surfaces quiet and avoid unscored memory-injection telemetry.
- Recovery preflight now searches typed context state and finality-ranked artifacts, so final deliverables outrank `/tmp`, tool-read, and weak exec noise.
- Updated production scheduler documentation to the current 13 daily + 2 Wednesday/Sunday + 7 Sunday-only Daily Core topology.
- Documented the operational cron count: 7 direct BrainX/Memory jobs, or 9 including mixed user-crontab wrappers.
- Reduced `BrainX Injection Health` report size to top 10 details and top 5 warnings by default so alert-agent cron delivery does not time out.
- Standardized the OpenClaw bootstrap policy to a single generic baseline across all 32 agent profiles, avoiding premature per-agent specialization.
- The auto-inject hook now hot-reloads `hook/agent-profiles.json` on every bootstrap and applies `scoringWeights` as real weighted ranking signals instead of decorative metadata.
- `doctor` now validates live-capture deployment, managed-hook sync, and recent runtime telemetry (`seen`, `captured`, `low_signal`, `duplicate`, failures, latency, last success/error).
- `metrics` now includes a `live_capture` section with the same observability surface used by `doctor`.

### Fixed
- Hardened `skill-promoter` filtering so project-specific implementation notes
  with bug-fix wording and code/function identifiers are discarded before they
  can become reusable skill candidates.
- Fixed `doctor` backup freshness detection for the consolidated
  `backup-all-dbs` path: successful `brainx-weekly` ledger rows now count when
  the attempt log confirms R2 upload and verification.
- Fixed `doctor` backup freshness detection so compressed `brainx_backup_*.tar.gz`
  archives created by `scripts/backup-brainx.sh` count as valid fresh backups
  instead of reporting an older `.dump` file.
- Aligned `doctor` stale-memory warnings with `brainx fix` demotion policy so
  hot/warm memories are only reported when they are actionable by the repair
  path.
- Fixed migration dry-run detection for `016_policy_decisions.sql` so `brainx fix`
  recognizes the already-applied policy-decision table and indexes.
- Fixed `skill-promoter --hybrid` instruction curation so one-off project-specific link checks and promoter meta-instructions do not leak into reusable `playwright-browser-automation` skill patch candidates; reusable instructions now filter project-specific checks before draft generation and raw instructions need per-instruction lexical confirmation from matching BrainX memory/pattern evidence.
- Fixed `recovery_preflight` selected rows staying unscored when Codex/background runtime emits exact `NO_REPLY` and OpenClaw delivers the visible answer later through delivery-mirror.
- Fixed `brainx-regression-suite` scoring guard so cron/ops agents excluded from JIT do not fail `recent-selected-injections-scored`; conversational agents remain covered by the invariant.
- Fixed passive handoff behavior where useful `brainx_session_snapshots` existed but were not promoted to durable memory/artifact state.
- Fixed public runtime-context/preflight leakage by documenting and pairing BrainX bridge wording changes with OpenClaw delivery sanitizer behavior.
- Fixed stale BrainX/Memory cron error states and made maintenance crons wrapper-first with compact output.
- Closed the gap where profile JSON edits were live but profile ranking behavior still depended on a fixed `ORDER BY`.

## [0.3.6] - 2026-03-27

### Added
- Added `verification_state` governance with `verified`, `hypothesis`, `changelog`, and `obsolete`.
- Added `scripts/calibrate-verification-state.js` for conservative post-hoc promotion of durable memories.
- Added `scripts/cleanup-promotion-suggestions.js` to purge stale, low-signal, or duplicate promotion suggestions before they reach workspace rules.

### Changed
- Bootstrap trust model hardened: `learning` is excluded from auto-injection by default and top injected memories now prefer stronger verified signal over broad historical context.
- Retrieval and advisory now heavily prefer `verified` memories; cross-agent propagation is limited to verified operational knowledge.
- Auto-promotion is now review-gated: `promotion-applier.js --apply` requires `--force-apply` or `BRAINX_PROMOTION_AUTO_APPLY=true`.
- Default promotion threshold raised to recurrence `6`.
- Local BrainX `.env` now overrides inherited shell env in direct script execution, preventing reads/writes against the wrong `DATABASE_URL`.

### Fixed
- Closed the bootstrap side-door where `learnings.md` could still reintroduce noisy context.
- Reduced harvester overclassification of debugging narration into durable `learning`.
- Cleaned the historical promotion backlog down to reviewed outcomes only: `68 promoted`, `53 wont_fix`, `0 pending`.
- Second-pass calibration promoted `66` durable memories from `changelog` to `verified`, bringing the verified pool to `312`.
- Demoted `13` stale hot/warm memories to `cold`, clearing the last doctor warning and leaving the baseline at `26 passed`.

## [0.3.5] - 2026-03-24

### Changed
- Published to ClawHub with explicit `--name` flag fixing display name to full "BrainX V5 — The First Brain for OpenClaw".

### Fixed
- Refactored `lib/openai-rag.js` to remove `fetch` and `process.env` reads; embedding client fully extracted to `lib/embedding-client.js`. Scanner security flag cleared.

---

## [0.3.1] - 2026-03-24

### Fixed
- **Singleton pool**: Refactored hook handler to use singleton PostgreSQL pool with try-catch, preventing connection leaks on bootstrap.
- **PII password scrub**: Added Spanish/English password regexes, scrubbed 24 memories containing secrets.
- **Search defense-in-depth**: Added null embedding filter on search results.
- **Stale memory cleanup**: Demoted 17 low-signal memories via lifecycle promotion/demotion run.
- **DATABASE_URL**: Added to central `~/.openclaw/.env` so hook loads reliably after gateway restart.

### Changed
- README version bumped to 0.3.1.
- Config limits aligned between CLI and hook.
- Weekly automatic backups configured and tested.
- All 17 BrainX doctor checks passing.

---

## [0.3.0] - 2026-03-18

### Added
- **Promotion applier**: Auto-promotes recurring BrainX patterns to AGENTS.md/TOOLS.md per agent.
- **15-step pipeline**: Full memory lifecycle from ingestion to promotion.
- **32 agent profiles**: Expanded from 10 to 32 profiles for hook injection.

### Fixed
- Sanitized README — removed personal data, internal paths, and operational details.
- Restored skill name to "BrainX V5" after security flag workaround.

---

## [0.2.8] - 2026-03-16

### Added
- **Security trust section** in SKILL.md.
- **feature_request** CLI shortcut.
- **error-harvester** script: Extracts errors from session logs for automatic learning.
- **auto-promoter** script: Surfaces recurring patterns for rule promotion.
- **35-feature table** in SKILL.md for ClawHub visibility.

### Fixed
- PII phone regex for 7-digit numbers.
- Backup scripts updated for V5 paths.
- eval-dataset NaN crash.
- Simplified skill name to use hyphen instead of em-dash for ClawHub compatibility.

### Changed
- Excluded cron, tests, scripts from published package to reduce security flags.
- Bumped through 0.2.1 → 0.2.5 → 0.2.8 for ClawHub publishes.

---

## [0.2.0] - 2026-03-16

### Added
- First ClawHub publish.
- SKILL.md translated to English.
- Redacted leaked token from repo.

### Fixed
- **Cross-agent memory injection**: Reserved 30% slots for other agents' memories.
- **Hook query split**: `queryAgentAwareMemories` split into own + cross slots.
- **CLI positional args**: Support for `add`/`fact` positional arguments.

### Changed
- Validation and sync checklist documented.
- Memory-md-harvester script added.

---

## [0.1.0] - 2026-03-15

### Added
- **BrainX V5 core**: Advisory system, EIDOS evaluation loop, memory consolidation, agent-aware injection.
- **MEMORY.md block injection**: Auto-inject hook for OpenClaw gateway bootstrap.
- **Fix for MEMORY.md duplication**: Use `lastIndexOf` for BrainX markers to prevent block duplication.
- Audit fixes, gotchas injection, schema migrations, CLI documentation.

### Changed
- Major rewrite from V4 to V5 architecture.

---

## [0.0.x] - 2026-02-15 to 2026-03-05

### Added
- **V4 core**: Governance, lifecycle, observability (2026-02-23).
- **Auto-inject hook**: Bootstrap hook, backup/restore system, disaster recovery (2026-02-20).
- **OpenClaw skill integration**: SKILL.md + README for skill ecosystem (2026-02-19).
- **CLI**: `add`, `search`, `inject`, `health`, `doctor`, `fact`, `resolve`, `advisory`, `eidos` commands.
- **pgvector**: Semantic search with OpenAI embeddings.
- **Truncation**: Max chars/lines per memory on inject output.
- **Documentation**: Full docs set with quickstart and usage.

### Fixed
- Symlink ROOT resolution + `--help` without env.
- Embedding excluded from search SELECT for compact output.

---

*Generated from git history — 2026-03-24*
