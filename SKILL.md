---
name: "BrainX V6 Runtime / V5 Skill"
description: |
  Vector memory engine with PostgreSQL + pgvector + OpenAI embeddings.
  Stores, searches, and injects contextual memories into LLM prompts.
  Uses the BrainX plugin as the primary runtime route, with legacy hooks kept review-gated.
metadata:
  openclaw:
    emoji: "🧠"
    requires:
      bins: ["psql"]
      env: ["DATABASE_URL", "OPENAI_API_KEY"]
    primaryEnv: "DATABASE_URL"
user-invocable: true
---

# BrainX V6 Runtime / V5 Skill

Persistent memory system using vector embeddings for contextual retrieval in AI agents.

## 44 Implemented Capabilities

Treat this as a grouped capability map, not as 39 unrelated product bullets. In practice, these cluster into storage/retrieval, trust/governance, bootstrap/live capture, maintenance/ops, knowledge, and evaluation.

| # | Feature | Description |
|---|---------|-------------|
| 1 | ✅ **Production** | Active on the shared host memory pool with centralized storage and retrieval across agents |
| 2 | 🧠 **Auto-Learning** | Captures and curates memory automatically from conversations, with review gates where durable rule writes would be risky |
| 3 | 💾 **Persistent Memory** | Remembers across sessions — PostgreSQL + pgvector |
| 4 | 🤝 **Shared Memory** | All agents share the same knowledge pool |
| 5 | 💉 **Runtime Briefing** | Plugin-governed recall and session context, enabled conservatively per runtime policy |
| 6 | 🔎 **Semantic Search** | Searches by meaning, not exact keywords |
| 7 | 🏷️ **Intelligent Classification** | Auto-typed: facts, decisions, learnings, gotchas, notes |
| 8 | 📊 **Usage-Based Prioritization** | Hot/warm/cold tiers — automatic promote/degrade based on access |
| 9 | 🤝 **Cross-Agent Learning** | Propagates only verified operational gotchas, facts, and decisions across agents |
| 10 | 🔄 **Anti-Duplicates** | Semantic deduplication by cosine similarity with intelligent merge |
| 11 | ⚡ **Anti-Contradictions** | Detects contradictory memories and supersedes the obsolete one |
| 12 | 📋 **Session Indexing** | Searches past conversations (30-day retention) |
| 13 | 🔒 **PII Scrubbing** | Automatic redaction of sensitive data before storage |
| 14 | 🔮 **Pattern Detection** | Detects recurring patterns and promotes them automatically |
| 15 | 🛡️ **Disaster Recovery** | Full backup/restore (DB + configs + hooks + workspaces) |
| 16 | ⭐ **Quality Scoring** | Evaluates memory quality and promotes only what deserves to persist |
| 17 | ⚙️ **Fact Extraction** | Regex + LLM pipelines capture both operational facts and nuanced learnings |
| 18 | 📦 **Context Packs** | Weekly project packs and bootstrap topic files for fast situational awareness |
| 19 | 📈 **Telemetry** | Query logs, injection metrics, and health monitoring built in |
| 20 | 🧵 **Supersede Chains** | Old memories can be replaced cleanly without losing history |
| 21 | 🌀 **Memory Distillation** | Consolidates raw logs into higher-signal memories over time |
| 22 | 🛡️ **Pre-Action Advisory** | Queries past mistakes before high-risk tool execution |
| 23 | 👤 **Agent Profiles** | Per-agent hook injection: boosts/filters memories by agent role |
| 24 | 🔀 **Cross-Agent Recall** | Cross-agent knowledge is retrieved on demand when local-first context is insufficient |
| 25 | 📊 **Metrics Dashboard** | CLI dashboard with top patterns, memory stats, and usage trends |
| 26 | 🔧 **Doctor & Auto-Fix** | Schema integrity check + automatic repair of detected issues |
| 27 | 👍 **Memory Feedback** | Mark memories as useful/useless/incorrect to refine quality |
| 28 | 🗺️ **Trajectory Recording** | Records problem→solution paths for future reference |
| 29 | 📝 **Learning Details** | Extended metadata extraction for learnings and gotchas |
| 30 | 🔄 **Lifecycle Management** | Automatic promotion/degradation of memories by age and usage |
| 31 | 📥 **Workspace Import** | Imports existing MEMORY.md files from all workspaces into the brain |
| 32 | 🧪 **Eval Dataset Generation** | Generates evaluation datasets from real memories for quality testing |
| 33 | 🏗️ **Session Snapshots** | Captures full agent state at session close for analysis |
| 34 | 🧹 **Low-Signal Cleanup** | Automatic cleanup of low-value, outdated, or redundant memories |
| 35 | 🔃 **Memory Reclassification** | Reclassifies memories with correct types and categories post-hoc |
| 36 | 🔄 **Auto-Promotion Pipeline** | Detects high-recurrence patterns and stages vetted rule suggestions for the canonical `agent-core` reference file; final writes are review-gated instead of fully automatic |
| 37 | 📊 **Hybrid Daily/Weekly Pipeline** | Current host runtime runs 15 daily steps, 2 Wednesday/Sunday steps, and 7 deeper Sunday-only maintenance steps |
| 38 | ⚡ **Near-Real-Time Live Capture** | Optional capture surface with telemetry support, but not part of the default host runtime baseline |
| 39 | 📡 **Live Capture Observability** | `doctor` and `metrics` expose live-capture volume, low-signal skips, duplicates, persistence failures, latency, and last success/error |
| 40 | 🧠 **Session Working Memory Layer** | Plugin-owned short-lived session state with relevance-gated injection |
| 41 | 🔁 **Handoff Promoter** | Promotes session snapshots into durable hot memories and finality-scored artifact ledger rows |
| 42 | 📎 **Artifact Ledger** | Tracks durable final artifacts with role/provenance/finality for recovery after session rotation |
| 43 | 🧭 **Semantic Recovery Preflight** | Router-assisted classifier detects continuation/context-loss intent beyond fixed regex phrases |
| 44 | 🧭 **Context Broker Runtime** | Classifies intent/runtime family and selects one evidence surface per turn |

## When to Use

✅ **USE when:**
- An agent needs to "remember" information from previous sessions
- You want to give additional context to an LLM about past actions
- You need semantic search by content
- You want to store important decisions with metadata

❌ **DON'T USE when:**
- Ephemeral information that doesn't need persistence
- Structured tabular data (use a regular DB)
- Simple cache (use Redis or in-memory)

## Runtime Ownership

BrainX V6 uses a split architecture:

- `BrainX skill` = long-term memory, CLI, cron, knowledge sync, doctor
- `brainx plugin` = primary runtime route inside OpenClaw; sole owner of `before_prompt_build` (prompt orchestration) as of 2026-05-29
- legacy hooks = review-gated compatibility surface, not the default runtime path
- `lossless-claw` = **absorbed as an internal BrainX capability** (no longer a separate plugin; `enabled:false` in openclaw.json). BrainX loads it in-process (`import lcmPlugin from "lossless-claw"` via node_modules symlink, kept external by esbuild) and calls `lcmPlugin.register()` through a shim (`src/lossless-bridge.ts`) that **structurally drops** its `before_prompt_build` (BrainX is the sole prompt orchestrator) and forwards capture + the `lcm_*` tools + the `lossless` command. Update-proof: not a text-patch. Use `lcm_*` only for exact wording of earlier turns in the SAME conversation; use BrainX recall for cross-session memory. Detail in `brainx.md` → "lossless-claw absorbido como feature interno" (marker `LOSSLESS_ABSORB_20260529`).

### Bootstrap Trust Model

Injected BrainX context is **advisory**. It is useful for recall, not for authority.

- Memory helps with hypotheses, prior decisions, recurring gotchas, and faster orientation.
- If memory conflicts with active code, runtime behavior, DB state, logs, tests, screenshots, or a direct user correction, **the live artifact wins**.
- Do not claim `listo`, revert code, or switch a business-flow conclusion based only on MEMORY/BrainX/summaries/ARCHITECTURE/CHANGELOG when you can inspect the real system.
- `learning` memories stay stored and searchable, but they are excluded from bootstrap auto-injection by default because they are the easiest class to overgeneralize.
- Cross-agent knowledge is still available through explicit `brainx search` / `brainx inject` fallback.

### Verification States

Each memory can carry a trust state used by retrieval:

- `verified` — highest trust
- `hypothesis` — tentative
- `changelog` — historical context only
- `obsolete` — excluded

`advisory` and retrieval now prefer `verified` memories and downgrade the rest accordingly.

### Production Validation Status

Real validation refreshed on **2026-05-26**:
- Plugin `brainx` enabled in `~/.openclaw/openclaw.json`
- Legacy hooks `brainx-auto-inject` + `brainx-live-capture` disabled in runtime config on this host
- Active physical database: `brainx`
- Runtime surfaces active globally: context broker, `wikiDigest`, `jitRecall`, `router_llm`, semantic recovery, `workingMemory`, `toolAdvisories`, and `captureToolFailures`
- Context broker policy: generic semantic/domain recall is suppressed before `jitRecall` for all runtime families unless the turn needs recovery, explicit/historical/procedural/project-state memory, or troubleshooting evidence; suppressed decisions are logged in `brainx_policy_decisions` with `intent_gate:%` reasons
- Artifact ledger v2: `artifact_role`, `provenance`, `finality_score`, `metadata`; `brainx_context_state` stores compact `agent + session_key` handoff state
- Scheduler active directly through OpenClaw cron: 4 direct BrainX/Memory jobs. BrainX operational work is consolidated into `BrainX Review Loop` and `BrainX Maintenance`; Memory consolidate/closeout remain adjacent jobs.
- Daily Core wrapper: 15 daily steps, 2 Wednesday/Sunday steps, 7 Sunday-only steps
- Runtime bridges still off: `bootstrapMode=off`, `captureOutboundMode=off`
- Codex/background scoring fallback: exact `NO_REPLY`/`HEARTBEAT_OK` does not clear selected-injection cache; typed `message_sent` is observed as scoring-only so delivery-mirror replies can close `recovery_preflight` telemetry without enabling broad live capture
- `brainx fix` now also demotes carried-stale consolidated rows plus stale low-provenance memories before they can pollute `hot/warm`, and can close stale runtime scoring rows with `runtime-scoring-backlog`
- `brainx doctor --full --json` remains the source of truth for runtime governance warnings/failures
- CLI tests and smoke suite passed locally
- Telemetry and database integrity remain available independently of whether runtime bridges are enabled

For `/home/clawd`, also treat these as canonical:

- `docs/RUNTIME_STATUS.md` for current human-readable runtime truth
- `config/surface-policy.json` for machine-readable active/manual/dormant/disabled policy

Current verification snapshot (2026-06-01):
- `brainx health`: OK
- `brainx doctor --json`: `42 passed`, `2 warnings`, `0 failures`
- `brainx doctor --full --json`: `58 passed`, `2 warnings`, `0 failures`
- Doctor warnings are `BrainX Wiki` (low-confidence ratio) and `Promotion suggestion drift`, both pre-existing and unrelated to recall; `Recall quality` is `ok` after the 2026-06-01 inject self-test / adaptive-baseline fix.
- Plugin tests: `138/138 pass`
- CLI skill tests: `46 pass`
- Runtime regression suite: `25/25 pass`
- `openclaw gateway call brainx.status`: confirms global plugin runtime and disabled bootstrap/outbound bridges

If this validation becomes stale, rerun `./brainx doctor --full --json` before assuming runtime is still healthy.

### How it works:

1. The skill stores and curates memories in PostgreSQL + pgvector
2. The plugin reads BrainX for working memory / JIT recall / advisories when enabled in `openclaw.json`; on `/home/clawd`, those surfaces are currently enabled globally
3. Agents use `brainx search`, `brainx inject`, and `brainx knowledge-locate` explicitly when they need durable context
4. Legacy hook-generated files remain available only for troubleshooting or controlled rollouts

### Before Changing BrainX

BrainX changes are runtime-sensitive. Do not patch from the visible symptom alone.

Preflight:
- Read the plugin runtime first when prompt-time behavior is involved: `~/.openclaw/extensions/brainx/src/bridge.ts`, plus `router.ts`, `config.ts`, and `runtime-deps.ts` when the change touches routing, policy, config, or dependency loading.
- Read the skill runtime dependencies before changing memory/state behavior: `~/.openclaw/skills/brainx/lib/working-memory.js`, `lib/db.js`, `lib/openai-rag.js`, `lib/advisory.js`, or `lib/brainx-phase2.js` as relevant.
- If the symptom involves scheduled memory, handoff, wiki, cleanup, or promotion behavior, inspect `/home/clawd/.openclaw/workspace/scripts/brainx-daily-core-wrapper.sh`, `docs/CRON.md`, and the specific script named by the Daily Core step.
- Confirm current host truth with `docs/RUNTIME_STATUS.md`, `config/surface-policy.json`, `brainx doctor --full --json`, and `HOME=/home/clawd openclaw gateway call brainx.status` before changing runtime assumptions.
- Cross-check prior incidents and patterns with `brainx search --query "<symptom or surface>"`, `brainx runtime-report`, `brainx router-quality`, `brainx recall-health`, or `brainx explain` as appropriate. Treat memories as leads, not authority.

Troubleshooting shortcuts:
- For deep health checks, run `brainx doctor --json` or `brainx doctor --full --json`; use `brainx health` only as a quick DB/pgvector smoke.
- If the issue is prompt-time runtime behavior or live memory injection, read `~/.openclaw/extensions/brainx/src/bridge.ts` first, then `~/.openclaw/skills/brainx/lib/working-memory.js` and `~/.openclaw/skills/brainx/lib/db.js`.
- If the issue is scheduled memory, promotion, wiki, cleanup, or stale recall, inspect the relevant Daily Core or Review Loop wrapper before changing thresholds or data.
- If memories look wrong, check guardrail output for quarantined memories, degraded memories, stale artifacts, recall noise, and weak handoffs before blaming embeddings or router prompts.
- When an external URL, document, sheet, or repo note becomes a stable source of truth, promote it to a durable `reference` memory or canonical knowledge doc instead of leaving it buried in chat history.

Regression gates:
- Runtime load path: `~/.openclaw/extensions/brainx/package.json` declares `runtimeExtensions: ["./dist/index.js"]`. Before claiming a plugin source change is live, verify whether OpenClaw is loading `index.ts` or `dist/index.js`; keep source, runtime bundle, and tests in sync or explicitly document why only one path changed.
- Config changes: keep `src/config.ts`, `openclaw.plugin.json`, `~/.openclaw/openclaw.json`, `config/surface-policy.json`, and `docs/CONFIG.md` aligned. Validate unknown-property behavior because the plugin schema uses `additionalProperties: false`.
- DB/schema changes: add an idempotent migration under `sql/migrations/`, update `docs/SCHEMA.md`, and extend `doctor`/`fix` checks when the invariant can drift. Avoid destructive hot changes; write rollback/restore notes before touching production data.
- Prompt-time behavior: preserve the current `before_prompt_build` budget in both source and runtime bundle, single-flight guard, router timeout fail-closed behavior, per-turn budget, ops-agent denylist, ACP quiet policy, active-scope filtering, and session-rotation recovery.
- Telemetry: changes to selection, scoring, policy, or delivery must leave `brainx_runtime_injections`, `brainx_policy_decisions`, `brainx_session_rotation_events`, `brainx explain`, `runtime-report`, `router-quality`, and `recall-health` meaningful; verify selected rows get scored or deliberately finalized.
- Privacy and user-facing safety: keep PII/secret scrubbing, sensitivity recalibration, recovery-preflight wording, and delivery sanitization intact. Never expose internal labels, runtime context, credentials, raw session envelopes, or restricted memories.
- Tests must include negative cases, not only happy paths: unrelated memories rejected, ops agents quiet, ACP generic recall suppressed, session rotation recovers only meaningful prompts, weak artifacts demoted, and cross-agent recall governed by the active config. If tag/verification gates are enabled, test them directly; if they are disabled on this host, test router/context-broker/scope guards instead.
- Documentation and ledgers: if behavior changes, update the relevant docs (`README.md`, `CHANGELOG.md`, `docs/RUNTIME_STATUS.md`, `docs/CRON.md`, `docs/TESTS.md`, `brainx.md`) and add an Event Ledger row for validated architecture/runtime changes.

Validation:
- For edited JS/TS/MJS files, run `node --check <file>` when the file type/runtime supports it.
- If the plugin changed, run `npm test` with workdir `/home/clawd/.openclaw/extensions/brainx`.
- If skill CLI/libs/scripts changed, run `npm test` and `npm run test:smoke` with workdir `/home/clawd/.openclaw/skills/brainx` when DB/env are available.
- If runtime behavior, OpenClaw config, Daily Core, recovery, policy, telemetry, or plugin bundle/load path changed, also run `/home/clawd/.openclaw/workspace/scripts/brainx-regression-suite.sh` and the relevant OpenClaw checks (`openclaw config validate --json`, health/status smoke, gateway `brainx.status`, journal loaded-line check, or cron wrapper dry-run where available).
- If a runtime change requires gateway reload, restart only after tests/config validation, then confirm `openclaw health --json`, `openclaw tasks audit --json`, and a targeted smoke that exercises the changed surface without delivering public noise.
- If the work fixes an OpenClaw/runtime/tool/integration incident, record it in BrainX bugs with exact date, OpenClaw version, files changed, validation, status, and rollback/workaround.

### Canonical layout:

- Stable guide: `~/.openclaw/skills/brainx/brainx.md`
- Runtime context: plugin-owned working memory + recall inside OpenClaw
- Durable manual knowledge: `~/.openclaw/skills/brainx/knowledge/`
- Source of truth doc: `docs/CANONICAL_LAYOUT.md`

### Configuration:

In `~/.openclaw/openclaw.json`:
```json
{
  "plugins": {
    "entries": {
      "brainx": {
        "enabled": true,
        "config": {
          "wikiDigest": true,
          "jitRecall": true,
          "workingMemory": true,
          "toolAdvisories": true,
          "captureToolFailures": true,
          "writeFailuresToDailyMemory": true,
          "writeFailuresToBrainx": true,
          "bootstrapMode": "off",
          "captureOutboundMode": "off"
        }
      }
    }
  }
}
```

### Per-agent setup:

Add to `AGENTS.md` in each workspace:
```markdown
## Every Session

1. Read `SOUL.md`
2. Read `USER.md`
3. Read `~/.openclaw/skills/brainx/brainx.md`
4. Use `brainx search` / `brainx inject` on demand
5. Read legacy `BRAINX_CONTEXT.md` or `brainx-topics/*.md` only for troubleshooting
```

## Available Tools

### brainx_add_memory

Saves a memory to the vector brain.

**Parameters:**
- `content` (required) — Memory text
- `type` (optional) — Type: note, decision, action, learning (default: note)
- `context` (optional) — Namespace/scope
- `tier` (optional) — Priority: hot, warm, cold, archive (default: warm)
- `importance` (optional) — Importance 1-10 (default: 5)
- `tags` (optional) — Comma-separated tags
- `agent` (optional) — Name of the agent creating the memory

**Example:**
```
brainx add --type decision --content "Use embeddings 3-small to reduce costs" --tier hot --importance 9 --tags config,openai
```

### brainx_search

Searches memories by semantic similarity.

**Parameters:**
- `query` (required) — Search text
- `limit` (optional) — Number of results (default: 10)
- `minSimilarity` (optional) — Threshold 0-1 (default: 0.3)
- `minImportance` (optional) — Filter by importance 0-10
- `tier` (optional) — Filter by tier
- `context` (optional) — Exact context filter

**Example:**
```
brainx search --query "API configuration" --limit 5 --minSimilarity 0.5
```

**Returns:** JSON with results.

### brainx_inject

Gets memories formatted for direct injection into LLM prompts.

**Parameters:**
- `query` (required) — Search text
- `limit` (optional) — Number of results (default: 10)
- `minImportance` (optional) — Filter by importance
- `tier` (optional) — Tier filter (default: hot+warm)
- `context` (optional) — Context filter
- `maxCharsPerItem` (optional) — Truncate content (default: 2000)

**Example:**
```
brainx inject --query "what decisions were made about openai" --limit 3
```

**Returns:** Formatted text ready for injection:
```
[sim:0.82 imp:9 tier:hot type:decision agent:coder ctx:openclaw]
Use embeddings 3-small to reduce costs...

---

[sim:0.71 imp:8 tier:hot type:decision agent:support ctx:brainx]
Create SKILL.md for OpenClaw integration...
```

### brainx_health

Verifies BrainX is operational.

**Parameters:** none

**Example:**
```
brainx health
```

**Returns:** PostgreSQL + pgvector connection status.

## Backup and Recovery

### Create Backup

```bash
./scripts/backup-brainx.sh ~/backups
```

Creates `brainx_backup_YYYYMMDD_HHMMSS.tar.gz` containing:
- Full PostgreSQL database (SQL dump)
- OpenClaw configuration (hooks, .env)
- Skill files
- Workspace documentation

### Restore Backup

```bash
./scripts/restore-brainx.sh backup.tar.gz --force
```

Fully restores BrainX V5 including:
- All memories (with embeddings)
- Hook configuration
- Environment variables

### Full Documentation

See [RESILIENCE.md](RESILIENCE.md) for:
- Complete disaster scenarios
- Migration to new VPS
- Troubleshooting
- Automatic backup configuration

## Configuration

### Environment Variables

```bash
# Required
DATABASE_URL=postgresql://user:pass@host:5432/brainx
OPENAI_API_KEY=sk-...

# Optional
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_EMBEDDING_DIMENSIONS=1536
BRAINX_INJECT_DEFAULT_TIER=hot+warm
BRAINX_INJECT_MAX_CHARS_PER_ITEM=2000
BRAINX_INJECT_MAX_LINES_PER_ITEM=80
```

### Database Setup

```bash
# Schema is in ~/.openclaw/skills/brainx/sql/
# Requires PostgreSQL with pgvector extension

psql $DATABASE_URL -f ~/.openclaw/skills/brainx/sql/v3-schema.sql
```

## Direct Integration

You can also use the unified wrapper that reads the API key from OpenClaw:

```bash
cd ~/.openclaw/skills/brainx
./brainx add --type note --content "test"
./brainx search --query "test"
./brainx inject --query "test"
./brainx health
```

Compatibility: `./brainx` and `./brainx-cli` also work as aliases for the main wrapper.

## Advisory System (Pre-Action Check)

BrainX includes an advisory system that queries relevant memories, trajectories, and recurring patterns before executing high-risk tools. Helps agents avoid repeating past mistakes.

On `/home/clawd`, `toolAdvisories=true` in the plugin runtime. It is still silent-by-default: only whitelisted high-risk tools trigger advisory lookup, and blocking approval is controlled by `advisoryRequireApproval`.

### High-Risk Tools

These are the intended advisory scope when the advisory surface is enabled or invoked manually: `exec`, `deploy`, `railway`, `delete`, `rm`, `drop`, `git push`, `git force-push`, `migration`, `cron`, `message send`, `email send`.

### CLI Usage

```bash
# Check for advisories before a tool execution
./brainx advisory --tool exec --args '{"command":"rm -rf /tmp/old"}' --agent coder --json

# Quick check via helper script
./scripts/advisory-check.sh exec '{"command":"rm -rf /tmp/old"}' coder
```

### Agent Integration

The plugin now listens to `before_tool_call` for whitelisted high-risk tools when `toolAdvisories=true`. Manual CLI checks remain useful for audits, scripts, or environments where the plugin runtime is not active:

```bash
# In agent SKILL.md or AGENTS.md, add:
# Before exec/deploy/delete/migration, run:
cd ~/.openclaw/skills/brainx && ./scripts/advisory-check.sh <tool> '<args_json>' <agent>
```

The advisory returns relevant memories, similar past problem→solution paths, and recurring patterns with a confidence score. In the current `/home/clawd` config it is informational unless `advisoryRequireApproval` is enabled.

### Legacy Agent-Aware Hook Injection

The legacy `agent:bootstrap` hook can use **agent profiles** (`hook/agent-profiles.json`) to customize memory injection per agent during controlled rollouts:

- **Execution agents** (`coder`, CLI agents, `raider`, `reasoning`): narrow bootstrap to code/ops-adjacent contexts and prioritize gotcha/error/decision
- **Content agents** (`writer`, `researcher`, `clawma`, `karl`, `matrix`, etc.): prioritize fact/decision in content contexts
- **Monitoring/support agents**: prioritize health/monitoring/operations errors and gotchas
- **Default bootstrap policy**: exclude `learning` from auto-injection unless a profile opts in later for a proven reason

Agents not listed in the profiles file get the default unfiltered injection when that legacy hook is enabled. On `/home/clawd`, plugin runtime is the default route and the legacy hook is disabled.

### Cross-Agent Memory Sharing

The hook now follows a **local-first bootstrap** policy for all agents. Cross-agent memories stay available, but they are retrieved through explicit `brainx search` / `brainx inject` fallback when local context is insufficient. The `cross-agent-learning.js` script still tags high-importance memories so that fallback recall can surface them without duplicates.

## Skill Load Tracking (Spec 2 — Background Review / Skill Load)

BrainX records every skill the plugin bridge surfaces into a prompt build, plus the outcome the host agent eventually reports. This closes two gaps from the Hermes background-review comparison:

1. **Gap 1 — "skill in play" was never recorded.** The `BrainxBridge.handleBeforePromptBuild` hook now detects catalog skill names (from `~/.openclaw/skills/`) in the prompt + system context and writes a row to `brainx_skill_loads` with `source='injection'`. Tracking is fire-and-forget, capped at 10 inserts per turn, and never blocks the prompt pipeline.
2. **Gap 3 — no feedback loop for skills that turned out wrong.** The host agent (or operator) can stamp an outcome on the most recent load via `brainx skill-feedback <skill-name> <helpful|wrong|ignored> [--session <key>]`. The skill-promoter can then prefer patching skills with `outcome IN ('wrong', 'ignored')` over skills with `outcome='helpful'`.

### Tables and modules

| File | Purpose |
|---|---|
| `sql/migrations/018_brainx_skill_loads.sql` | New table `brainx_skill_loads` (id, session_key, skill_name, loaded_at, turn_index, source) + index on `(session_key, loaded_at DESC)`. |
| `sql/migrations/019_brainx_skill_loads_outcome.sql` | Adds `outcome VARCHAR(20) CHECK (outcome IN ('helpful','wrong','ignored'))`. |
| `lib/skill-tracker.js` | `trackSkillLoad`, `trackSkillLoadAsync`, `recordOutcome`, `getRecentLoads`, `getSkillStats`, `flushPending`. Fire-and-forget inserts (same pattern as `lib/cost-tracker.js`). |
| `lib/skill-promoter.js` | Heuristic bonus-score helpers: `getSkillBonusScore(skillName)` (0..1 ratio of helpful vs total reported), `getTopSkills(limit=5)` (last 30d, helpful ratio, minimum sample size), `getSkillsToPatch(opts)` (skills with `outcome IN ('wrong','ignored')` in the last 7d). Read-only, no LLM cost, no side effects on ranking. |
| `extensions/brainx/src/bridge.ts` | `detectAndTrackSkillLoads()` helper called at the top of `handleBeforePromptBuild` with `source='injection'`. Errors here are silent and never delay the prompt. |
| `extensions/brainx/src/runtime-deps.ts` | `getSkillTracker()` / `getSkillPromoter()` lazy loaders that fall back to a warning if the modules are missing. |

### CLI surface

```
brainx skill-feedback <skill-name> <helpful|wrong|ignored> [--session <session_key>] [--json]
    Report outcome for the most recent load of <skill-name> in the current (or --session) session.
    Looks up the latest brainx_skill_loads row for that skill and stamps its outcome column.

brainx skill-stats <skill-name> [--json]
    Outcome stats for a single skill: total loads, helpful / wrong / ignored counts, reported total.
```

The CLI lookup is forgiving: if no unrated row exists for the skill, it falls back to the most recent row (so an operator can override the latest record). When nothing matches it returns exit code 1 with a clear message — the bridge must record a load first.

### Cron `review-loop` interval

`openclaw.json` has a generic `cron` block (`maxConcurrentRuns`, `sessionRetention`, `runLog`) but no per-job `review-loop` interval knob. The Spec 2 gap #2 action item ("lower frequency to 10–15 min if currently ≥1h") requires a dedicated config field that doesn't exist in this host's openclaw.json. Documented here as N/A — the change is gated on a future config-schema addition.

## Security & Trust

This skill is flagged with "suspicious patterns" by ClawHub's automated scanner. Here's what each pattern does and why it's necessary:

| Pattern | File | Why |
|---|---|---|
| `child_process.execFile` | `hook/handler.js` | Invokes the BrainX CLI to query memories during agent bootstrap. No arbitrary command execution. |
| `process.env` access | `lib/db.js`, `lib/openai-rag.js`, `lib/cli.js` | Reads `DATABASE_URL` and `OPENAI_API_KEY` to connect to PostgreSQL and generate embeddings. Standard for any database-backed skill. |
| `fetch('https://api.openai.com')` | `lib/openai-rag.js` | Calls OpenAI Embeddings API to generate vector representations. Single endpoint, no other network calls. |
| File read/write | `hook/handler.js` | Legacy compatibility path that can write `BRAINX_CONTEXT.md`, `brainx-topics/*.md`, and update `MEMORY.md` during controlled bootstrap rollouts. |

**No secrets are stored in code.** All credentials come from environment variables. No data leaves the system except embedding requests to OpenAI.

## Notes

- Memories are stored with vector embeddings (1536 dimensions)
- Search uses cosine similarity
- `inject` is the most useful tool for giving context to LLMs
- Tier hot = fast access, cold/archive = long-term storage
- Memories are persistent in PostgreSQL (independent of OpenClaw)
- Plugin runtime is the default route on this host; legacy auto-injection hook is not the default runtime path

## Feature Status (Tables)

### Schema Presence and Runtime Caveat

These tables existing in the DB does not imply every surface is active on this host. Use `docs/RUNTIME_STATUS.md` and `config/surface-policy.json` for live operational truth.

| Table | Function | Status |
|---|---|---|
| `brainx_memories` | Core: stores memories with embeddings | ✅ Active (4,800+) |
| `brainx_advisories` | Pre-action advisory history | ✅ Active runtime surface |
| `brainx_distillation_log` | Distillation run audit log | ✅ Active |
| `brainx_eidos_cycles` | Prediction/evaluation/distillation loop | Present; dormant on this host |
| `brainx_query_log` | Tracks search/inject queries | ✅ Active |
| `brainx_pilot_log` | Tracks auto-inject per agent | ✅ Active |
| `brainx_context_packs` | Pre-generated context packages | Maintenance artifact; not active runtime retrieval |
| `brainx_patterns` | Detects recurring errors/issues | ✅ Active |
| `brainx_schema_version` | Schema version tracking | ✅ Active |
| `brainx_session_snapshots` | Captures state at session close | Present; manual/off |
| `brainx_artifact_ledger` | Typed artifact recovery ledger | ✅ Active runtime surface |
| `brainx_context_state` | Compact latest state by agent + session_key | ✅ Active runtime surface |
| `brainx_learning_details` | Extended metadata for learning/gotcha memories | Present; dormant/off |
| `brainx_trajectories` | Records problem→solution paths | Present; dormant/off |

> Schema presence is healthy; runtime activeness depends on the current host baseline and scheduler policy.

## Full CLI/Script Inventory

### CLI Core (`brainx <cmd>`)
| # | Command | Function |
|---|---|---|
| 1 | `add` | Save memory (7 types, 20+ categories, V5 metadata) |
| 2 | `search` | Semantic search by cosine similarity |
| 3 | `inject` | Formatted memories for LLM prompt injection |
| 4 | `fact` / `facts` | Shortcut to save/list infrastructure facts |
| 5 | `resolve` | Mark pattern as resolved/promoted/wont_fix |
| 6 | `promote-candidates` | Detect memories eligible for promotion |
| 7 | `lifecycle-run` | Degrade/promote memories by age/usage |
| 8 | `metrics` | Metrics dashboard and top patterns |
| 9 | `doctor` | Base diagnostics plus `doctor --full` for command surface and functional probes |
| 10 | `fix` | Auto-repair issues detected by doctor |
| 11 | `feedback` | Mark memory as useful/useless/incorrect |
| 12 | `health` | PostgreSQL + pgvector connection status |
| 13 | `recall-health` | Read-only recall quality warnings across runtime and query-log surfaces |
| 14 | `skill-feedback` | Stamp `outcome` (`helpful` / `wrong` / `ignored`) on the most recent `brainx_skill_loads` row for a skill. Closes Spec 2 gap #3 (skills that turned out wrong/missing). |
| 15 | `skill-stats` | Outcome stats for a single skill: total loads, helpful / wrong / ignored counts, reported total. |

### Processing Scripts (`scripts/`)
| # | Script | Function |
|---|---|---|
| 13 | `memory-bridge.js` | Syncs memory between sessions/agents |
| 14 | `memory-distiller.js` | Distills sessions into new memories |
| 15 | `session-harvester.js` | Harvests info from past sessions |
| 16 | `session-snapshot.js` | Captures state at session close |
| 17 | `pattern-detector.js` | Detects recurring errors/issues |
| 18 | `learning-detail-extractor.js` | Extracts metadata from learnings/gotchas |
| 19 | `trajectory-recorder.js` | Records problem→solution paths |
| 20 | `fact-extractor.js` | Extracts facts from conversations |
| 21 | `contradiction-detector.js` | Detects contradicting memories |
| 22 | `cross-agent-learning.js` | Shares verified operational knowledge between agents |
| 23 | `quality-scorer.js` | Scores memory quality |
| 24 | `context-pack-builder.js` | Generates pre-built context packages |
| 25 | `reclassify-memories.js` | Reclassifies memories with correct types/categories |
| 26 | `cleanup-low-signal.js` | Cleans up low-value memories |
| 27 | `dedup-supersede.js` | Detects and marks duplicates |
| 28 | `eval-memory-quality.js` | Evaluates dataset quality |
| 29 | `generate-eval-dataset-from-memories.js` | Generates evaluation dataset |
| 30 | `memory-feedback.js` | Per-memory feedback system |
| 31 | `import-workspace-memory-md.js` | Imports from workspace MEMORY.md files |
| 32 | `import-knowledge-md.js` | Imports curated `knowledge/` docs as canonical knowledge |
| 33 | `knowledge-sync.js` | Detects manual changes in `knowledge/`, imports only when needed, and refreshes the auto block |
| 34 | `new-knowledge-topic.js` | Creates canonical knowledge topic files with manual + auto blocks |
| 35 | `sync-knowledge-auto-blocks.js` | Refreshes the auto-managed BrainX block inside knowledge docs |
| 36 | `seed-knowledge-library.js` | Creates realistic seed topics across the knowledge taxonomy |
| 37 | `migrate-v2-to-v3.js` | Schema migration V2→V3 |
| 38 | `promotion-applier.js` | Last-mile gated promotion: distills vetted patterns and writes rules to the canonical `agent-core` reference file |
| 39 | `calibrate-verification-state.js` | Conservatively promotes durable changelog memories to verified |
| 40 | `cleanup-promotion-suggestions.js` | Purges stale, duplicate, or low-signal promotion suggestions |
| 41 | `self-learning-audit.js` | Read-only autonomy report across injection uptake, stale memories, repeated failures, gaps, and low-recall query signals |

### Hooks and Infrastructure
| # | Component | Function |
|---|---|---|
| 42 | `brainx-auto-inject` | Legacy bootstrap hook kept only for compatibility / controlled rollouts |
| 43 | `backup-brainx.sh` | Full backup (DB + config + skills) |
| 44 | `restore-brainx.sh` | Full restore from backup |
| 45 | `promotion-applier.js` | Last-mile gated promotion script that writes promoted patterns to the canonical `agent-core` reference file behind review |

### V5 Metadata
- `sourceKind` — Origin: user_explicit, agent_inference, tool_verified, llm_distilled, knowledge_canonical, etc.
- `sourcePath` — Source file/URL
- `confidence` — Score 0-1
- `expiresAt` — Automatic expiration
- `sensitivity` — normal/sensitive/restricted
- Automatic PII scrubbing (`BRAINX_PII_SCRUB_ENABLED`)
- Similarity-based dedup (`BRAINX_DEDUPE_SIM_THRESHOLD`)
