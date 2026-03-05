---
name: brainx
description: |
  The First Brain for OpenClaw. Your agents forget everything after each session — BrainX fixes that permanently.
  Persistent vector memory powered by PostgreSQL + pgvector + OpenAI embeddings.
  One shared brain for all your agents. One learns, they all benefit. A hive mind that grows smarter with every conversation.
metadata:
  openclaw:
    emoji: "🧠"
    requires:
      bins: ["psql"]
      env: ["DATABASE_URL", "OPENAI_API_KEY"]
    primaryEnv: "DATABASE_URL"
    hooks:
      - name: brainx-auto-inject
        event: agent:bootstrap
        description: Auto-injects relevant vector memories when an agent starts a session
user-invocable: true
---

# 🧠 BrainX — The First Brain for OpenClaw

**Your AI agents are born with amnesia.** Every session starts from zero. Every decision forgotten. Every lesson lost. Every preference — gone.

BrainX changes that. It's a persistent vector memory engine that gives your OpenClaw agents a **real brain** — one that remembers across sessions, learns automatically from every conversation, and shares knowledge between all your agents like a hive mind.

Install it once. Your agents remember forever.

---

## What Makes BrainX Different

| Feature | What it does |
|---------|-------------|
| 🧠 **Persistent Memory** | Memories survive across sessions — stored in PostgreSQL + pgvector |
| 🤝 **Hive Mind** | All agents share one brain. One agent learns → every agent benefits |
| 📥 **Auto-Learning** | Learns from every conversation automatically — zero manual work |
| 🔎 **Semantic Search** | Find memories by meaning, not keywords. Powered by OpenAI embeddings |
| 💉 **Auto-Injection** | Relevant context injected into every agent session automatically |
| 🏷️ **Smart Classification** | Auto-types memories: facts, decisions, learnings, gotchas, notes |
| 📊 **Priority Tiers** | Hot/warm/cold tiers — auto-promotes and degrades based on usage |
| 🤝 **Cross-Agent Learning** | Propagates important discoveries to all agents automatically |
| 🔄 **Deduplication** | Semantic dedup by cosine similarity with intelligent merge |
| ⚡ **Contradiction Detection** | Finds conflicting memories and supersedes the obsolete one |
| 🔒 **PII Scrubbing** | Auto-redacts sensitive data (API keys, emails, phone numbers) before storage |
| 🔮 **Pattern Detection** | Detects recurring patterns and auto-promotes them |
| 📋 **Session Indexing** | Searches past conversations (30-day retention) |
| ⭐ **Quality Scoring** | Evaluates memory quality and promotes/degrades based on score |
| 📌 **Fact Extraction** | Regex extracts URLs, repos, ports, branches, configs from sessions |
| 📦 **Context Packs** | Weekly context packages per project and per agent |
| 🔍 **Telemetry** | Injection logs + query performance + operational metrics |
| 🔗 **Supersede Chains** | Obsolete memories marked, never deleted — full history preserved |
| 🧬 **Memory Distiller** | LLM extracts structured memories from session logs every 6h |
| 🛡️ **Disaster Recovery** | Full backup/restore (DB + configs + hooks + workspaces) |
| 💾 **Production Tested** | Battle-tested with 9+ agents running 24/7 |

---

## Prerequisites

Before installing BrainX, you need:

- **OpenClaw** — running instance with at least one agent
- **PostgreSQL 14+** — with the `pgvector` extension
- **Node.js 18+** — for the CLI and scripts
- **OpenAI API Key** — for generating embeddings (`text-embedding-3-small`)

---

## Installation

### Step 1: Install from ClawHub

```bash
clawhub install brainx
```

This installs BrainX into `~/.openclaw/skills/brainx/`.

### Step 2: Set Up PostgreSQL + pgvector

If you don't have PostgreSQL with pgvector yet:

```bash
# Ubuntu/Debian
sudo apt install postgresql postgresql-contrib

# Install pgvector extension
sudo apt install postgresql-16-pgvector
# Or compile from source: https://github.com/pgvector/pgvector
```

### Step 3: Create Database and User

```bash
sudo -u postgres psql
```

```sql
CREATE USER brainx WITH PASSWORD 'your-secure-password';
CREATE DATABASE brainx_v4 OWNER brainx;
\c brainx_v4
CREATE EXTENSION vector;
GRANT ALL ON ALL TABLES IN SCHEMA public TO brainx;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO brainx;
```

### Step 4: Run the Schema

```bash
cd ~/.openclaw/skills/brainx

# Core schema (tables, indexes, vector columns)
psql postgresql://brainx:your-secure-password@127.0.0.1:5432/brainx_v4 -f sql/v3-schema.sql

# Phase 2 governance (telemetry, pilot log)
psql postgresql://brainx:your-secure-password@127.0.0.1:5432/brainx_v4 -f sql/003_create_pilot_log_telemetry.sql
psql postgresql://brainx:your-secure-password@127.0.0.1:5432/brainx_v4 -f sql/migrations/2026-02-24_phase2_governance.sql
```

### Step 5: Configure Environment

```bash
cd ~/.openclaw/skills/brainx
cp .env.example .env
```

Edit `.env`:

```bash
# Required
DATABASE_URL=postgresql://brainx:your-secure-password@127.0.0.1:5432/brainx_v4
OPENAI_API_KEY=sk-your-openai-api-key

# Optional (defaults shown)
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_EMBEDDING_DIMENSIONS=1536
OPENAI_REASONING_MODEL=gpt-4o-mini
```

### Step 6: Install Dependencies

```bash
cd ~/.openclaw/skills/brainx
npm install
```

### Step 7: Verify Installation

```bash
cd ~/.openclaw/skills/brainx
./brainx-v4 health
```

You should see: `✅ BrainX V4 is healthy` with database connection confirmed.

Test adding a memory:

```bash
./brainx-v4 add --type note --content "BrainX installation successful" --tier hot --importance 8
```

Test searching:

```bash
./brainx-v4 search --query "installation" --limit 5
```

---

## Hook Setup (Auto-Injection)

The hook automatically injects relevant memories into every agent session on startup. This is the magic that makes agents "remember."

### Deploy the Hook

```bash
mkdir -p ~/.openclaw/hooks/brainx-auto-inject
cp ~/.openclaw/skills/brainx/hook/{HOOK.md,handler.js,package.json} ~/.openclaw/hooks/brainx-auto-inject/
openclaw hooks enable brainx-auto-inject
```

### Configure in openclaw.json

Add to your `~/.openclaw/openclaw.json`:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "brainx-auto-inject": {
          "enabled": true,
          "limit": 8,
          "tier": "hot+warm",
          "minImportance": 5
        }
      }
    }
  }
}
```

### How It Works

1. Agent starts a session → `agent:bootstrap` event fires
2. Hook queries BrainX DB → fetches top hot/warm memories (importance ≥ 5)
3. Appends a `<!-- BRAINX:START -->` section to your workspace `MEMORY.md`
4. Agent reads MEMORY.md → relevant context is available from the first message
5. Telemetry logged → tracks injection stats and performance

**Result:** Every agent wakes up with context from previous sessions. No manual work needed.

---

## Cron Jobs (Auto-Learning System)

BrainX learns automatically through scheduled jobs. These convert every conversation into persistent, shared knowledge.

### Recommended Cron Schedule

Add these to your system crontab (`crontab -e`) or OpenClaw cron:

```bash
# ═══════════════════════════════════════════════════
# BrainX Auto-Learning Cron Jobs
# ═══════════════════════════════════════════════════

# Memory Distiller — LLM extracts memories from session logs
# Runs every 6 hours. Uses gpt-4o-mini to read full session transcripts
# and extract decisions, preferences, facts, and learnings.
0 */6 * * * cd ~/.openclaw/skills/brainx && node scripts/memory-distiller.js >> cron/cron-output.log 2>&1

# Memory Bridge — Syncs markdown files to vector DB
# Runs every 6 hours. Reads memory/*.md files from workspaces
# and imports them as searchable vector memories.
30 */6 * * * cd ~/.openclaw/skills/brainx && node scripts/memory-bridge.js >> cron/cron-output.log 2>&1

# Session Harvester — Regex fallback for memory extraction
# Runs every 12 hours. Uses heuristics to classify conversations
# and capture operational context that the LLM might miss.
0 */12 * * * cd ~/.openclaw/skills/brainx && node scripts/session-harvester.js >> cron/cron-output.log 2>&1

# Lifecycle Daily — Tier management + metrics
# Runs daily at 9:30 AM. Promotes/degrades memories between tiers
# (hot → warm → cold) based on age, access frequency, and quality.
30 9 * * * cd ~/.openclaw/skills/brainx && ./brainx-v4 lifecycle-run >> cron/cron-output.log 2>&1

# Cross-Agent Learning — Propagate knowledge between agents
# Runs Mon + Thu at 4:00 AM. When one agent discovers something important
# (gotcha, learning, correction), it gets shared with ALL other agents.
0 4 * * 1,4 cd ~/.openclaw/skills/brainx && node scripts/cross-agent-learning.js >> cron/cron-output.log 2>&1

# Contradiction Detector — Find and resolve conflicting memories
# Runs Sunday at 3:00 AM. Detects memories that contradict each other
# and supersedes the obsolete version.
0 3 * * 0 cd ~/.openclaw/skills/brainx && node scripts/contradiction-detector.js >> cron/cron-output.log 2>&1

# Quality Scorer — Evaluate and rank memories
# Runs daily at 2:00 AM. Scores memories on specificity, actionability,
# and relevance. Promotes high-quality, degrades low-quality.
0 2 * * * cd ~/.openclaw/skills/brainx && node scripts/quality-scorer.js >> cron/cron-output.log 2>&1

# Dedup + Cleanup — Remove duplicates and low-signal noise
# Runs weekly on Saturday at 1:00 AM.
0 1 * * 6 cd ~/.openclaw/skills/brainx && node scripts/dedup-supersede.js && node scripts/cleanup-low-signal.js >> cron/cron-output.log 2>&1

# Health Check — Verify BrainX is operational
# Runs every 30 minutes. Checks DB connection and basic functionality.
*/30 * * * * cd ~/.openclaw/skills/brainx && bash cron/health-check.sh >> cron/health.log 2>&1
```

### What Each Job Does

| Job | Frequency | Description |
|-----|-----------|-------------|
| **Memory Distiller** | Every 6h | LLM reads session transcripts and extracts structured memories (decisions, facts, preferences, learnings) |
| **Memory Bridge** | Every 6h | Syncs `memory/*.md` markdown files from agent workspaces into the vector database |
| **Session Harvester** | Every 12h | Regex + heuristics extract operational data (URLs, repos, ports, configs) from sessions |
| **Lifecycle** | Daily 9:30 AM | Promotes/degrades memories between hot/warm/cold tiers based on usage patterns |
| **Cross-Agent Learning** | Mon + Thu 4 AM | Propagates important gotchas and learnings from one agent to all others |
| **Contradiction Detector** | Sunday 3 AM | Finds contradicting memories and supersedes the outdated one |
| **Quality Scorer** | Daily 2 AM | Rates memories on multiple dimensions, promotes good ones, degrades bad ones |
| **Dedup + Cleanup** | Saturday 1 AM | Merges duplicates, archives low-signal memories |
| **Health Check** | Every 30 min | Verifies database connectivity and basic operations |

---

## CLI Usage

### Add a Memory

```bash
./brainx-v4 add \
  --type decision \
  --content "Use text-embedding-3-small to reduce API costs by 5x" \
  --tier hot \
  --importance 9 \
  --tags "config,openai,cost" \
  --context "infrastructure"
```

**Types:** `note`, `decision`, `action`, `learning`, `gotcha`, `feature_request`
**Tiers:** `hot` (always available), `warm` (recent), `cold` (archived), `archive` (deep storage)
**Importance:** 1-10 (10 = critical)

### Search by Meaning

```bash
./brainx-v4 search --query "how did we configure the API" --limit 5 --minSimilarity 0.5
```

Returns JSON with similarity scores, metadata, and content.

### Inject into LLM Context

```bash
./brainx-v4 inject --query "deployment decisions" --limit 3 --tier hot
```

Returns prompt-ready formatted text:

```
[sim:0.82 imp:9 tier:hot type:decision agent:coder ctx:infrastructure]
Use text-embedding-3-small to reduce API costs by 5x...

---

[sim:0.71 imp:8 tier:hot type:learning agent:main ctx:deploy]
Railway CLI v4.29 requires --detach for background deploys...
```

### Health Check

```bash
./brainx-v4 health
```

Verifies PostgreSQL connection, pgvector extension, and table integrity.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Your Agents                        │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐     │
│  │Agent1│ │Agent2│ │Agent3│ │Agent4│ │Agent5│     │
│  └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘     │
│     │        │        │        │        │           │
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

- **PostgreSQL + pgvector** — stores memories with 1536-dimension vector embeddings
- **OpenAI Embeddings API** — generates vectors from text (`text-embedding-3-small`)
- **Node.js CLI** — lightweight CLI for add/search/inject operations
- **OpenClaw Hook** — auto-injects relevant context on every agent bootstrap
- **Cron Scripts** — automated learning, curation, and maintenance

---

## Configuration Reference

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string: `postgresql://user:pass@host:5432/brainx_v4` |
| `OPENAI_API_KEY` | OpenAI API key for embeddings generation |

### Optional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model to use |
| `OPENAI_EMBEDDING_DIMENSIONS` | `1536` | Vector dimensions (must match schema) |
| `OPENAI_REASONING_MODEL` | `gpt-4o-mini` | Model for Memory Distiller LLM extraction |
| `BRAINX_ENV` | — | Path to shared env file for multi-process setups |
| `BRAINX_INJECT_DEFAULT_TIER` | `warm_or_hot` | Default tier filter for inject command |
| `BRAINX_INJECT_MAX_CHARS_PER_ITEM` | `2000` | Max characters per memory in inject output |
| `BRAINX_INJECT_MAX_LINES_PER_ITEM` | `80` | Max lines per memory in inject output |
| `BRAINX_DEDUPE_SIM_THRESHOLD` | `0.55` | Cosine similarity threshold for deduplication |

### Hook Configuration (openclaw.json)

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "brainx-auto-inject": {
          "enabled": true,
          "limit": 8,
          "tier": "hot+warm",
          "minImportance": 5
        }
      }
    }
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `limit` | `8` | Max memories to inject per session |
| `tier` | `hot+warm` | Which tiers to pull from |
| `minImportance` | `5` | Minimum importance score (1-10) |

---

## Backup & Recovery

### Create a Backup

```bash
cd ~/.openclaw/skills/brainx
./scripts/backup-brainx.sh ~/backups
```

Creates `brainx-v4_backup_YYYYMMDD_HHMMSS.tar.gz` containing:
- Full PostgreSQL database dump (all memories with embeddings)
- Configuration files (hooks, .env)
- Skill files and scripts

### Restore from Backup

```bash
cd ~/.openclaw/skills/brainx
./scripts/restore-brainx.sh ~/backups/brainx-v4_backup_YYYYMMDD_HHMMSS.tar.gz --force
```

Full restore including all memories, embeddings, and configuration.

See [RESILIENCE.md](RESILIENCE.md) for complete disaster recovery scenarios, VPS migration guide, and automated backup scheduling.

---

## The Hive Mind: Multi-Agent Shared Intelligence

When you run multiple OpenClaw agents, BrainX becomes a **hive mind**:

- **Shared Memory Pool** — All agents read and write to the same PostgreSQL database
- **Cross-Agent Learning** — When Agent A discovers a gotcha, the cron job propagates it to Agents B, C, D, E...
- **Context Isolation** — Each memory has an `agent` and `context` field for filtering, but the knowledge is accessible to all
- **Collective Intelligence** — The more agents you run, the faster the brain grows. Every conversation from every agent feeds the shared pool.

**Example:** Your "Coder" agent discovers that a CLI tool requires a specific flag. BrainX:
1. Stores the learning with `agent=coder`, `type=gotcha`
2. Cross-Agent Learning propagates it to all other agents
3. Next time your "DevOps" agent starts a session, the gotcha is auto-injected
4. Nobody makes that mistake again

---

## Docs

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — Technical deep-dive into components and data flow
- [CLI.md](docs/CLI.md) — Full CLI reference
- [CONFIG.md](docs/CONFIG.md) — All configuration options
- [SCHEMA.md](docs/SCHEMA.md) — Database schema reference
- [SCRIPTS.md](docs/SCRIPTS.md) — Documentation for all maintenance scripts
- [RESILIENCE.md](RESILIENCE.md) — Backup, restore, disaster recovery
- [HOOK.md](hook/HOOK.md) — Auto-injection hook documentation

---

## License

MIT — Use it, modify it, share it. Give your agents a brain. 🧠
