# 🧠 BrainX

![BrainX Banner](assets/brainx-banner.png)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![OpenClaw Compatible](https://img.shields.io/badge/OpenClaw-Compatible-blue.svg)](https://openclaw.ai)
[![Version](https://img.shields.io/badge/version-0.4.0-green.svg)](https://github.com/Mdx2025/brainx)

BrainX is a **persistent memory and vector database system** for AI agents, built on PostgreSQL + pgvector + OpenAI embeddings. On this host, the canonical name is simply **BrainX**, with the historical `brainx` skill/CLI and the `brainx` OpenClaw plugin as the active implementation. It gives every OpenClaw agent the ability to remember, learn, and share knowledge across sessions — delivering true **AI agent memory**, **cross-agent learning**, and **semantic search** at production scale.

The current split is explicit:

- `BrainX skill` = long-term memory, CLI, database library, doctor, knowledge sync, backups, and maintenance
- `brainx plugin` = prompt-time context broker, session working memory, runtime recall, recovery, scoring telemetry, and guardrails
- `LLM` = reasoning engine

> **Production-tested · 41 agent profiles · plugin-owned runtime · 4 direct BrainX crons · Version 0.4.0**

## Bootstrap Trust Model

BrainX is a memory system, not an oracle. Bootstrap injection is **advisory context**.

- Use injected memories to recover context, prior decisions, and recurring gotchas faster.
- If a memory conflicts with active code, runtime behavior, DB state, logs, tests, screenshots, or a direct user correction, **live evidence wins**.
- Do not close contradictions, revert business logic, or claim a fix is done from MEMORY/BrainX/summaries alone when the real artifact is available.
- `learning` memories remain stored, searchable, and usable on demand, but they are excluded from bootstrap auto-injection by default because they drift more easily than facts, decisions, errors, and gotchas.
- Cross-agent knowledge still exists; the intended path is explicit fallback recall with `brainx search` / `brainx inject` when local context is insufficient.
- Direct script execution now forces BrainX's local `.env` to override inherited shell env so maintenance jobs hit the correct physical database.

## Verification States

BrainX now tracks a retrieval trust state per memory:

- `verified` — safe to influence decisions when still relevant
- `hypothesis` — plausible but not strong enough to outrank live evidence
- `changelog` — historical/reporting context, not authority
- `obsolete` — excluded from retrieval

Retrieval and advisory now heavily prefer `verified`, penalize `hypothesis` and `changelog`, and exclude `obsolete`.

| # | Feature | Description |
|---|---------|-------------|
| 1 | ✅ **Production** | Active with centralized shared memory across all agents |
| 2 | 🧠 **Auto-Learning** | Captures and curates memory automatically from conversations, with review gates where durable rule writes would be risky |
| 3 | 💾 **Persistent Memory** | Remembers across sessions — PostgreSQL + pgvector vector database |
| 4 | 🤝 **Shared Memory** | All agents share the same knowledge management pool |
| 5 | 💉 **Runtime Briefing** | Plugin-governed recall and session context, enabled conservatively per runtime policy |
| 6 | 🔎 **Semantic Search** | Searches by meaning, not exact keywords — pgvector cosine similarity |
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
| 22 | 🛡️ **Pre-Action Advisory** | Queries past mistakes before high-risk tool execution (exec, deploy, delete) |
| 23 | 👤 **Agent Profiles** | Per-agent retrieval biasing and filtering, whether runtime uses plugin or controlled legacy hooks |
| 24 | 🔀 **Cross-Agent Recall** | Cross-agent knowledge is retrieved on demand when local-first context is insufficient |
| 25 | 📊 **Metrics Dashboard** | CLI dashboard with top patterns, memory stats, and usage trends |
| 26 | 🔧 **Doctor & Auto-Fix** | Schema integrity check + automatic repair of detected issues (`doctor --full` validates command surface, functional probes, live hook deployment, and live-capture telemetry too) |
| 27 | 👍 **Memory Feedback** | Mark memories as useful/useless/incorrect to refine quality |
| 28 | 🗺️ **Trajectory Recording** | Records problem→solution paths for future reference |
| 29 | 📝 **Learning Details** | Extended metadata extraction for learnings and gotchas |
| 30 | 🔄 **Lifecycle Management** | Automatic promotion/degradation of memories by age and usage |
| 31 | 📥 **Workspace Import** | Imports existing MEMORY.md files from all workspaces into the brain |
| 32 | 🧪 **Eval Dataset Generation** | Generates evaluation datasets from real memories for quality testing |
| 33 | 🏗️ **Session Snapshots** | Captures full agent state at session close for analysis |
| 34 | 🧹 **Low-Signal Cleanup** | Automatic cleanup of low-value, outdated, or redundant memories |
| 35 | 🔃 **Memory Reclassification** | Reclassifies memories with correct types and categories post-hoc |
| 36 | 🔄 **Auto-Promotion Pipeline** | Detects high-recurrence patterns and stages vetted rule suggestions for a canonical `agent-core` reference file; final writes are review-gated instead of fully automatic. |
| 37 | 📊 **Hybrid Daily/Weekly Pipeline** | Current runtime runs 14 daily steps, 2 Wednesday/Sunday steps, and 8 Sunday-only maintenance steps. |
| 38 | ⚡ **Near-Real-Time Live Capture** | Optional runtime capture path for high-signal outbound recommendations at `message:sent`, meant for controlled enablement rather than always-on global use. |
| 39 | 📡 **Live Capture Observability** | `doctor` and `metrics` expose live-capture volume, low-signal skips, duplicates, persistence failures, latency, and last success/error. |
| 40 | 🧠 **Session Working Memory Layer** | The `brainx` plugin maintains short-lived session state and injects it before historical recall, with optional MiniMax-based summarization. |
| 41 | 🔁 **Handoff Promoter** | Converts high-signal session snapshots into durable hot memories and finality-scored artifact ledger rows. |
| 42 | 📎 **Artifact Ledger** | Stores durable final artifact paths with role/provenance/finality so rotated sessions can recover deliverables without relying only on transcript context. |
| 43 | 🧭 **Semantic Recovery Preflight** | Uses router-assisted intent classification to detect continuation/context-loss requests beyond fixed regex phrases. |
| 44 | 🧭 **Context Broker Runtime** | Classifies turn intent/runtime family, selects one context surface, and keeps ACP recall quiet unless evidence is needed. |
| 45 | 🧾 **Event Ledger** | Deterministic forensic index for fixes, incidents, decisions, deployments, handoffs, and audits. |
| 46 | 🔍 **Runtime Explainability** | `runtime-report` exposes hard/soft signal ratios and `explain` inspects individual runtime injection decisions. |

> **Name:** The canonical product/runtime name on this host is **BrainX**. The repo/CLI command remains `brainx`, and the runtime ownership stays in the `brainx` plugin with trust-gated retrieval, plugin-owned governance, stale-memory safety filters, and the optimized daily/weekly pipeline.

> **Inventory vs runtime:** The feature table above is a capability inventory, not a claim that every surface is active on this host. For the `/home/clawd` production reality, use [`docs/RUNTIME_STATUS.md`](docs/RUNTIME_STATUS.md) plus the machine-readable [`config/surface-policy.json`](config/surface-policy.json).

---

## Status

### Validation Surface — 2026-05-26

BrainX currently exposes:

- **44 fast doctor checks currently passing**
- **59 full doctor checks currently passing**
- **0 current doctor failures** on the fast validation path
- **Plugin-owned runtime path** — the `brainx` plugin is the intended runtime surface inside OpenClaw
- **Legacy hooks review-gated** — `brainx-auto-inject` and `brainx-live-capture` can still exist on disk, but should not be treated as the default route on this host
- **Active plugin runtime surfaces** — `wikiDigest`, `jitRecall`, `router_llm`, `workingMemory`, `toolAdvisories`, semantic recovery, and `captureToolFailures` are enabled globally on `/home/clawd`
- **Disabled bridge surfaces** — `bootstrapMode=off` and `captureOutboundMode=off`; legacy bootstrap/outbound capture files remain troubleshooting or controlled-rollout artifacts
- **Skill remains authoritative backend** — cron, doctor, knowledge sync, lifecycle, and storage continue to run independently of runtime feature toggles
- **Runtime observability** — `brainx runtime-report` reports aggregate hard and soft signal ratios; `brainx explain` inspects individual injection decisions
- **Current live result (2026-06-01)** — `brainx doctor --json` = `42 passed / 2 warnings / 0 failures`; `brainx doctor --full --json` = `58 passed / 2 warnings / 0 failures`. The 2 warnings are `BrainX Wiki` (low-confidence ratio) and `Promotion suggestion drift`, both pre-existing and unrelated to recall; `Recall quality` is `ok` after the 2026-06-01 inject self-test / adaptive-baseline fix.

Current pass/fail state depends on the live dataset and environment. Run `./brainx doctor` for the fast baseline, or `./brainx doctor --full` for the full validation pass.

### Host Runtime Truth — 2026-05-26

For the `/home/clawd` host, the operational source of truth is [`docs/RUNTIME_STATUS.md`](docs/RUNTIME_STATUS.md), with [`config/surface-policy.json`](config/surface-policy.json) as the machine-readable companion used by `doctor`.

- canonical skill path is `~/.openclaw/skills/brainx`
- the `brainx` plugin keeps `wikiDigest=true`, `jitRecall=true`, `workingMemory=true`, `toolAdvisories=true`, and `captureToolFailures=true` as global runtime surfaces
- `bootstrapMode=off` and `captureOutboundMode=off`; do not treat legacy `BRAINX_CONTEXT.md`, `brainx-topics/`, or live-capture hook artifacts as the normal runtime path
- legacy hooks remain on disk for compatibility, but are disabled in `openclaw.json`
- the active scheduler has 4 direct BrainX OpenClaw jobs: 3 BrainX orchestrators plus 1 hourly canary
- BrainX cron wrappers execute from `~/.openclaw/skills/brainx/cron/`; OpenClaw `jobs.json` only schedules them
- the daily core wrapper runs 14 daily steps, 2 Wednesday/Sunday steps, and 8 Sunday-only steps
- BrainX operational work is consolidated into `BrainX Review Loop` and `BrainX Maintenance`; legacy BrainX jobs remain disabled rollback entries
- mixed `clawd` crontab wrappers add `observe-telemetry`, `backup-all-dbs`, and `brainx-cron-supervisor` as BrainX-adjacent jobs

## Post-Update Sync Checklist

After updating BrainX, validate runtime ownership before enabling new behavior:

1. Run `./brainx doctor --full` and review governance / hygiene warnings first
2. Confirm `openclaw.json` still points runtime ownership at the plugin, not at legacy hooks
3. If you intentionally change a runtime feature, change one surface at a time and smoke-test it
4. Confirm telemetry lands in the database when the feature is active
5. **If cron architecture changes again, update both code and docs together**
   - Update `lib/doctor.js`
   - Update this `README.md`
   - Update `docs/CLI.md` when CLI commands or output fields change
   - Update `scripts/MANIFEST.md` when script status/frequency changes
   - Update `hook/HOOK.md` only if legacy deployment guidance changes
   - Update `CRON.md` if production scheduler topology changed
6. For validated fixes/audits/incidents, create or update the relevant BrainX bugs entry and Event Ledger record

### Key files to keep in sync

When updating BrainX, ensure these stay aligned:
- Skill source files: `README.md`, `brainx.md`, `docs/CLI.md`, `lib/doctor.js`, `lib/live-capture-stats.js`, `lib/working-memory.js`, `lib/openai-rag.js`
- Runtime policy/status files: `config/surface-policy.json`, `docs/RUNTIME_STATUS.md`, `docs/CRON.md`, `scripts/MANIFEST.md`
- Plugin runtime files: `~/.openclaw/extensions/brainx/*`
- Managed hooks only if you are intentionally maintaining legacy compatibility
- Cron config: if you change the pipeline schedule or steps

---

## 🧠 Auto-Learning

> **BrainX doesn't just store memories — it learns continuously.** Auto-Learning is the integrated system that makes every agent improve with every conversation, while keeping review gates around high-impact writes.

Auto-Learning is NOT a single script. It is the **complete orchestration** of capture, curation, propagation, and injection that converts ephemeral conversations into governed, shared knowledge. It runs 24/7 via cron jobs, while permanent workspace-rule writes remain explicitly gated.

### Complete Auto-Learning Cycle

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    🧠 AUTO-LEARNING CYCLE                               │
│                                                                          │
│   ┌─────────────┐    ┌──────────────┐    ┌──────────────┐               │
│   │   Agent      │    │    Files     │    │   Agents     │               │
│   │  Sessions    │    │  memory/*.md │    │  (manual)    │               │
│   └──────┬──────┘    └──────┬───────┘    └──────┬───────┘               │
│          │                  │                    │                        │
│          ▼                  ▼                    ▼                        │
│   ┌─────────────────────────────────────────────────────┐               │
│   │         📥 AUTOMATIC CAPTURE (3 layers)              │               │
│   │                                                      │               │
│   │  Memory Distiller ──► LLM extracts memories          │               │
│   │  Fact Extractor   ──► Regex extracts hard data       │               │
│   │  Session Harvester ─► Heuristics classify            │               │
│   │  Memory Bridge    ──► Sync markdown → vector         │               │
│   └──────────────────────────┬──────────────────────────┘               │
│                              ▼                                           │
│                    ┌─────────────────┐                                   │
│                    │  PostgreSQL +   │                                   │
│                    │  pgvector       │                                   │
│                    │  (centralized   │                                   │
│                    │   memory)       │                                   │
│                    └────────┬────────┘                                   │
│                             │                                            │
│          ┌──────────────────┼──────────────────┐                        │
│          ▼                  ▼                   ▼                        │
│   ┌─────────────┐  ┌──────────────┐  ┌────────────────┐                │
│   │ 🔄 AUTO-    │  │ 🤝 CROSS-   │  │ 🔮 PATTERN    │                │
│   │ IMPROVEMENT │  │ AGENT       │  │ DETECTION     │                │
│   │             │  │ LEARNING    │  │               │                │
│   │ Quality     │  │             │  │ Recurrence    │                │
│   │ Scoring     │  │ Propagate   │  │ counting      │                │
│   │ Dedup       │  │ gotchas &   │  │ Pattern keys  │                │
│   │ Contradict. │  │ learnings   │  │ Auto-promote  │                │
│   │ Cleanup     │  │ to ALL      │  │ → workspace   │                │
│   │ Lifecycle   │  │ agents      │  │   rule files  │                │
│   └──────┬──────┘  └──────┬──────┘  └───────┬──────┘                │
│          │                │                  │                        │
│          └────────────────┼──────────────────┘                        │
│                           ▼                                            │
│                  ┌─────────────────┐                                   │
│                  │ 💉 RUNTIME      │                                   │
│                  │ CONTEXT         │                                   │
│                  │                 │                                   │
│                  │ Plugin JIT      │                                   │
│                  │ recall + WM +   │                                   │
│                  │ wiki digest     │                                   │
│                  │ Legacy hooks    │                                   │
│                  │ off by default  │                                   │
│                  └─────────────────┘                                   │
│                           │                                            │
│                           ▼                                            │
│                  ┌─────────────────┐                                   │
│                  │ 🤖 SMARTER     │                                   │
│                  │ AGENT           │                                   │
│                  │ each session    │                                   │
│                  └─────────────────┘                                   │
└──────────────────────────────────────────────────────────────────────────┘
```

**Result:** Every session of every agent feeds the memory → the memory self-optimizes → knowledge propagates → all agents are smarter in the next session. **Infinite improvement cycle.**

---

### 📥 Automatic Memory Capture

**What it does:** Converts high-signal agent activity and curated workspace notes into vector memories without manual DB work.

**Why it matters:** Without this, every session would be disposable. Agents would forget everything. With Auto-Learning, every conversation is a permanent learning opportunity.

BrainX captures memories through a consolidated daily/weekly pipeline plus optional/manual surfaces:

| Mechanism | How it works | What it captures | Current host cadence |
|-----------|--------------|-----------------|-----------|
| **Memory Distiller** (`scripts/memory-distiller.js`) | LLM reads recent session transcripts | Decisions, preferences, technical/personal/business context when high-signal | Daily pipeline step 2 |
| **Session Harvester** (`scripts/session-harvester.js`) | Heuristics and regex classify recent sessions | Conversation patterns, recurring topics, operational context | Daily pipeline step 3 |
| **Memory Bridge** (`scripts/memory-bridge.js`) | Syncs markdown files to vector database | Manual notes in `memory/*.md`, documentation, written decisions | Daily pipeline step 4 |
| **Cross-Agent Learning** (`scripts/cross-agent-learning.js`) | Shares verified high-importance knowledge across agent contexts | Operational facts, decisions, gotchas | Daily pipeline step 5 |
| **Context Packs** (`scripts/context-pack-builder.js`) | Builds compact context packs per project/context | Weekly-style situational summaries | Daily pipeline step 6 |
| **Fact Extractor** (`scripts/fact-extractor.js`) | Regex/LLM extraction of operational facts | URLs, services, repos, ports, branches, configs | Implemented; not part of the current daily wrapper |
| **Live Capture Hook** (`hook-live/handler.js`) | Legacy hook on successful `message:sent` | High-signal outbound recommendations | Disabled on this host; use controlled rollout only |

**Real example:** An agent discusses a deployment with the user. Without anyone doing anything:
- The **Session Harvester** or **Memory Distiller** captures the service URL, repo name, decision, and rationale if the turn has enough signal
- The **Memory Bridge** syncs the daily notes
- Everything is available for ANY agent in the next session

---

### 🤝 Cross-Agent Learning

**What it does:** When an agent discovers durable operational knowledge, BrainX can propagate the verified part of it to other agents.

**Why it matters:** Without this, each agent would be an island. The coder would discover a bug and the researcher would find it again. With cross-agent learning, knowledge flows between all agents.

**Script:** `scripts/cross-agent-learning.js`
**Frequency:** Daily (cron)

**How it works:**

1. Scans recent memories with strong importance and `verification_state = verified`
2. Restricts candidates to `gotcha`, `fact`, and `decision`
3. Identifies memories created by a specific agent
4. Replicates only those vetted memories in the context of other agents
5. Generates **weekly context packs** by project and by agent (`scripts/context-pack-builder.js`)

**Real example:**
```
Coder discovers: "CLI tool v4.29 requires --detach for background deploys"
    ↓ cross-agent-learning.js (daily cron)
    ↓
All other agents → receive this gotcha automatically
    ↓
No agent makes that mistake again
```

---

### 🔄 Auto-Improvement and Quality Curation

**What it does:** Memory self-optimizes — good memories rise, bad ones fall, duplicates are removed, contradictions are resolved.

**Why it matters:** Without automatic curation, memory would fill up with noise, duplicates, and obsolete information. Retrieval quality would degrade over time. With auto-improvement, memory becomes MORE accurate with each cycle.

The current host splits curation between active Sunday maintenance and manual tools:

| Script | What it does | Current host cadence |
|--------|-------------|-----------|
| `./brainx lifecycle-run` | Promotes/degrades by age, access, recurrence, and importance | Sunday wrapper |
| `scripts/memory-consolidator.js` | Consolidates mature same-scope memories safely | Sunday wrapper |
| `scripts/contradiction-detector.js` | Finds contradictions and supersedes obsolete rows | Sunday wrapper |
| `scripts/error-harvester.js` | Extracts command/runtime failures from session logs | Sunday wrapper |
| `scripts/auto-promoter.js` | Detects recurring patterns and stages suggestions | Sunday wrapper |
| `scripts/promotion-applier.js` | Distills pending promotions behind review gates | Sunday wrapper |
| `scripts/quality-scorer.js` | Evaluates individual memory quality | Manual/off in current wrapper |
| `scripts/dedup-supersede.js` | Exact duplicate superseding | Manual/off in current wrapper |
| `scripts/cleanup-low-signal.js` | Degrades/archives low-signal rows | Manual/off in current wrapper |

**Curation flow:**
```
New memory arrives
    ↓
Daily capture → Is it high-signal enough to store?
    ↓                                    ↓
  Yes → BrainX DB                   No → skip
    ↓
Sunday lifecycle / consolidation / contradiction checks
    ↓
Does it contradict something existing?
    ↓              ↓
  Yes → supersede   No → keep both
    ↓
Dedup → Duplicate?
    ↓              ↓
  Yes → merge       No → keep
    ↓
Lifecycle → hot/warm/cold based on usage
```

---

### 🔄 Auto-Promotion Pipeline

**What it does:** Detects high-recurrence patterns and prepares vetted promotion suggestions for sections of the canonical `agent-core` reference file. Final writes are review-gated.

**Why it matters:** Recurrent patterns should graduate into startup-visible rules, but only after low-signal narrative and duplicate suggestions are filtered out.

**Scripts:** `scripts/auto-promoter.js` → `scripts/promotion-applier.js`
**Frequency:** Sunday-only maintenance steps 11–12 in the consolidated wrapper

**How it works:**

1. `auto-promoter.js` scans `brainx_patterns` for entries with `recurrence_count ≥ threshold`
2. Classifies each pattern to its target section (`Workflow & Execution`, `Tools & Infrastructure`, or `Behavior & Tone`) based on content type
3. Saves suggestions as BrainX memories tagged `promotion-suggestion`
4. `promotion-applier.js` reads only pending, non-obsolete suggestions, distills them via LLM (gpt-4.1-mini), and writes final rules only when an explicit review gate is opened

**Result:**
```
Pattern: "Use plugin v2 for WordPress publishing" (×33)
    ↓ auto-promoter.js detects threshold exceeded
    ↓ saves promotion-suggestion memory
    ↓ promotion-applier.js distills via LLM
    ↓
`BRAINX_PROMOTED_RULES.md` / `Tools & Infrastructure` → "Usar siempre la versión v2 del plugin WordPress…" staged and then written with explicit approval
    ↓
Cada agente ve la ruta canónica desde `AGENTS.md` / `TOOLS.md` y puede recuperarla sin drift entre workspaces
```

---

### 💉 Intelligent Contextual Injection

**What it does:** When runtime recall is enabled, the plugin acts as a context broker. It classifies the turn, chooses one surface, and injects only the most relevant evidence for the current task.

**Why it matters:** There's no point having perfect memory if the agent doesn't receive it. Contextual injection is the bridge between "stored memories" and "informed agent." Without this, BrainX would be a database no one queries.

**Component:** `brainx` plugin + `lib/cli.js inject`
**Frequency:** Runtime prompt-time surface. On `/home/clawd`, `wikiDigest`, `jitRecall`, and `workingMemory` are enabled globally.

**How it works:**

1. The plugin evaluates the current prompt/session before the model run
2. It classifies turn intent: artifact request, continuity, context loss, historical/procedural query, troubleshooting, project/domain recall, or casual/control
3. It infers runtime family: ACP, Codex, embedded Kimi/MiniMax, or unknown
4. It chooses one surface:
   - `recovery_preflight` for artifacts, session continuity, and context-loss recovery
   - `jit_recall` for high-confidence historical/procedural/troubleshooting memory
   - `working_memory` for short session state when relevant
   - `wiki_digest` for compact compiled knowledge when prompt signals match
5. Trust, scope, prompt overlap, same-agent/cross-agent policy, artifact finality, and per-turn budget gates filter the final block
6. Legacy hook-generated files like `BRAINX_CONTEXT.md` are optional compatibility artifacts, not the primary runtime path

**Runtime selection shape:**
```
Prompt signal → turn intent/runtime family → one surface per turn budget
  1. recovery_preflight for artifact/sessionKey handoff
  2. jit_recall only when evidence is needed
  3. working_memory/wiki_digest as quieter fallback surfaces
```

ACP-specific rule: ACP agents usually preserve upstream context, so generic domain recall is suppressed unless the prompt asks for recovery, explicit/historical/procedural memory, or troubleshooting evidence.

---

### 🔮 Pattern Detection and Recurrence

**What it does:** Detects when something appears repeatedly in memories and automatically promotes it as an important pattern.

**Why it matters:** Recurring patterns are the most valuable memories — if something appears 5 times, it's probably critical. Automatic detection ensures these memories are never lost or degraded.

**Mechanism integrated in:** `lib/openai-rag.js`, `brainx_patterns`, `lifecycle-run`, and Sunday promotion maintenance (`auto-promoter` / `promotion-applier`).

**How it works:**

1. **Recurrence counting:** Each time a memory is accessed or a similar one is created, `recurrence_count` increments
2. **Pattern key:** Similar memories are grouped under a common `pattern_key` (semantic hash)
3. **Promotion candidate:** when recurrence and quality thresholds pass, BrainX stages promotion suggestions for review-gated application rather than writing permanent rules blindly.

**Example:**
```
Memory: "CLI tool requires --detach for deploys"
  → Appears in 3 different sessions from 3 agents
  → recurrence_count = 3
  → lifecycle / promoter can raise importance or create a promotion suggestion
  → Appears 2 more times
  → recurrence_count = 5
  → review-gated promotion can move the rule into canonical agent-core docs
```

---

### 📊 Hybrid Daily/Weekly Pipeline

BrainX now runs a hybrid pipeline: 14 daily steps every day, 2 additional steps on Wednesday and Sunday, plus 7 deeper maintenance steps only on Sundays.

**Pipeline name:** `BrainX Daily Core Pipeline V5`
**Frequency:** Daily (OpenClaw cron)

| Step | Script | Function |
|------|--------|----------|
| 1 | `bootstrap` | Create daily memory files across workspaces |
| 2 | `distiller` | Memory Distiller (LLM extraction from session transcripts) |
| 3 | `harvester` | Session Harvester (regex-based session capture) |
| 4 | `handoff-promoter` | Promote snapshot handoffs into durable hot memories and artifact ledger rows |
| 5 | `bridge` | Memory Bridge (markdown → vector sync) |
| 6 | `cross-agent` | Cross-agent learning propagation |
| 7 | `context-pack-builder` | Build context packs for fast situational recall |
| 8 | `error-harvester` | Capture recent command failures as gotchas |
| 9 | `reclassify-memories` | Keep categories and types current |
| 10 | `degrade-over-injected` | Demote over-injected unused memories |
| 11 | `self-learning-audit` | Read-only autonomy report for noisy/useful memories, stale rows, repeated failures, knowledge gaps, and low-recall query signals |
| 12 | `wiki-compile` | Refresh the BrainX vault and digest source |
| 13 | `runtime-regression-suite` | Validate runtime guardrails |
| 14 | `trajectory-recorder` | Extract problem→solution trajectories |

Wednesday + Sunday steps:

| Step | Script | Function |
|------|--------|----------|
| 15 | `lifecycle` | Lifecycle-run (promote/degrade by age and usage) |
| 16 | `contradiction` | Contradiction detection and supersede |

Sunday-only extra maintenance:

| Step | Script | Function |
|------|--------|----------|
| 17 | `consolidation` | Weekly semantic consolidation for mature same-scope memories |
| 18 | `auto-promoter` | Pattern promotion candidate detection |
| 19 | `promotion-applier` | Distill pending promotions in review-gated mode |
| 20 | `memory-enforcer` | Memory enforcement and integrity validation |
| 21 | `memory-audit` | Full audit and amnesia detection |
| 22 | `dedup-supersede` | Exact duplicate supersede |
| 23 | `cleanup-low-signal` | Degrade low-signal short memories |

---

### 📋 Summary: Auto-Learning Crons

All crons that feed the auto-learning cycle:

| Frequency | Scripts | Function |
|-----------|---------|----------|
| **Daily** | 14-step pipeline | Fast orchestration cycle for active memory flow |
| **Wednesday + Sunday** | lifecycle + contradiction | Midweek governance so stale/contradictory rows do not wait a full week |
| **Sunday** | 7 extra maintenance steps | Deep weekly cleanup and governance |
| **Every 7h** | BrainX Knowledge Sync wrapper | Sync canonical `knowledge/` docs and auto blocks |
| **Every 4h** | BrainX Session Snapshot + handoff-promoter | Capture session state and promote stable handoff facts/finality-scored artifacts |
| **Nightly memory** | BrainX Nightly Memory Loop | Cross-workspace daily consolidate + compact daily closeout |
| **Daily health** | BrainX Injection Health | Compact injection health report |
| **Runtime prompt-time** | `brainx` plugin | Context broker, semantic recovery, finality-ranked artifacts, JIT recall, working memory, wiki digest, tool advisories, tool-failure capture |
| **Disabled legacy hooks** | Auto-inject / live capture hooks | Compatibility and controlled rollout only |

> **Low-maintenance:** Once crons are set up, BrainX learns, self-optimizes, shares knowledge, and stages recurrent rules for review. Agents improve with minimal manual intervention.

---

## Script and Tool Summary Table

### Pipeline Scripts (`scripts/`)

| Script | Description | LLM | Cron |
|--------|-------------|-----|------|
| `memory-distiller.js` | 🧬 LLM-powered memory extractor from session transcripts | gpt-4.1-mini | Daily wrapper |
| `fact-extractor.js` | 📌 Regex extractor of operational facts (URLs, services, configs) | No | Manual/off in current wrapper |
| `session-harvester.js` | 🔍 Session harvester based on regex heuristics | No | Daily wrapper |
| `memory-bridge.js` | 🌉 Syncs `memory/*.md` files to vector brain | No | Daily wrapper |
| `cross-agent-learning.js` | 🤝 Propagates high-importance learnings between agents | No | Daily |
| `contradiction-detector.js` | ⚡ Detects contradictory memories and supersedes obsolete ones | No | Sunday wrapper |
| `quality-scorer.js` | ⭐ Evaluates memory quality (promote/degrade/archive) | No | Manual/off in current wrapper |
| `memory-consolidator.js` | 🧠 Weekly-safe semantic consolidation of mature same-scope memories | No | Weekly (guarded) |
| `context-pack-builder.js` | 📦 Generates context packs per agent/project | No | Daily wrapper |
| `cleanup-low-signal.js` | 🧹 Cleans low-value memories (short, low importance) | No | Manual/off in current wrapper |
| `dedup-supersede.js` | 🔗 Exact deduplication and superseding of identical memories | No | Manual/off in current wrapper |
| `error-harvester.js` | 🔍 Scans session logs for command failures, saves as gotchas | No | Sunday wrapper |
| `auto-promoter.js` | 📋 Detects high-recurrence patterns, suggests workspace promotions | No | Sunday wrapper |
| `promotion-applier.js` | 🔄 Reads pending pattern suggestions, distills via LLM, prepares a review-gated apply pass | gpt-4.1-mini | Sunday wrapper |
| `reclassify-memories.js` | 🏷️ Reclassifies existing memories to new categories | No | Manual |
| `eval-memory-quality.js` | 📊 Offline evaluation of retrieval quality | No | Manual |
| `generate-eval-dataset-from-memories.js` | 📋 Generates JSONL dataset for benchmarks | No | Manual |
| `import-workspace-memory-md.js` | 📥 Imports workspace MEMORY.md into vector brain | No | Manual |
| `import-knowledge-md.js` | 📚 Imports curated `knowledge/` docs into vector brain as canonical knowledge | No | Manual |
| `knowledge-sync.js` | 🔄 Detects manual changes in `knowledge/`, imports only when needed, then refreshes BrainX auto blocks | No | Manual / Cron |
| `new-knowledge-topic.js` | 🧱 Creates canonical knowledge topic files with manual + auto blocks | No | Manual |
| `sync-knowledge-auto-blocks.js` | 🔁 Refreshes only the BrainX auto block inside knowledge docs | No | Manual |
| `seed-knowledge-library.js` | 🌱 Creates realistic starter topics across the knowledge taxonomy | No | Manual |
| `migrate-v2-to-v3.js` | 🔄 Data migration from BrainX V2 | No | Once |
| `backup-brainx.sh` | 🛡️ Full backup (DB + configs + hooks) | No | Daily (recommended cron) |
| `restore-brainx.sh` | 🛡️ Full restore from backup | No | Manual |

### Cron Scripts (`cron/`)

| Script | Description | Frequency |
|--------|-------------|-----------|
| `health-check.sh` | BrainX health check + memory count | Every 30 min |
| `ops-alerts.sh` | Operational report with latency alerts and lifecycle | Daily |
| `weekly-dashboard.sh` | Weekly dashboard with metrics, trends, and distribution | Weekly |

### Core Modules (`lib/`)

| Module | Description |
|--------|-------------|
| `openai-rag.js` | Core RAG: OpenAI embeddings, store with semantic dedup, search with scoring, query logging |
| `brainx-phase2.js` | PII scrubbing (14 patterns), dedup config, tag merging, merge plan derivation |
| `live-capture-stats.js` | Shared telemetry parser/writer for near-real-time live-capture observability |
| `db.js` | PostgreSQL connection pool with transaction support |
| `cli.js` | Full CLI with all commands (health, add, fact, facts, search, inject, runtime-report, explain, event, resolve, etc.) |

---

## Architecture

BrainX operates in **3 feeding layers** working together:

```
┌─────────────────────────────────────────────────────────────┐
│                 LAYER 3: Agents (manual)                    │
│  Agents write directly with: brainx add / brainx fact       │
│  → Decisions, gotchas, notes during work                    │
└───────────────────────┬─────────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────────┐
│               LAYER 2: Memory Distiller (LLM)               │
│  scripts/memory-distiller.js — gpt-4.1-mini                 │
│  → Reads complete session transcripts                       │
│  → Extracts ALL types: personal, financial, preferences     │
│  → Understands context and language nuances                 │
│  → Automatic cron every 6h                                  │
└───────────────────────┬─────────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────────┐
│               LAYER 1: Fact Extractor (regex)               │
│  scripts/fact-extractor.js — no LLM                        │
│  → Extracts URLs (services, repos, deployments)                  │
│  → Detects services, repos, ports, branches                 │
│  → Fast, no API cost                                        │
│  → Complements the distiller for structured data            │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
              PostgreSQL + pgvector
              (centralized database)
                        │
                        ▼
              brainx plugin (runtime recall)
              → working memory + guarded recall in prompt assembly
```

### Data flow

```
Agent sessions ──→ Fact Extractor (regex)     ──→ PostgreSQL
               ──→ Memory Distiller (LLM)     ──→ PostgreSQL
               ──→ Session Harvester (regex)   ──→ PostgreSQL
               ──→ Memory Bridge (markdown)    ──→ PostgreSQL
               ──→ Live Capture Hook           ──→ PostgreSQL
               ──→ Agents write directly       ──→ PostgreSQL
                                                      │
                               ┌─────────────────────┤
                               │                     │
                               ▼                     ▼
                        Quality Scorer        brainx plugin
                        Contradiction Det.          │
                        Cross-Agent Learning        ▼
                        Dedup/Supersede       prompt-time runtime context
                        Cleanup Low-Signal    (working memory + verified recall)
                        Lifecycle-Run
                                Auto-Promoter
                                Promotion-Applier
```

Parallel to the batch/cron ingestion paths, live-capture telemetry can still exist for controlled rollouts. `doctor` and `metrics` read `~/.openclaw/logs/brainx-live-capture.log` to expose capture health, dedupe, failures, and latency whether the route is currently enabled or retained only for audit.

---

## Canonical Layout

BrainX uses a strict source-vs-runtime split.

- Stable guide: `~/.openclaw/skills/brainx/brainx.md`
- Manual canonical docs: `~/.openclaw/skills/brainx/knowledge/`
- Primary runtime output per agent: plugin-owned working memory + guarded recall inside prompt assembly
- Legacy runtime artifacts: `BRAINX_CONTEXT.md`, `brainx-topics/`, and the BrainX block inside `MEMORY.md`
- Persistent store: PostgreSQL `brainx`

Rules:

1. `brainx.md` is owned by the skill, not by workspaces.
2. `BRAINX_CONTEXT.md` and `brainx-topics/` are legacy workspace artifacts, generated only when the compatibility hook path is intentionally used.
3. `knowledge/` is the canonical manual documentary layer and is not replaced by runtime context artifacts.
4. If a workspace still contains a legacy `brainx.md`, treat it as compatibility residue, not as the source of truth.

See `docs/CANONICAL_LAYOUT.md` for the full ownership map, routes, bootstrap contract, backup/restore rules, and anti-drift rules.

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/Mdx2025/brainx.git
cd brainx

# 2. Install dependencies
pnpm install  # or npm install

# 3. Configure environment
cp .env.example .env
# Edit: DATABASE_URL, OPENAI_API_KEY

# 4. Database setup (requires PostgreSQL with pgvector)
psql "$DATABASE_URL" -f sql/v3-schema.sql

# 5. Verify
./brainx health
```

---

## Full CLI Reference

The CLI (`lib/cli.js`) provides all commands to interact with BrainX. The entry point is the bash script `brainx` (or the wrapper `brainx`).

### `health` — Check status

```bash
./brainx health
# BrainX health: OK
# - pgvector: yes
# - brainx tables: 9
```

### `add` — Add memory

```bash
./brainx add \
  --type decision \
  --content "Use text-embedding-3-small to reduce costs" \
  --context "project:openclaw" \
  --tier hot \
  --importance 9 \
  --tags config,openai \
  --agent coder
```

**Available flags:**

| Flag | Required | Description |
|------|----------|-------------|
| `--type` | ✅ | Memory type (see Types section) |
| `--content` | ✅ | Text content of the memory |
| `--context` | ❌ | Namespace: `agent:coder`, `project:my-project`, `personal:finances` |
| `--tier` | ❌ | `hot` \| `warm` \| `cold` \| `archive` (default: `warm`) |
| `--importance` | ❌ | 1-10 (default: 5) |
| `--tags` | ❌ | Comma-separated tags: `deploy,service,url` |
| `--agent` | ❌ | Name of the agent creating the memory |
| `--id` | ❌ | Custom ID (auto-generated if omitted) |
| `--status` | ❌ | `pending` \| `in_progress` \| `resolved` \| `promoted` \| `wont_fix` |
| `--category` | ❌ | Category (see Categories section) |
| `--patternKey` | ❌ | Recurring pattern key |
| `--recurrenceCount` | ❌ | Recurrence counter |
| `--resolutionNotes` | ❌ | Resolution notes |
| `--promotedTo` | ❌ | Promotion destination |

### `fact` — Shortcut for operational data

The `fact` type is a shortcut for `add --type fact --tier hot --category infrastructure`.

```bash
# Register a service URL
./brainx fact \
  --content "Frontend my-project: https://my-app-frontend.example.com" \
  --context "project:my-project" \
  --importance 8

# Register service config
./brainx fact \
  --content "Service 'my-api' → port 3001, branch main" \
  --context "project:my-project" \
  --importance 7 \
  --tags service,config
```

**What is a FACT?** Hard data that another agent would need to work without asking:
- Production/staging URLs
- Service ↔ repo ↔ directory mapping
- Key environment variables
- Project structure
- Main branch, deploy target
- Personal data, financial data, contacts

### `facts` — List stored facts

```bash
# All facts
./brainx facts

# Filter by context
./brainx facts --context "project:my-project"

# Limit results
./brainx facts --limit 5
```

### `runtime-report` — Audit runtime injection signal

Read-only report over `brainx_runtime_injections`. It reports strict hard
reference signal and softer contextual signal separately.

```bash
./brainx runtime-report --days 7
./brainx runtime-report --days 7 --json
```

Key fields:
- `hard_signal_ratio_pct` = `sum(referenced_count) / sum(selected_count)`
- `soft_signal_ratio_pct` = `sum(soft_referenced_count) / sum(selected_count)`
- per-agent and per-surface selected/hard/soft counts

### `explain` — Inspect one runtime injection decision

Read-only inspection for prompt-time BrainX decisions. Use it to debug what
surface fired, what router decision was recorded, what memories were selected,
and whether they were later hard/soft referenced.

```bash
./brainx explain --id <runtime_injection_id>
./brainx explain --session <session_id> --limit 3
./brainx explain --sessionKey <session_key> --limit 3 --json
./brainx explain --agent coder --limit 1
```

### `event` — Deterministic forensic ledger

For important fixes, incidents, audits, decisions, handoffs, and deployments,
use the Event Ledger alongside semantic memories. It answers "what happened,
when, where, with which evidence?" without relying only on semantic recall.

```bash
./brainx event add --type fix --project brainx --domain observability \
  --title "Runtime report corrected" \
  --summary "Corrected hard/soft signal metrics and validated tests"

./brainx event search --project brainx --domain observability --from 2026-05-01 --to 2026-05-02
./brainx event show --id evt_20260501_brainx_runtime_observability_explain_cli
```

### `feature` — Shortcut for feature requests

```bash
# Save a feature request
./brainx feature "Add webhook support for real-time notifications"

# With project context
./brainx feature --content "Dark mode for dashboard" --context "project:control-panel" --importance 8
```

Shortcut for: `add --type feature_request --tier warm --importance 6 --category feature_request`

### `features` — List stored feature requests

```bash
# All feature requests
./brainx features

# Filter by status
./brainx features --status pending

# Filter by context
./brainx features --context "project:my-project" --limit 10
```

### `search` — Semantic search

```bash
./brainx search \
  --query "deploy strategy" \
  --limit 10 \
  --minSimilarity 0.15 \
  --context "project:my-project" \
  --tier hot
```

**Score-based ranking:** Results are sorted by a composite score:
- **Cosine similarity** — main embedding weight
- **Importance** — `(importance / 10) × 0.25` bonus
- **Tier bonus** — `hot: +0.15`, `warm: +0.05`, `cold: -0.05`, `archive: -0.10`

**Access tracking:** Each returned result automatically updates `last_accessed` and `access_count`.

### `inject` — Get context ready for prompts

```bash
./brainx inject \
  --query "what did we decide about the deploy?" \
  --limit 8 \
  --minScore 0.25 \
  --maxTotalChars 12000
```

**Output format:**
```
[sim:0.82 imp:9 tier:hot type:decision agent:coder ctx:openclaw]
Use text-embedding-3-small to reduce costs...

---

[sim:0.41 imp:6 tier:warm type:note agent:writer ctx:project-x]
Another relevant memory...
```

**Injection limits:**

| Limit | Default | Env Override | Flag Override |
|-------|---------|--------------|---------------|
| Max chars per item | 2000 | `BRAINX_INJECT_MAX_CHARS_PER_ITEM` | `--maxCharsPerItem` |
| Max lines per item | 80 | `BRAINX_INJECT_MAX_LINES_PER_ITEM` | `--maxLinesPerItem` |
| Max chars total output | 12000 | `BRAINX_INJECT_MAX_TOTAL_CHARS` | `--maxTotalChars` |
| Min score gate | 0.25 | `BRAINX_INJECT_MIN_SCORE` | `--minScore` |

### `resolve` — Resolve/promote memories

```bash
# Resolve a memory
./brainx resolve --id m_123 --status resolved \
  --resolutionNotes "Patched retry backoff"

# Promote all memories of a pattern
./brainx resolve \
  --patternKey retry.429.swallow \
  --status promoted \
  --promotedTo docs/runbooks/retry.md \
  --resolutionNotes "Standard retry policy captured"
```

### `promote-candidates` — View promotion candidates

```bash
./brainx promote-candidates --json
./brainx promote-candidates --minRecurrence 3 --days 30 --limit 10
```

### `lifecycle-run` — Auto-promote/degrade memories

```bash
# Dry run first
./brainx lifecycle-run --dryRun --json

# Execute
./brainx lifecycle-run --json
```

### `metrics` — Operational KPIs

```bash
./brainx metrics --days 30 --topPatterns 10 --json
```

Returns:
- Distribution by tier
- Top recurring patterns
- Query performance (average duration, call count)
- Lifecycle statistics

---

## Memory Types

| Type | Description | Example |
|------|-------------|---------|
| `fact` | Concrete operational data | URLs, services, configs, personal data, finances |
| `decision` | Decisions made | "We use gpt-4.1-mini for the distiller" |
| `learning` | Things discovered/learned | "Service X doesn't support websockets on free plan" |
| `gotcha` | Traps to avoid | "Don't use `rm -rf` without confirming path first" |
| `action` | Actions executed | "Deployed my-project v2.3 to production" |
| `note` | General notes | "The client prefers morning meetings" |
| `feature_request` | Requested/planned features | "Add webhook support in v3" |

---

## Supported Categories

### Original categories (technical)

| Category | Use |
|----------|-----|
| `learning` | Technical learnings |
| `error` | Errors encountered and resolved |
| `feature_request` | Feature requests |
| `correction` | Corrections to previous information |
| `knowledge_gap` | Detected knowledge gaps |
| `best_practice` | Discovered best practices |

### New categories (contextual)

| Category | Use |
|----------|-----|
| `infrastructure` | Infra: URLs, services, deployments |
| `project_registry` | Project registry and configs |
| `personal` | Personal user data |
| `financial` | Financial information (costs, budgets) |
| `contact` | Contacts (names, roles, companies) |
| `preference` | User preferences |
| `goal` | Objectives and goals |
| `relationship` | Relationships between people/entities |
| `health` | Health data |
| `business` | Business information |
| `client` | Client data |
| `deadline` | Deadlines and due dates |
| `routine` | Routines and recurring processes |
| `context` | General context for sessions |

---

## Core Features

### Automatic PII Scrubbing

**Module:** `lib/brainx-phase2.js`

Before saving any memory, BrainX automatically applies sensitive data redaction. The 14 detected patterns:

| Pattern | Detected example |
|---------|-----------------|
| `email` | `user@domain.com` |
| `phone` | `+1 (555) 123-4567` |
| `openai_key` | `sk-abc123...` |
| `github_token` | `ghp_xxxx...` |
| `github_pat` | `github_pat_xxxx...` |
| `aws_access_key` | `AKIAIOSFODNN7EXAMPLE` |
| `slack_token` | `xoxb-xxx-xxx` |
| `bearer_token` | `Bearer eyJ...` |
| `api_key_assignment` | `api_key=sk_live_xxx` |
| `jwt_token` | `eyJhbGciOi...` |
| `private_key_block` | `-----BEGIN RSA PRIVATE KEY-----` |
| `iban` | `DE89370400440532013000` |
| `credit_card` | `4111 1111 1111 1111` |
| `ipv4` | `192.168.1.100` |

**Behavior:**
- Enabled by default (`BRAINX_PII_SCRUB_ENABLED=true`)
- Data is replaced with `[REDACTED]` (configurable)
- Auto-tags added: `pii:redacted`, `pii:email`, etc.
- Contexts in allowlist are exempt

```bash
BRAINX_PII_SCRUB_ENABLED=true                        # default: true
BRAINX_PII_SCRUB_REPLACEMENT=[REDACTED]               # default
BRAINX_PII_SCRUB_ALLOWLIST_CONTEXTS=internal-safe,trusted
```

### Semantic Deduplication

**Module:** `lib/openai-rag.js` (storeMemory)

When storing a memory, BrainX checks if a similar one already exists:

1. **By `pattern_key`** — If the memory has a pattern_key, looks for another with the same key
2. **By cosine similarity** — If no pattern_key, compares the embedding against recent memories from the same context and category

If a duplicate is detected (similarity ≥ threshold):
- **Does NOT create a new one** — updates the existing one
- **Increments `recurrence_count`** — tracks how many times the pattern repeats
- **Updates `last_seen`** — date of last observation
- **Preserves `first_seen`** — keeps the original date

```bash
BRAINX_DEDUPE_SIM_THRESHOLD=0.92  # default: if similarity > 0.92, merge
BRAINX_DEDUPE_RECENT_DAYS=30      # comparison window
```

### Score-Based Ranking

**Module:** `lib/openai-rag.js` (search)

Searches use a composite score to sort results:

```
score = cosine_similarity
      + (importance / 10) × 0.25     # bonus for importance
      + tier_bonus                     # hot: +0.15, warm: +0.05, cold: -0.05, archive: -0.10
```

This ensures high-importance, hot-tier memories appear first, even with slightly lower similarity.

### Access Tracking

**Module:** `lib/openai-rag.js` (search)

Each time a memory appears in search results:
- `last_accessed` updates to `NOW()`
- `access_count` increments by 1

This allows `quality-scorer.js` to identify actively used vs. stale memories.

### Memory Superseding

**Column:** `superseded_by` (FK to another memory)

When a memory is replaced by a newer or more complete version:
- Marked with `superseded_by = ID_of_new_memory`
- Superseded memories are **automatically excluded** from searches (`WHERE superseded_by IS NULL`)
- `contradiction-detector.js` and `dedup-supersede.js` handle this automatically

### Pattern Detection and Recurrence Counting

**Table:** `brainx_patterns`

When a memory repeats (by `pattern_key` or by semantic similarity):
- The record in `brainx_patterns` updates with:
  - `recurrence_count` — times observed
  - `first_seen` / `last_seen` — temporal range
  - `impact_score` — `importance × tier_impact`
  - `representative_memory_id` — the most representative memory
- High-recurrence patterns are candidates for **promotion** (via `promote-candidates`)

### Query Logging and Performance Tracking

**Table:** `brainx_query_log`

Every `search` and `inject` operation records:
- `query_hash` — hash of the query
- `query_kind` — `search` | `inject`
- `duration_ms` — execution time
- `results_count` — number of results
- `avg_similarity` / `top_similarity` — similarity metrics

This feeds the `metrics` command and `ops-alerts.sh` and `weekly-dashboard.sh` reports.

### Lifecycle Management (Promote/Degrade/Archive)

**Command:** `lifecycle-run`

The automatic lifecycle manager evaluates memories and decides on actions:

| Action | Criterion |
|--------|-----------|
| **Promote** (cold/warm → hot) | High-recurrence patterns + importance ≥ threshold |
| **Degrade** (hot → warm, warm → cold) | No recent access + low importance + little usage |
| **Archive** (any → archive) | Very low quality or no prolonged usage |

```bash
# See what it would do without executing
./brainx lifecycle-run --dryRun --json

# Execute promotions/degradations
./brainx lifecycle-run --json
```

Flags: `--promoteMinRecurrence`, `--promoteDays`, `--degradeDays`, `--lowImportanceMax`, `--lowAccessMax`

### Memory Injection Engine

**Module:** `lib/cli.js` → `cmdInject()` + `formatInject()`

The **Memory Injection Engine** is the central component that connects stored memory with agents. It's not a simple `SELECT` — it's a complete pipeline of retrieval, filtering, ranking, truncation, and formatting.

#### Complete injection pipeline flow:

```
Text query
     │
     ▼
  embed(query)               ← Generates embedding via OpenAI API
     │
     ▼
  warm_or_hot strategy       ← Searches hot first, then warm, merges unique
     │
     ▼
  SQL Ranking                 ← score = similarity + (importance/10 × 0.25) + tier_bonus
     │
     ▼
  Min Score Gate              ← Filters results with score < 0.25 (configurable)
     │
     ▼
  formatInject()              ← Intelligent truncation by lines and characters
     │
     ▼
  Prompt-ready output         ← Text ready to inject into LLM context
```

#### `warm_or_hot` search strategy (default)

When no tier is specified, inject:
1. Searches `hot` memories (high priority)
2. Searches `warm` memories (medium priority)
3. Merge: removes duplicates by ID, prioritizes hot, limits to configured `--limit`

This ensures critical (hot) memories always appear, complemented by warm if there's room.

#### Intelligent truncation (`formatInject`)

Output is controlled with 3 limits:

| Parameter | Default | Environment variable | CLI flag |
|-----------|---------|---------------------|----------|
| Max chars per item | 2000 | `BRAINX_INJECT_MAX_CHARS_PER_ITEM` | `--maxCharsPerItem` |
| Max lines per item | 80 | `BRAINX_INJECT_MAX_LINES_PER_ITEM` | `--maxLinesPerItem` |
| Max total chars | 12000 | `BRAINX_INJECT_MAX_TOTAL_CHARS` | `--maxTotalChars` |
| Min score gate | 0.25 | `BRAINX_INJECT_MIN_SCORE` | `--minScore` |

If an item exceeds the limit, it's truncated with `…`. If total output exceeds `maxTotalChars`, it cuts without adding more items.

#### Output format

Each memory is formatted as:

```
[sim:0.82 score:1.12 imp:9 tier:hot type:decision agent:coder ctx:openclaw]
Memory content here...

---

[sim:0.71 score:0.98 imp:8 tier:warm type:learning agent:support ctx:brainx]
Other content...
```

The metadata in the `[sim:... score:... ...]` header allows the agent to evaluate the relevance of each memory.

#### Auto-Inject Hook: From engine to agent

The `hook/handler.js` hook uses the injection engine to write runtime context files inside the agent workspace:

```
Event agent:bootstrap
     │
     ▼
  handler.js executes
     │
     ├─ Section 1: direct psql → Facts (type=fact, hot/warm tier)
     │
     ├─ Section 2: brainx inject → Agent's own memories (context=agent:NAME, imp≥6)
     │
     ├─ Section 3: brainx inject → High-signal team memories (facts/decisions/gotchas; `learning` excluded by default)
     │
     ▼
  Legacy compatibility artifacts updated if hook path is enabled
  (`MEMORY.md`, `brainx-topics/*.md`, `BRAINX_CONTEXT.md`)
```

**Hook telemetry:** Each injection records in `brainx_pilot_log`:
- Agent, own memories, team memories, total chars generated

**Operational rule:** injected memories are for orientation and hypothesis-building. They do not outrank code, runtime, DB, logs, tests, screenshots, or direct user feedback.

**Canonical rule:** `brainx.md` is the stable guide owned by the skill (`~/.openclaw/skills/brainx/brainx.md`). It is not generated by the hook and must not be treated as a per-workspace source of truth.

### Memory Store Engine

**Module:** `lib/openai-rag.js` → `storeMemory()`

Storage is NOT a simple INSERT. It's a 7-step pipeline inside a transaction:

```
New memory
     │
     ▼
  1. Quality gate           ← assessMemoryQuality() skips ack/noise/placeholders,
     │                        downgrades borderline signal before embeddings
     ▼
  2. PII Scrubbing          ← scrubTextPII() on content and context
     │
     ▼
  3. Tag merging             ← mergeTagsWithMetadata() adds pii:redacted + quality tags
     │
     ▼
  4. Embedding               ← embed("type: content [context: ctx]")
     │
     ▼
  5. Dedup check             ← By pattern_key OR by cosine similarity (threshold 0.92)
     │                         deriveMergePlan() decides: merge vs. create new
     ▼
  6. UPSERT                  ← INSERT ... ON CONFLICT DO UPDATE (transactional)
     │                         Preserves first_seen, increments recurrence, updates last_seen
     ▼
  7. Pattern upsert          ← upsertPatternRecord() updates brainx_patterns
     │
     ▼
  Return metadata            ← {id, pattern_key, recurrence_count, pii_scrub_applied,
                                 redacted, redaction_reasons, quality_action, quality_reason,
                                 dedupe_merged, dedupe_method}
```

#### Lifecycle normalization (`normalizeLifecycle`)

Before storing, each memory goes through normalization that:
- Maps camelCase ↔ snake_case fields (`firstSeen` → `first_seen`)
- Assigns defaults (`status: 'pending'`, timestamps to NOW())
- Preserves existing fields if not provided

#### Quality gate (`assessMemoryQuality`)

Before embedding, BrainX applies an LLM-free heuristic gate:
- Skips exact noise (`HEARTBEAT_OK`, `NO_REPLY`, bare acknowledgements)
- Skips vague placeholders (`Need to review this`, `revisar esto`)
- Skips repetitive or symbol-only garbage
- Downgrades borderline short memories by capping importance/confidence
- Adds `quality:*` tags so cleanup/reporting can reason about what happened

```bash
BRAINX_STRICT_QUALITY=false            # reject instead of downgrading/skipping silently
BRAINX_QUALITY_MIN_CHARS=20            # default minimum useful length
BRAINX_QUALITY_MIN_WORDS=4             # default minimum useful word count
BRAINX_QUALITY_BORDERLINE_CHARS=40     # below this, short memories need stronger signal
```

#### Impact score for patterns (`tierImpact`)

A pattern's impact score is calculated as:

```
impact = importance × tier_factor

tier_factor:
  hot     → 1.0
  warm    → 0.7
  cold    → 0.4
  archive → 0.2
```

### Embedding Engine

**Module:** `lib/openai-rag.js` → `embed()`

- **Model:** `text-embedding-3-small` (configurable via `OPENAI_EMBEDDING_MODEL`)
- **Dimensions:** 1536 (must match schema `vector(1536)`)
- **Input:** Concatenated as `"type: content [context: ctx]"` to maximize semantic relevance
- **API:** POST to `https://api.openai.com/v1/embeddings`
- **Cost:** ~$0.02 per million tokens (text-embedding-3-small)

### Database Layer

**Module:** `lib/db.js`

- PostgreSQL connection pool via `pg.Pool`
- `withClient(fn)` — gets a client from the pool, executes fn, and returns it (for transactions)
- `query(sql, params)` — executes direct query
- `health()` — verifies connection
- Automatic env loading from `BRAINX_ENV` if `DATABASE_URL` is not set directly

---

## Detailed Script Documentation

### `memory-distiller.js` — LLM Memory Extractor

**File:** `scripts/memory-distiller.js`

The Memory Distiller uses an LLM (default `gpt-4.1-mini`) to read complete transcripts of agent sessions and extract **ALL** relevant memory types.

#### What it extracts

Unlike regex extractors, the distiller **understands context**:

1. **Facts** — URLs, endpoints, configs, personal data, finances, contacts, dates
2. **Decisions** — Technical and business decisions
3. **Learnings** — Resolved bugs, discovered workarounds
4. **Gotchas** — Common traps and mistakes
5. **Preferences** — How the user likes things

#### Usage

```bash
# Manual execution (last 8 hours by default)
node scripts/memory-distiller.js

# Custom time window
node scripts/memory-distiller.js --hours 24

# Only one agent
node scripts/memory-distiller.js --agent coder

# Dry run (saves nothing)
node scripts/memory-distiller.js --dry-run --verbose

# Alternative model
node scripts/memory-distiller.js --model gpt-4o-mini

# Limit processed sessions
node scripts/memory-distiller.js --max-sessions 5
```

#### Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--hours` | 8 | Time window to search sessions |
| `--dry-run` | false | Simulate without saving anything |
| `--agent` | all | Filter by specific agent |
| `--verbose` | false | Detailed output |
| `--model` | `gpt-4.1-mini` | LLM model to use |
| `--max-sessions` | 20 | Maximum sessions to process |

#### Session tracking

Already-processed sessions are tracked in `data/distilled-sessions.json`. If a session hasn't been modified since the last run, it's skipped automatically (idempotent).

#### Configuration

| Environment variable | Default | Description |
|---------------------|---------|-------------|
| `BRAINX_DISTILLER_MODEL` | `gpt-4.1-mini` | Default model |
| `OPENAI_API_KEY` | — | **Required** |

---

### `fact-extractor.js` — Regex Fact Extractor

**File:** `scripts/fact-extractor.js`

Fast regex-based extractor that complements the Memory Distiller. No LLM, so it's free and fast.

#### What it extracts

| Pattern | Example |
|---------|---------|
| Service URLs | `https://my-app.example.com` |
| Vercel URLs | `https://app.vercel.app` |
| GitHub repos | `github.com/user/repo` |
| Service mappings | `service my-api → backend` |
| Ports and configs | `PORT=3001`, `NODE_ENV=production` |
| Branches | `branch: main`, `deploy target: staging` |

#### Usage

```bash
# Manual execution (last 24 hours by default)
node scripts/fact-extractor.js

# Custom time window
node scripts/fact-extractor.js --hours 48

# Only one agent
node scripts/fact-extractor.js --agent raider

# Dry run
node scripts/fact-extractor.js --dry-run --verbose
```

#### Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--hours` | 24 | Time window to search sessions |
| `--dry-run` | false | Simulate without saving |
| `--agent` | all | Filter by agent |
| `--verbose` | false | Detailed output |

---

### `session-harvester.js` — Session Harvester

**File:** `scripts/session-harvester.js`

Reads recent OpenClaw sessions (JSONL files) and extracts high-signal memories using regex heuristics. Looks for patterns like decisions, errors, learnings, and gotchas in conversation text.

#### Usage

```bash
# Manual execution (last 4 hours by default)
node scripts/session-harvester.js

# Customize window and limits
node scripts/session-harvester.js --hours 8 --max-memories 40

# Only one agent, with dry-run
node scripts/session-harvester.js --agent main --dry-run --verbose

# Filter by minimum content size
node scripts/session-harvester.js --min-chars 200
```

#### Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--hours` | 4 | Time window to search sessions |
| `--dry-run` | false | Simulate without saving |
| `--agent` | all | Filter by agent |
| `--verbose` | false | Detailed output |
| `--min-chars` | 120 | Minimum characters to consider a memory valid |
| `--max-memories` | (no limit) | Maximum memories to extract |

#### Difference from Memory Distiller

| Feature | Session Harvester | Memory Distiller |
|---------|-------------------|------------------|
| Method | Regex/heuristics | LLM (gpt-4.1-mini) |
| Cost | Free | ~$0.01-0.05 per session |
| Understanding | Text patterns | Understands full context |
| Speed | Very fast | Slow (API calls) |
| Quality | Medium (false positives) | High |

---

### `memory-bridge.js` — Markdown → Vector Bridge

**File:** `scripts/memory-bridge.js`

Syncs `memory/*.md` files from all OpenClaw workspaces to the vector database. Each H2 section (`##`) in markdown becomes an independent, searchable memory.

#### Usage

```bash
# Manual execution (files from last 6 hours)
node scripts/memory-bridge.js

# Wider window
node scripts/memory-bridge.js --hours 24

# Limit memories created
node scripts/memory-bridge.js --max-memories 30

# Dry run
node scripts/memory-bridge.js --dry-run --verbose
```

#### Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--hours` | 6 | Time window (recently modified files) |
| `--dry-run` | false | Simulate without saving |
| `--max-memories` | 20 | Maximum memories to create |
| `--verbose` | false | Detailed output |

#### How it works

1. Scans all `~/.openclaw/workspace-*/memory/` directories
2. Finds `.md` files modified in the last N hours
3. Splits each file into blocks by H2 sections
4. Each block is saved as a `note` type memory with workspace context
5. Already-synced sections are marked with `<!-- brainx-synced -->`

---

### `import-knowledge-md.js` — Curated Knowledge Base Import

**File:** `scripts/import-knowledge-md.js`

Imports curated documents from `knowledge/` into BrainX as a separate documentary layer.

- `knowledge/<domain>/...` = manual canonical docs

Canonical knowledge is imported with stronger provenance than `markdown_import`, so it can participate in retrieval as durable reference material instead of simple changelog.

#### Usage

```bash
# canonical only
node scripts/import-knowledge-md.js

# one domain
node scripts/import-knowledge-md.js --domain finanzas --dry-run --verbose
```

#### Notes

1. `README.md`, `INDEX.md`, and files prefixed with `_` are not indexed
2. The default retrieval scope for this layer is `knowledge:<domain>`
3. Topic/file identity is preserved in tags and `source_path`
4. Re-importing a file obsoletes chunks removed from the source

---

### `knowledge-sync.js` — Smart Knowledge Sync

**File:** `scripts/knowledge-sync.js`

High-level sync command for `knowledge/`.

- Detects manual changes only
- Re-imports canonical docs only when needed
- Refreshes `BRAINX:AUTO` blocks afterwards
- Stores state so cron can run safely without looping forever

#### Usage

```bash
./brainx knowledge-sync
./brainx knowledge-sync --dry-run --json
```

#### Notes

1. This is the recommended manual command
2. It ignores auto-block-only changes when deciding whether to sync
3. `knowledge-import` remains available as a lower-level tool

---

### `knowledge-locate.js` — Canonical Doc Locator

**File:** `scripts/knowledge-locate.js`

Task-oriented locator for `knowledge/`.

- Searches BrainX once
- Keeps only canonical knowledge hits
- Groups them by source file
- Returns the exact `.md` files an agent should read completely before drafting

#### Usage

```bash
./brainx knowledge-locate --query "draft a sponsorship reply"
./brainx knowledge-locate --query "prepare a premium website proposal" --json
```

#### Notes

1. Use this when the task depends on house knowledge, playbooks, pricing, proposals, emails, or brand/process docs
2. It is lighter than manually scanning the whole `knowledge/` tree
3. `knowledge-sync` keeps the DB fresh; `knowledge-locate` decides which files matter for the task

---

### `new-knowledge-topic.js` — Knowledge Topic Scaffolder

Creates a new canonical topic file inside `knowledge/<domain>/` with:

- frontmatter
- manual sections
- `BRAINX:AUTO` markers so BrainX can write only inside the auto-managed zone

Example:

```bash
./brainx knowledge-new --category development --name nextjs-server-actions
```

---

### `sync-knowledge-auto-blocks.js` — Auto Block Sync

Refreshes only the auto-managed block inside knowledge docs. This keeps the file simple:

- manual content stays editable by Marcelo
- BrainX writes only between `<!-- BRAINX:AUTO:START -->` and `<!-- BRAINX:AUTO:END -->`
- importer ignores that block to avoid feedback loops

Example:

```bash
./brainx knowledge-auto-sync
./brainx knowledge-auto-sync --domain branding --dry-run --verbose
```

---

### `seed-knowledge-library.js` — Knowledge Seed Generator

Creates a realistic first-pass knowledge base across the current taxonomy. It is intended to avoid empty category folders and give Marcelo a sane starting point for manual curation.

Example:

```bash
./brainx knowledge-seed --dry-run
./brainx knowledge-seed
```

---

### `cross-agent-learning.js` — Cross-Agent Propagation

**File:** `scripts/cross-agent-learning.js`

Propagates high-importance learnings and gotchas from an individual agent to the global context, so **all** agents benefit from shared discoveries.

This does **not** mean every propagated learning is auto-injected at bootstrap. Global learnings remain available for explicit recall, while bootstrap injection stays narrower to reduce drift.

#### Usage

```bash
# Manual execution (last 24 hours)
node scripts/cross-agent-learning.js

# Custom window
node scripts/cross-agent-learning.js --hours 48

# Dry run (recommended first)
node scripts/cross-agent-learning.js --dry-run --verbose

# Limit shares
node scripts/cross-agent-learning.js --max-shares 5
```

#### Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--hours` | 24 | Time window |
| `--dry-run` | false | Simulate without sharing |
| `--verbose` | false | Detailed output |
| `--max-shares` | 10 | Maximum memories to share |

#### Logic

1. Searches recent memories of type `learning` or `gotcha` with high importance
2. Filters those with `agent:*` context (specific to one agent)
3. Creates a copy with `global` context so all agents can see it
4. Avoids duplicates by checking if a global copy already exists

---

### `error-harvester.js` — Post-Error Capture

**File:** `scripts/error-harvester.js`

Scans OpenClaw session logs for command failures (non-zero exit codes, error patterns) and stores them as gotcha memories in BrainX. Runs in the daily cron pipeline.

#### Usage

```bash
# Dry run (recommended first)
node scripts/error-harvester.js --dry-run --verbose

# Scan last 24 hours (default)
node scripts/error-harvester.js

# Custom time window
node scripts/error-harvester.js --hours 48
```

#### Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--hours` | 24 | Time window to scan |
| `--dry-run` | false | Show errors without saving |
| `--verbose` | false | Print each error found |

#### Detects

- Non-zero exit codes from tool executions
- `TypeError`, `ReferenceError`, `SyntaxError` patterns
- `ENOENT`, `EACCES`, `EPERM`, `ECONNREFUSED` errors
- `permission denied`, `command not found` patterns

Saved memories are tagged `auto-harvested,error` with type `gotcha`.

---

### `auto-promoter.js` — Pattern Promotion Suggestions

**File:** `scripts/auto-promoter.js`

Detects high-recurrence patterns and generates suggestions for which section of the canonical `agent-core` reference file they should be promoted to. **Does not write to workspace files** — outputs suggestions only, which are then consumed by `promotion-applier.js`.

#### Usage

```bash
# View suggestions
node scripts/auto-promoter.js

# JSON output
node scripts/auto-promoter.js --json

# Save suggestions as BrainX memories
node scripts/auto-promoter.js --save

# Custom thresholds
node scripts/auto-promoter.js --min-recurrence 6 --days 14
```

#### Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--min-recurrence` | 6 | Minimum pattern recurrence to qualify |
| `--days` | 30 | Time window |
| `--json` | false | JSON output |
| `--save` | false | Save suggestions as BrainX memories (tag: `promotion-suggestion`) |
| `--dry-run` | false | Simulate without saving |

#### Classification Logic

| Target Section | Triggers |
|-------------|----------|
| `Tools & Infrastructure` | Infrastructure, CLI, API, config, integration patterns |
| `Behavior & Tone` | Behavioral, style, communication patterns |
| `Workflow & Execution` | Workflow, execution, delegation patterns |

---

### `promotion-applier.js` — Last-Mile Promotion Applier

**File:** `scripts/promotion-applier.js`

Reads pending promotion suggestions (saved by `auto-promoter.js` with tag `promotion-suggestion`), distills each suggestion via LLM (gpt-4.1-mini) into a concise rule, and writes the final rules into the canonical file `~/.openclaw/skills/agent-core/references/BRAINX_PROMOTED_RULES.md` only when an explicit review gate is opened.

#### What it does

1. Queries BrainX for memories tagged `promotion-suggestion` with `status = pending`
2. Ignores obsolete or superseded suggestions
3. For each suggestion, calls gpt-4.1-mini to distill it into a 1-2 sentence actionable rule
4. Appends the rule to the target section in `~/.openclaw/skills/agent-core/references/BRAINX_PROMOTED_RULES.md` only when `--force-apply` or `BRAINX_PROMOTION_AUTO_APPLY=true` is present
5. Marks the suggestion memory as `status = promoted`
6. Reports applied, skipped, and failed promotions

#### Usage

```bash
# Intentionally apply pending promotions after review
node scripts/promotion-applier.js --apply --force-apply

# Dry run (show what would be applied without writing)
node scripts/promotion-applier.js --dry-run --verbose

# Limit number of promotions to apply
node scripts/promotion-applier.js --apply --force-apply --limit 5

# Only apply patterns with high recurrence
node scripts/promotion-applier.js --apply --force-apply --min-recurrence 10

# Verbose output
node scripts/promotion-applier.js --apply --force-apply --verbose
```

#### Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--apply` | false | Execute the promotion (write to the canonical reference file) |
| `--force-apply` | false | Required for intentional writes unless `BRAINX_PROMOTION_AUTO_APPLY=true` |
| `--dry-run` | false | Simulate without writing. Shows what rules would be added |
| `--limit` | 20 | Maximum number of promotions to apply per run |
| `--min-recurrence` | 6 | Minimum recurrence count for a suggestion to qualify |
| `--verbose` | false | Print each rule being written |

#### Example output

```
[promotion-applier] Found 3 pending promotion suggestions
[promotion-applier] Distilling: "Use plugin v2 for WordPress publishing" → target: Tools & Infrastructure
[promotion-applier] Writing rule to BRAINX_PROMOTED_RULES.md
[promotion-applier] Distilling: "Always verify auth token before deploy" → target: Workflow & Execution
[promotion-applier] Writing rule to BRAINX_PROMOTED_RULES.md
[promotion-applier] Done: 2 applied, 1 skipped (below min-recurrence), 0 failed
```

#### Configuration

| Environment variable | Default | Description |
|---------------------|---------|-------------|
| `BRAINX_DISTILLER_MODEL` | `gpt-4.1-mini` | LLM model for distillation |
| `OPENAI_API_KEY` | — | **Required** |
| `BRAINX_PROMOTION_AUTO_APPLY` | `false` | Allows unattended `--apply` runs when explicitly enabled |
| `BRAINX_PROMOTER_MIN_RECURRENCE` | `5` | Default min recurrence |

---

### `contradiction-detector.js` — Contradiction Detector

**File:** `scripts/contradiction-detector.js`

Detects hot memories that are semantically very similar to each other and marks the older/shorter ones as superseded by the newer/more complete ones.

#### Usage

```bash
# Dry run (recommended first)
node scripts/contradiction-detector.js --dry-run --verbose

# Analyze top 50 hot memories with threshold 0.80
node scripts/contradiction-detector.js --top 50 --threshold 0.80

# Execute (modifies DB)
node scripts/contradiction-detector.js --verbose
```

#### Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--top` | 30 | Number of hot memories to analyze |
| `--threshold` | 0.85 | Cosine similarity threshold to consider a contradiction |
| `--dry-run` | false | Report only, don't modify |
| `--verbose` | false | Print detailed analysis of each pair |

#### Logic

1. Loads top N hot memories (with embeddings)
2. Compares each pair by calculating cosine similarity
3. If similarity ≥ threshold, marks the older or shorter as superseded
4. The newer/more complete becomes the canonical memory

---

### `quality-scorer.js` — Quality Evaluator

**File:** `scripts/quality-scorer.js`

Evaluates existing memories based on multiple factors and decides whether they should be promoted, maintained, degraded, or archived.

#### Usage

```bash
# Dry run (recommended first)
node scripts/quality-scorer.js --dry-run --verbose

# Evaluate more memories
node scripts/quality-scorer.js --limit 100 --verbose

# Execute (modifies tiers)
node scripts/quality-scorer.js
```

#### Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--limit` | 50 | Number of memories to evaluate |
| `--dry-run` | false | Report only, don't modify |
| `--verbose` | false | Show scoring detail per memory |

#### Scoring Factors

| Factor | Effect |
|--------|--------|
| **Access age** | >30 days without access: -2, >14 days: -1, <3 days: +1 |
| **Access count** | ≥10 accesses: +2, ≥5: +1, 0 accesses: -1 |
| **Content length** | ≥100 chars: +1, <50 chars: -1 |
| **Referenced files** | For each non-existent file: -0.5 |
| **Tier/importance coherence** | Importance ≥8 in cold: +2 (promote); importance ≤3 in hot: -2 (degrade) |

**Result:** Score 1-10 → decides action:
- High score → **promote** (raise tier)
- Medium score → **maintain** (no change)
- Low score → **degrade** (lower tier)
- Very low score → **archive**

---

### `context-pack-builder.js` — Context Pack Builder

**File:** `scripts/context-pack-builder.js`

Generates weekly "context packs" that summarize hot/warm memories grouped by context (`agent:*`, `project:*`). Packs are compact markdown blocks designed for efficient LLM injection (fewer tokens, more signal).

#### Usage

```bash
# Generate packs for all agents
node scripts/context-pack-builder.js

# Only one agent
node scripts/context-pack-builder.js --agent coder

# Limit memories per pack
node scripts/context-pack-builder.js --limit 20

# Dry run
node scripts/context-pack-builder.js --dry-run --verbose
```

---

### `cleanup-low-signal.js` — Low Signal Cleanup

**File:** `scripts/cleanup-low-signal.js`

Archives memories that provide little value: too short, low importance, or not accessed recently.

#### Usage

```bash
# Dry run first
node scripts/cleanup-low-signal.js --dry-run --verbose

# Execute cleanup
node scripts/cleanup-low-signal.js

# Adjust thresholds
node scripts/cleanup-low-signal.js --maxImportance 3 --minLength 50 --days 90
```

---

### `dedup-supersede.js` — Deduplication and Superseding

**File:** `scripts/dedup-supersede.js`

Finds exact or near-identical memory pairs and merges them, keeping the most complete version.

#### Usage

```bash
# Dry run (recommended first)
node scripts/dedup-supersede.js --dry-run --verbose

# Adjust similarity threshold
node scripts/dedup-supersede.js --threshold 0.95 --verbose

# Execute
node scripts/dedup-supersede.js
```

---

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | **Required.** PostgreSQL connection string |
| `OPENAI_API_KEY` | — | **Required.** OpenAI API key |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model |
| `BRAINX_ENV` | — | Path to `.env` file with database config |
| `BRAINX_PII_SCRUB_ENABLED` | `true` | Enable PII scrubbing |
| `BRAINX_PII_SCRUB_REPLACEMENT` | `[REDACTED]` | Replacement text for scrubbed data |
| `BRAINX_PII_SCRUB_ALLOWLIST_CONTEXTS` | — | Comma-separated exempt contexts |
| `BRAINX_DEDUPE_SIM_THRESHOLD` | `0.92` | Similarity threshold for deduplication |
| `BRAINX_DEDUPE_RECENT_DAYS` | `30` | Comparison window for deduplication |
| `BRAINX_INJECT_MAX_CHARS_PER_ITEM` | `2000` | Max chars per injected memory |
| `BRAINX_INJECT_MAX_LINES_PER_ITEM` | `80` | Max lines per injected memory |
| `BRAINX_INJECT_MAX_TOTAL_CHARS` | `12000` | Max total chars in injection output |
| `BRAINX_INJECT_MIN_SCORE` | `0.25` | Minimum score gate for injection |
| `BRAINX_DISTILLER_MODEL` | `gpt-4.1-mini` | Default model for Memory Distiller and Promotion Applier |
| `BRAINX_PROMOTER_MIN_RECURRENCE` | `6` | Default minimum recurrence for auto-promotion |
| `BRAINX_PROMOTION_AUTO_APPLY` | `false` | Allows `promotion-applier.js --apply` to write without `--force-apply` |
| `BRAINX_CONSOLIDATION_MIN_SIMILARITY` | `0.82` | Default similarity threshold for weekly semantic consolidation |
| `BRAINX_CONSOLIDATION_MIN_AGE_DAYS` | `7` | Minimum memory age before consolidation is allowed |
| `BRAINX_CONSOLIDATION_MAX_SEEDS` | `600` | Max eligible seed memories inspected per weekly run |
| `BRAINX_CONSOLIDATION_WEEKDAY_UTC` | `0` | UTC weekday for weekly consolidation (`0` = Sunday) |

---

## Cron Jobs Setup

The recommended setup uses the current **hybrid daily/midweek/weekly pipeline** managed by OpenClaw cron: 14 daily steps every day, 2 additional Wednesday/Sunday steps, and 8 deeper Sunday-only maintenance steps. Individual cron entries are historical unless documented in [`docs/CRON.md`](docs/CRON.md).

### Consolidated Pipeline (recommended)

Configure in `~/.openclaw/cron/jobs.json` as a daily job named `BrainX Daily Core Pipeline V5`. It runs the wrapper `/home/clawd/.openclaw/skills/brainx/cron/brainx-daily-core-wrapper.sh`; the wrapper, not the prompt text, is the source of truth for step count and cadence.

### Individual Cron Entries (historical reference only)

These examples are not the active scheduler on `/home/clawd`. The current host uses the consolidated OpenClaw cron wrapper documented in [`docs/CRON.md`](docs/CRON.md) and [`docs/RUNTIME_STATUS.md`](docs/RUNTIME_STATUS.md).

```bash
# Every 4h: Session Harvester
0 */4 * * * cd /path/to/brainx && node scripts/session-harvester.js >> logs/harvester.log 2>&1

# Every 6h: Memory Distiller + Fact Extractor + Memory Bridge
0 */6 * * * cd /path/to/brainx && node scripts/memory-distiller.js >> logs/distiller.log 2>&1
30 */6 * * * cd /path/to/brainx && node scripts/fact-extractor.js >> logs/fact-extractor.log 2>&1
0 1,7,13,19 * * * cd /path/to/brainx && node scripts/memory-bridge.js >> logs/bridge.log 2>&1

# Daily: Cross-agent learning + Contradiction detection + Quality scoring + Promotions
0 3 * * * cd /path/to/brainx && node scripts/cross-agent-learning.js >> logs/cross-agent.log 2>&1
30 3 * * * cd /path/to/brainx && node scripts/contradiction-detector.js >> logs/contradiction.log 2>&1
0 4 * * * cd /path/to/brainx && node scripts/quality-scorer.js >> logs/quality.log 2>&1
15 4 * * * cd /path/to/brainx && node scripts/auto-promoter.js --save >> logs/auto-promoter.log 2>&1
30 4 * * * cd /path/to/brainx && node scripts/promotion-applier.js >> logs/promotion-applier.log 2>&1
45 4 * * * cd /path/to/brainx && bash scripts/backup-brainx.sh >> logs/backup.log 2>&1

# Weekly: Semantic consolidation + Context packs + Cleanup + Dedup
45 4 * * 0 cd /path/to/brainx && bash cron/weekly-semantic-consolidation.sh >> logs/consolidation.log 2>&1
0 5 * * 0 cd /path/to/brainx && node scripts/context-pack-builder.js >> logs/packs.log 2>&1
30 5 * * 0 cd /path/to/brainx && node scripts/cleanup-low-signal.js >> logs/cleanup.log 2>&1
0 6 * * 0 cd /path/to/brainx && node scripts/dedup-supersede.js >> logs/dedup.log 2>&1

# Health check every 30min
*/30 * * * * cd /path/to/brainx && bash cron/health-check.sh >> logs/health.log 2>&1
```

---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes
4. Run tests: `npm test`
5. Open a Pull Request

---

## License

MIT — see [LICENSE](LICENSE) for details.
