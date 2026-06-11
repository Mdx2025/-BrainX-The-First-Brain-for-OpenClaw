# CLI Reference (brainx)

Entry point: `./brainx`

Internally it delegates to `lib/cli.js`.

## Global help

```bash
./brainx --help
```

## `health`

Runs a database smoke test:

```bash
./brainx health
```

Checks:

- DB connectivity (`select 1`)
- pgvector installed
- `brainx_*` tables exist

## `add`

Store (upsert) a memory item.

```bash
./brainx add \
  --type <type> \
  --content <text> \
  [--context <ctx>] \
  [--tier <hot|warm|cold|archive>] \
  [--importance <1-10>] \
  [--tags a,b,c] \
  [--agent <name>] \
  [--id <id>] \
  [--status <pending|in_progress|resolved|promoted|wont_fix>] \
  [--category <learning|error|feature_request|correction|knowledge_gap|best_practice>] \
  [--patternKey <key>] \
  [--recurrenceCount <n>] \
  [--firstSeen <iso>] \
  [--lastSeen <iso>] \
  [--resolvedAt <iso>] \
  [--promotedTo <target>] \
  [--resolutionNotes <text>]
```

Notes:

- If `--id` is omitted, an id like `m_<timestamp>_<rand>` is generated.
- Embedding input is built as:
  - `${type}: ${content} [context: ${context}]`
- Phase 2 store pipeline adds:
  - optional PII scrubbing before embedding/storage (`BRAINX_PII_SCRUB_ENABLED`, `BRAINX_PII_SCRUB_REPLACEMENT`)
  - semantic dedupe merge in recent same `context`/`category` (`BRAINX_DEDUPE_SIM_THRESHOLD`)
  - redaction metadata tags like `pii:redacted`, `pii:email`

## `search`

Semantic search returning JSON.

```bash
./brainx search \
  --query <text> \
  [--limit <n>] \
  [--minSimilarity <0-1>] \
  [--context <ctx>] \
  [--tier <tier>] \
  [--minImportance <n>]
```

Returned fields include:

- all table columns
- `similarity`
- `score`

## `event`

Deterministic forensic ledger for important fixes, incidents, decisions,
deployments, handoffs, and audits. This complements `brainx_memories`: memories
answer semantic relevance, events answer what happened, when, where, and with
which evidence.

## self-learning-audit

Read-only autonomy report for BrainX memory learning. It combines runtime
injection uptake, stale hot/warm memories, useful-memory candidates, repeated
failure signals, knowledge gaps, and low-recall query summaries into
prioritized recommendations.

Examples:

    ./brainx self-learning-audit --days 14
    ./brainx self-learning-audit --days 14 --limit 25 --json

Safety model:

- Read-only by design; it does not update, delete, promote, or degrade rows.
- Recommendations point to the dedicated gated scripts/commands that should be
  reviewed before any write action.
- Query text is not stored or surfaced; low-recall query reporting uses
  privacy-preserving aggregate counters from `brainx_query_log`.

## skill-promoter

Hermes-style procedural promotion for BrainX. It scans recurring memories and
patterns, classifies reusable workflow signal, and emits draft skill candidates
behind a review gate. With `--hybrid`, it also reads recent raw OpenClaw
session JSONL files, extracts direct procedural instructions, groups them by
inferred skill, and confirms raw evidence against BrainX memories/patterns.

Examples:

    ./brainx skill-promoter --days 60 --min-recurrence 4
    ./brainx skill-promoter --json
    ./brainx skill-promoter --per-agent --days 90 --min-recurrence 2 --agent-limit 80 --per-agent-limit 20 --json
    ./brainx skill-promoter --hybrid --days 14 --session-limit 120 --per-agent-session-limit 8 --json
    ./brainx skill-promoter --emit-dir /tmp/brainx-skill-candidates
    ./brainx skill-promoter --auto-create --dry-run
    ./brainx skill-promoter --auto-create --auto-create-min-confidence 0.9
    ./brainx skill-promoter --auto-patch --dry-run
    ./brainx skill-promoter --auto-patch --auto-patch-min-confidence 0.95
    ./brainx skill-promoter --apply --skill <candidate-slug>
    ./brainx skill-promoter --apply --candidate-file /tmp/brainx-skill-candidates/<slug>.candidate.md
    ./brainx skill-promoter --apply --all --dry-run

Safety model:

- Dry-run by default.
- `--per-agent` adds a fair-share scan across active memory agents. The normal
  global scan still runs first, then each active agent gets up to
  `--per-agent-limit` pattern rows and memory rows before candidates are
  grouped. Use this for broad fleet testing across many active agents.
- `--hybrid` adds raw session scanning. It skips synthetic prompt/context
  envelopes, extracts only actionable instructions from user/assistant
  messages, and reports `sessionCoverage` with sessions, messages, extracted
  instructions, and BrainX-confirmed raw rows.
- Candidate extraction rejects project-specific implementation notes that pair
  bug-fix wording with concrete code/function identifiers; those belong in
  project docs or memory, not reusable skills.
- Apply mode requires an explicit selector: `--skill`, `--candidate-file`, or
  `--all`.
- Auto-create mode does not patch existing skills. It only creates
  `create_new_skill` candidates that pass the high-confidence gates:
  confidence, recurrence, source count, raw-session evidence, BrainX
  confirmation, and no similar existing runtime skill.
- Auto-patch mode only patches existing registered skills when the candidate
  passes the high-confidence gates and `classifyPatchRisk` returns low risk.
  It enables the existing-patch applier internally, writes an audit entry, and
  blocks authorization-only operational skills: `agent-core`, `brainx`,
  `gws`, and `openclaw-runtime`.
- Production cron now uses the Hermes-style
  `brainx-background-review-cron.sh` wrapper instead of separate daily,
  near-event, and weekly Skill Promoter profiles.
- New skills are written as `brainx-created` and tracked in
  `~/.openclaw/skills/.brainx-skill-usage.json`.
- Manual existing-skill patches require `--allow-existing-patch`; scheduled
  autopatch can patch any registered non-authorization-only skill when the
  evidence and low-risk gates pass.
- Merges `openclaw skills list --json` with filesystem skill names to classify
  existing skills, matching agent-core runtime registration while still catching
  local directory slugs such as `brainx`.
- --save only stores drafts as BrainX memories tagged skill-candidate and
  brainx-skill-promoter.
- Real apply loads the candidate, writes the skill/patch, refreshes
  `SKILLS_REGISTRY.md` with
  `~/.openclaw/skills/agent-core/scripts/regen-references.sh skills --apply`,
  verifies with `openclaw skills check`, and stores an apply audit JSON under
  the skills root.
  If validation fails, the file/sidecar change is rolled back.

## skill-curator

Hermes-style lifecycle for BrainX-created skills.

Examples:

    ./brainx skill-curator status
    ./brainx skill-curator list
    ./brainx skill-curator pin <skill>
    ./brainx skill-curator archive <skill>
    ./brainx skill-curator restore <skill>
    ./brainx skill-curator prune --days 90 --dry-run
    ./brainx skill-curator prune --days 90 --yes

The curator only manages skills marked `brainx-created` in the sidecar. Archive
is reversible and moves directories to `~/.openclaw/skills/.brainx-archive/`.

## `agent-metrics`

Consolidated per-agent BrainX runtime report. It crosses OpenClaw agent config,
the `brainx` plugin config, and `brainx_runtime_injections` telemetry so operators
do not have to manually reconcile `doctor`, `runtime-report`, `explain`, and
`brainx.status`.

```bash
./brainx agent-metrics --days 7
./brainx agent-metrics --days 7 --json
./brainx agent-metrics --days 7 --include-media-gen
```

Per agent it reports:

- BrainX enabled/disabled and the disable reason.
- active plugin features for that agent.
- latest runtime injection.
- injection count, selected memories, hard/soft signal, drops, and latency.
- surfaces used in the reporting window.
- status: `healthy`, `low-signal`, `no-recent-activity`,
  `disabled-intentional`, or `plugin-disabled`.

By default it excludes `media-gen*` agents because they are visual-generation
agents. Use `--include-media-gen` when auditing every configured agent.

## `router-quality`

Read-only quality report for BrainX router decisions. It focuses on runtime rows
where the router was active, so it complements `runtime-report` and
`agent-metrics`: health tells whether BrainX works, this tells whether router
selection is useful, safe, weak, or slow.

```bash
./brainx router-quality --days 7
./brainx router-quality --days 7 --json
./brainx router-quality --days 7 --agent matrix
./brainx router-quality --days 7 --surface jit_recall --limit 50
```

It reports:

- router events, applied/errors/fail-closed counts.
- proposed ids, selected overlap, selected memories, strict guard drops, and
  signal gate drops.
- hard/soft signal after the response is scored.
- total and router latency averages.
- quality labels for recent decisions: `good`, `safe-empty`, `weak`,
  `pending-score`, `router-error`, or `no-selection`.

Use it before tuning router prompts, thresholds, strict guards, or fatigue rules.

## `recall-health`

Read-only quality health for BrainX recall surfaces. It combines
`brainx_runtime_injections` and `brainx_query_log` so prompt-time recall and
manual/CLI recall are audited together.

```bash
./brainx recall-health --days 7
./brainx recall-health --days 7 --json
./brainx recall-health --days 7 --min-calls 10
```

It warns on:

- high zero-result rate
- high zero-selected rate when it is not an expected intent-gate/router-empty outcome
- selected memories with no hard or soft signal after scoring
- stale selected runtime rows older than 6h
- `contradiction_check` returning zero yield repeatedly

`recall-health` is surface-aware:

- `jit_recall` high zero-selected can be reported as
  `high_zero_selected_treated_as_intent_gate_or_router_empty` instead of a
  warning when the router/gate correctly chose not to inject.
- `working_memory` empty result turns are OK when there is no active state or
  the selected state remains useful when injected.
- `project_ground` is a preventive anchor surface, not normal recall; low
  explicit citation is not treated as failure by itself.

Self-calibrating (marker `QUERY_LOG_ADAPTIVE_BASELINE_20260601`): every surface is
judged against its **own** prior-window baseline (default 30d), not a fixed number,
and warns only on a real regression vs that baseline (with absolute hard-cap
backstops for genuine breakage). Cold-start surfaces with too little history fall
back to the fixed thresholds. As of 2026-06-01 the `brainx_query_log`-only surfaces
(`inject`, `contradiction_check`) also get an adaptive baseline, so `inject` is no
longer pinned to the fixed cold-start threshold. Self-test traffic
(`query_kind='inject_selftest'`, see `inject --source selftest`) is excluded, so the
`inject` surface reflects real runtime recall only. No human knob to keep tuning.

Per-agent attribution (marker `AGENT_ATTRIBUTION_20260601`): `brainx_query_log` now
records the issuing `agent` (resolved from `inject --agent` / `OPENCLAW_AGENT`), so
`recall-health` surfaces per-agent `inject` outliers — a single agent whose recall
regressed even when the aggregate looks healthy — in the `outliers` list, the same
way `brainx_runtime_injections` surfaces are broken down by agent. Rows without an
agent (pre-attribution history) are skipped.

`doctor --full` includes this as `Recall quality`. Warnings are diagnostic; this
command does not mutate memories or telemetry.

```bash
./brainx event init [--json]
```

```bash
./brainx event add \
  --type <fix|bug|decision|incident|handoff|deployment|audit|note> \
  --title <text> \
  --summary <text> \
  [--occurred-at <iso>] \
  [--project <key>] \
  [--domain <name>] \
  [--severity <critical|high|medium|low|info>] \
  [--agent <name>] \
  [--runtime-family <name>] \
  [--root-cause <text>] \
  [--action-taken <text>] \
  [--outcome <text>] \
  [--status <open|in_progress|fixed|validated|superseded|wont_fix>] \
  [--source-kind <kind>] \
  [--source-path <path>] \
  [--related-id <id>] \
  [--file <path>] \
  [--command <command>] \
  [--tag <tag>] \
  [--metadata <json>] \
  [--no-embed] \
  [--json]
```

```bash
./brainx event search \
  [--query <text>] \
  [--project <key>] \
  [--domain <name>] \
  [--type <type>] \
  [--status <status>] \
  [--agent <name>] \
  [--tag <tag>] \
  [--from <iso|date>] \
  [--to <iso|date>] \
  [--limit <n>] \
  [--json]
```

```bash
./brainx event timeline \
  [--project <key>] \
  [--domain <name>] \
  [--month <yyyy-mm>] \
  [--limit <n>] \
  [--json]
```

## `inject`

Semantic search formatted as a prompt-ready block (plain text).

```bash
./brainx inject \
  --query <text> \
  [--limit <n>] \
  [--context <ctx>] \
  [--tier <tier>] \
  [--minImportance <n>] \
  [--minScore <n>] \
  [--maxTotalChars <n>] \
  [--maxCharsPerItem <n>] \
  [--maxLinesPerItem <n>] \
  [--source <selftest>]
```

Defaults:

- `BRAINX_INJECT_DEFAULT_TIER=warm_or_hot`
  - if you don’t pass `--tier`, inject searches hot then warm and merges unique ids.
- `BRAINX_INJECT_MIN_SCORE=0.25`
- `BRAINX_INJECT_MAX_TOTAL_CHARS=12000`

`--source selftest` (or `BRAINX_QUERY_SOURCE=selftest`) tags the query-log row as
`query_kind='inject_selftest'` instead of `inject` (marker
`INJECT_SELFTEST_TAG_20260601`). Diagnostic/self-test injects — e.g. `brainx
doctor`'s fixed sentinel probe, which returns 0 results by design — must use it so
they are excluded from `recall-health`; otherwise the probe pollutes the `inject`
surface and the recall thermometer measures itself. Production injects omit it.

Output format:

```
[sim:0.62 imp:9 tier:hot type:decision agent:coder ctx:openclaw]
<content>

---

[sim:0.41 imp:6 tier:warm type:note agent:system ctx:emailbot]
<content>
```

## Environment variables

Required:

- `DATABASE_URL`
- `OPENAI_API_KEY`

Optional:

- `BRAINX_ENV` — load a shared env file from a specific path
- `OPENAI_EMBEDDING_MODEL`
- `OPENAI_EMBEDDING_DIMENSIONS`
- `BRAINX_INJECT_DEFAULT_TIER`
- `BRAINX_INJECT_MAX_CHARS_PER_ITEM`
- `BRAINX_INJECT_MAX_LINES_PER_ITEM`
- `BRAINX_INJECT_MAX_TOTAL_CHARS`
- `BRAINX_INJECT_MIN_SCORE`
- `BRAINX_PII_SCRUB_ENABLED` (default `true`)
- `BRAINX_PII_SCRUB_REPLACEMENT` (default `[REDACTED]`)
- `BRAINX_PII_SCRUB_ALLOWLIST_CONTEXTS` (csv; contexts que NO se redactan)
- `BRAINX_DEDUPE_SIM_THRESHOLD` (default `0.92`)
- `BRAINX_DEDUPE_RECENT_DAYS` (default `30`)
- `BRAINX_LIFECYCLE_PROMOTE_MIN_RECURRENCE` (default `3`)
- `BRAINX_LIFECYCLE_PROMOTE_DAYS` (default `30`)
- `BRAINX_LIFECYCLE_DEGRADE_DAYS` (default `45`)
- `BRAINX_LIFECYCLE_LOW_IMPORTANCE_MAX` (default `3`)
- `BRAINX_LIFECYCLE_LOW_ACCESS_MAX` (default `1`)

## `resolve`

Set lifecycle resolution fields on a single memory (`--id`) or by recurring pattern (`--patternKey`).

```bash
./brainx resolve \
  (--id <id> | --patternKey <key>) \
  --status <pending|in_progress|resolved|promoted|wont_fix> \
  [--resolvedAt <iso>] \
  [--promotedTo <target>] \
  [--resolutionNotes <text>]
```

Returns JSON with updated rows.

## `promote-candidates`

Lists recurring patterns that meet promotion thresholds. Output is JSON.

```bash
./brainx promote-candidates \
  [--minRecurrence <n>] \
  [--days <n>] \
  [--limit <n>] \
  [--json]
```

Defaults: `--minRecurrence 3`, `--days 30`, `--limit 50`

## `lifecycle-run`

Automates lifecycle transitions:

- promote recent recurring items to `promoted`
- degrade stale `pending` / `in_progress` items to `pending` or `wont_fix` based on importance/access
- refresh affected `brainx_patterns` aggregate status/recurrence timestamps

```bash
./brainx lifecycle-run \
  [--promoteMinRecurrence <n>] \
  [--promoteDays <n>] \
  [--degradeDays <n>] \
  [--lowImportanceMax <n>] \
  [--lowAccessMax <n>] \
  [--dryRun] \
  [--json]
```

Defaults (env-overridable): promote `recurrence>=3` within `30` days, degrade stale after `45` days.

## `metrics`

Operational KPIs (JSON):

- counts by status/category/tier
- top recurring patterns
- search/inject query performance from `brainx_query_log`
- `live_capture` telemetry from `brainx-live-capture.log`
  - `seen`, `captured`, `low_signal`, `duplicate`, `capture_failed`
  - `daily_memory_failures`, `brainx_store_failures`
  - latency summary and last success/error timestamps

```bash
./brainx metrics [--days <n>] [--topPatterns <n>] [--json]
```

## `runtime-report`

Read-only report for runtime prompt injections from `brainx_runtime_injections`.
The report distinguishes strict usage (`hard`) from weak/contextual usage
(`soft`), because `referenced_count` is intentionally conservative and can
under-count memories the model used without quoting.

```bash
./brainx runtime-report [--days <n>] [--json]
```

Key fields:

- `hard_signal_ratio_pct` = `sum(referenced_count) / sum(selected_count)`
- `soft_signal_ratio_pct` = `sum(soft_referenced_count) / sum(selected_count)`
- per-agent and per-surface selected/hard/soft counts

## `explain`

Read-only inspection for individual BrainX runtime injection decisions. Use it
to debug why BrainX injected or skipped context for a turn, what router decision
was recorded, and whether selected memories were later hard/soft referenced.

```bash
./brainx explain --id <runtime_injection_id> [--json]
./brainx explain --session <session_id> [--limit <n>] [--json]
./brainx explain --sessionKey <session_key> [--limit <n>] [--json]
./brainx explain --agent <agent> [--limit <n>] [--json]
```

## Offline eval harness

Run retrieval quality checks from a JSON/JSONL dataset of `query` + `expected_key` pairs:

```bash
npm run eval:memory-quality -- --json
# or
node ./scripts/eval-memory-quality.js --dataset ./tests/fixtures/memory-eval-sample.jsonl --k 5 --json
```

Outputs proxy metrics including `hit_at_k_proxy`, `avg_top_similarity`, and duplicate reduction by collapsing top-k results on `pattern_key`.

## Exit codes

- `0` on success
- `1` on error (prints message to stderr)

## `doctor`

Diagnose BrainX installation health, schema, cron, and configuration issues.

`doctor` now also validates the near-real-time live-capture surface:

- bootstrap hook deployed
- live capture hook deployed
- managed hook source == deployed
- live-capture telemetry available and summarized from recent production logs

```bash
./brainx doctor [--json]
```

## `fix`

Auto-fix issues detected by `doctor`.

```bash
./brainx fix [--json] [--dry-run]
```

## `fact`

Shortcut to add a fact-type memory (tier: hot, category: infrastructure).

```bash
./brainx fact --content "Some important fact"
```

## `facts`

List stored facts, optionally filtered by context.

```bash
./brainx facts [--context <ctx>] [--limit 30]
```

## `promote-candidates`

Promote recurring memories from agent-local to global tier.

```bash
./brainx promote-candidates [--minRecurrence 3] [--days 30] [--limit 50]
```

## `lifecycle-run`

Run the full memory lifecycle (promote + degrade + archive).

```bash
./brainx lifecycle-run [--promote-min-recurrence 3] [--promote-days 30] [--degrade-days 45]
```

## `advisory`

Check BrainX advisories before executing a high-risk tool.

```bash
./brainx advisory --tool <tool> [--args '{}'] [--agent <agent>] [--project <project>] [--json]
```

## `advisory-feedback`

Record whether an advisory was followed.

```bash
./brainx advisory-feedback --id <advisory_id> --followed yes|no [--outcome "..."]
```

## `eidos`

Behavioral prediction and pattern evaluation engine.

```bash
./brainx eidos predict|evaluate|distill|stats [options]
```
