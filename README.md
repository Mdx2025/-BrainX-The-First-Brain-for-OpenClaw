# 🧠 BrainX — The First Brain for OpenClaw

> **Your AI agents forget everything after each session. BrainX fixes that — permanently.**

BrainX is a persistent vector memory engine for [OpenClaw](https://openclaw.ai) that gives your AI agents real, long-term memory. Built on PostgreSQL + pgvector + OpenAI embeddings, it stores, searches, and auto-injects contextual memories into every agent session.

**One brain. Every agent. Shared intelligence that grows smarter with every conversation.**

[![Install from ClawHub](https://img.shields.io/badge/ClawHub-Install-blue)](https://clawhub.ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## Why BrainX?

Without BrainX, every OpenClaw session starts from zero. Your agents are **amnesiac by default** — they forget decisions, preferences, learnings, and context the moment a session ends.

BrainX changes the game:

- **Persistent Memory** — Memories survive across sessions in PostgreSQL
- **Auto-Learning** — Learns from every conversation automatically, zero manual work
- **Hive Mind** — All agents share one brain. One agent learns → every agent benefits
- **Semantic Search** — Find memories by meaning, not exact keywords (RAG/vector search)
- **Auto-Injection** — Relevant context injected into every session on startup
- **Battle-Tested** — Running in production with 9+ agents 24/7

---

## Features

| # | Feature | Description |
|---|---------|-------------|
| 1 | 🧠 **Persistent Memory** | Memories stored in PostgreSQL + pgvector — survive across all sessions |
| 2 | 📥 **Auto-Learning** | Learns from every conversation automatically — no manual intervention |
| 3 | 🤝 **Hive Mind** | All agents share the same memory pool — collective intelligence |
| 4 | 🔎 **Semantic Search** | Vector similarity search powered by OpenAI embeddings |
| 5 | 💉 **Auto-Injection** | OpenClaw hook injects relevant context on every agent bootstrap |
| 6 | 🏷️ **Smart Classification** | Auto-types: facts, decisions, learnings, gotchas, notes, feature requests |
| 7 | 📊 **Priority Tiers** | Hot/warm/cold tiers with automatic promotion and degradation |
| 8 | 🤝 **Cross-Agent Learning** | Propagates important discoveries across all agents automatically |
| 9 | 🔄 **Semantic Deduplication** | Cosine similarity dedup with intelligent merge |
| 10 | ⚡ **Contradiction Detection** | Finds conflicting memories and supersedes the obsolete one |
| 11 | 🔒 **PII Scrubbing** | Auto-redacts API keys, emails, phone numbers, passwords before storage |
| 12 | 🔮 **Pattern Detection** | Detects recurring patterns and auto-promotes them to higher tiers |
| 13 | 📋 **Session Indexing** | Searches past conversations with 30-day retention |
| 14 | ⭐ **Quality Scoring** | Multi-dimensional quality evaluation with auto-promote/degrade |
| 15 | 📌 **Fact Extraction** | Regex extracts URLs, repos, ports, branches, configs from sessions |
| 16 | 📦 **Context Packs** | Weekly context packages organized per project and per agent |
| 17 | 🔍 **Telemetry** | Injection logs, query performance metrics, operational dashboards |
| 18 | 🔗 **Supersede Chains** | Obsolete memories marked but never deleted — full audit trail |
| 19 | 🧬 **Memory Distiller** | LLM (gpt-4o-mini) extracts structured memories from session logs |
| 20 | 🛡️ **Disaster Recovery** | Full backup/restore: database, configs, hooks, workspaces |
| 21 | 💾 **Production Ready** | Battle-tested with 9+ agents running continuously |

---

## Auto-Learning: How BrainX Teaches Itself

> BrainX doesn't just store memories — it **learns on its own.** Every conversation becomes permanent, shared knowledge without any human intervention.

Auto-Learning is the orchestration of capture, curation, propagation, and injection that converts ephemeral conversations into permanent collective intelligence. It runs 24/7 via cron jobs.

### The Auto-Learning Cycle

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    🧠 AUTO-LEARNING CYCLE                                │
│                                                                          │
│   ┌─────────────┐    ┌──────────────┐    ┌──────────────┐               │
│   │   Agent      │    │   Markdown   │    │   Manual     │               │
│   │   Sessions   │    │   memory/*.md│    │   (agents)   │               │
│   └──────┬──────┘    └──────┬───────┘    └──────┬───────┘               │
│          │                  │                    │                        │
│          ▼                  ▼                    ▼                        │
│   ┌─────────────────────────────────────────────────────┐               │
│   │          📥 AUTOMATIC CAPTURE (4 layers)             │               │
│   │                                                      │               │
│   │  Memory Distiller ──► LLM extracts memories          │               │
│   │  Fact Extractor   ──► Regex extracts hard data       │               │
│   │  Session Harvester ─► Heuristics classify            │               │
│   │  Memory Bridge    ──► Sync markdown → vectors        │               │
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
│   │ 🔄 SELF-    │  │ 🤝 CROSS-   │  │ 🔮 PATTERN    │                │
│   │ IMPROVEMENT │  │ AGENT       │  │ DETECTION     │                │
│   │             │  │ LEARNING    │  │               │                │
│   │ Quality     │  │             │  │ Recurrence    │                │
│   │ Scoring     │  │ Propagate   │  │ counting      │                │
│   │ Dedup       │  │ gotchas &   │  │ Pattern keys  │                │
│   │ Contradict. │  │ learnings   │  │ Auto-promote  │                │
│   │ Cleanup     │  │ to ALL      │  │               │                │
│   │ Lifecycle   │  │ agents      │  │               │                │
│   └──────┬──────┘  └──────┬──────┘  └───────┬──────┘                │
│          └────────────────┼──────────────────┘                        │
│                           ▼                                            │
│                  ┌─────────────────┐                                   │
│                  │ 💉 CONTEXTUAL   │                                   │
│                  │ INJECTION       │                                   │
│                  │                 │                                   │
│                  │ Auto-inject on  │                                   │
│                  │ every agent     │                                   │
│                  │ bootstrap       │                                   │
│                  │ Score-based     │                                   │
│                  │ ranking         │                                   │
│                  └─────────────────┘                                   │
│                           │                                            │
│                           ▼                                            │
│                  ┌─────────────────┐                                   │
│                  │ 🤖 SMARTER     │                                   │
│                  │ AGENTS          │                                   │
│                  │ every session   │                                   │
│                  └─────────────────┘                                   │
└──────────────────────────────────────────────────────────────────────────┘
```

**Result:** Every session from every agent feeds the memory → the memory self-optimizes → knowledge propagates → all agents get smarter next session. **Infinite improvement loop.**

---

### Automatic Memory Capture (4 Layers)

BrainX captures memories through 4 complementary mechanisms running in parallel:

| Mechanism | How it works | What it captures | Frequency |
|-----------|-------------|------------------|-----------|
| **Memory Distiller** | LLM (gpt-4o-mini) reads full session transcripts | Preferences, decisions, personal data, technical configs, financial info — ALL memory types | Every 6h |
| **Fact Extractor** | Regex patterns extract structured data | Production URLs, Railway services, GitHub repos, ports, branches, environment configs | Every 6h |
| **Session Harvester** | Heuristics and regex classify conversations | Conversation patterns, recurring topics, operational context | Every 12h |
| **Memory Bridge** | Syncs markdown files with vector database | Manual notes in `memory/*.md`, documentation, written decisions | Every 6h |

### Cross-Agent Learning (The Hive Mind)

When one agent discovers something important (a bug, a gotcha, a learning), it gets automatically propagated to ALL other agents.

**Script:** `scripts/cross-agent-learning.js`

**How it works:**
1. Scans recent memories with importance ≥ 7 and types `gotcha`, `learning`, `correction`
2. Identifies memories created by a specific agent
3. Replicates those memories to the context of all other agents
4. Nobody makes the same mistake twice

### Self-Improvement & Quality Curation

The memory optimizes itself — good memories rise, bad ones sink, duplicates merge, contradictions resolve:

| Script | What it does | Frequency |
|--------|-------------|-----------|
| **quality-scorer.js** | Evaluates memories on specificity, actionability, relevance. Promotes high-quality, degrades low-quality | Daily |
| **contradiction-detector.js** | Finds contradicting memories. Supersedes the obsolete version | Weekly |
| **dedup-supersede.js** | Detects near-duplicates by cosine similarity. Intelligent merge keeping the most complete info | Weekly |
| **cleanup-low-signal.js** | Archives low-value memories: too short, low importance, no recent access | Weekly |
| **lifecycle-run** | Promotes/degrades between tiers: hot → warm → cold based on age, access, quality | Daily |

---

## Architecture

BrainX is intentionally lightweight — no HTTP server needed. It runs as a CLI tool, a set of cron scripts, and an OpenClaw hook.

### Components

```
┌─────────────────────────────────────────────────────┐
│                   Your Agents                        │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐     │
│  │Agent1│ │Agent2│ │Agent3│ │Agent4│ │Agent5│     │
│  └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘     │
│     └────────┴────────┴────────┴────────┘           │
│                       │                              │
│              ┌────────▼────────┐                     │
│              │  BrainX Hook    │  (agent:bootstrap)  │
│              │  Auto-Inject    │                     │
│              └────────┬────────┘                     │
│                       │                              │
│              ┌────────▼────────┐                     │
│              │  BrainX CLI     │  add/search/inject  │
│              └────────┬────────┘                     │
│                       │                              │
│              ┌────────▼────────┐                     │
│              │  OpenAI API     │  embeddings         │
│              └────────┬────────┘                     │
│                       │                              │
│              ┌────────▼────────┐                     │
│              │  PostgreSQL     │                     │
│              │  + pgvector     │  vector storage     │
│              └─────────────────┘                     │
└─────────────────────────────────────────────────────┘
```

- **PostgreSQL + pgvector** — Stores memories with 1536-dimension vector embeddings for fast semantic search
- **OpenAI Embeddings API** — Generates vectors from text using `text-embedding-3-small`
- **Node.js CLI** — Lightweight command-line interface for all memory operations
- **OpenClaw Hook** — Automatically injects relevant context on every agent bootstrap
- **Cron Scripts** — 9 automated jobs for learning, curation, and maintenance

### Data Flow

1. **Add:** CLI receives content → generates embedding via OpenAI → upserts into `brainx_memories` table
2. **Search:** Query → embed → SQL with pgvector cosine distance → rank by similarity + importance + tier → return results
3. **Inject:** Same as search, but output formatted for direct LLM prompt injection with metadata headers

### Ranking Algorithm

Memories are ranked by a composite score:
- **Base:** Cosine similarity between query and memory embeddings
- **Importance boost:** `(importance / 10) × 0.25`
- **Tier adjustment:** hot +0.15, warm +0.05, cold -0.05, archive -0.10

---

## Quick Start

```bash
# 1. Install
clawhub install brainx

# 2. Setup database (after PostgreSQL + pgvector are ready)
cd ~/.openclaw/skills/brainx
cp .env.example .env
# Edit .env with your DATABASE_URL and OPENAI_API_KEY
npm install
psql $DATABASE_URL -f sql/v3-schema.sql

# 3. Verify
./brainx-v4 health

# 4. Add your first memory
./brainx-v4 add --type note --content "BrainX is now live!" --tier hot --importance 10

# 5. Search it
./brainx-v4 search --query "brainx status"

# 6. Deploy the hook (auto-injection)
mkdir -p ~/.openclaw/hooks/brainx-auto-inject
cp hook/{HOOK.md,handler.js,package.json} ~/.openclaw/hooks/brainx-auto-inject/
openclaw hooks enable brainx-auto-inject

# 7. Set up cron jobs (see SKILL.md for full schedule)
```

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `./brainx-v4 add` | Store a new memory with type, content, tier, importance, tags |
| `./brainx-v4 search` | Semantic search — find memories by meaning |
| `./brainx-v4 inject` | Search + format for direct LLM prompt injection |
| `./brainx-v4 health` | Verify database connection and system health |
| `./brainx-v4 lifecycle-run` | Run tier promotion/degradation cycle |

See [docs/CLI.md](docs/CLI.md) for full command reference with all flags and options.

---

## Configuration

See [docs/CONFIG.md](docs/CONFIG.md) for all environment variables and hook configuration options.

---

## Backup & Disaster Recovery

See [RESILIENCE.md](RESILIENCE.md) for:
- Automated backup scheduling
- Full restore procedures
- VPS migration guide
- Disaster recovery scenarios

---

## Tech Stack

- **Runtime:** Node.js 18+
- **Database:** PostgreSQL 14+ with pgvector extension
- **Embeddings:** OpenAI `text-embedding-3-small` (1536 dimensions)
- **LLM (Distiller):** gpt-4o-mini for memory extraction
- **Storage:** ~1KB per memory (text + vector + metadata)
- **Dependencies:** `pg`, `dotenv` (minimal footprint)

---

## Contributing

BrainX is the first community-built brain for OpenClaw. Contributions welcome!

1. Fork the repo
2. Create a feature branch
3. Submit a PR

---

## License

MIT — Use it, modify it, share it. Give your agents a brain. 🧠

---

**Built for the [OpenClaw](https://openclaw.ai) ecosystem. Available on [ClawHub](https://clawhub.ai).**
