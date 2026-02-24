# BrainX v4 Core (BrainX V3 Runtime)

BrainX is a **PostgreSQL + pgvector** based memory engine for multi-agent systems ([OpenClaw](https://github.com/openclaw/openclaw)).

> Naming: this repo/CLI keeps the historical `brainx-v3` name, while the current production feature set is **v4 core** (governance + observability + lifecycle, no embedding fallback).

## Status

✅ **Production Ready** — Active across all agents with shared centralized memory.  
🛡️ **Disaster Recovery** — Full backup/restore system included.  
🤖 **Auto-Injection** — Context automatically injected on agent startup.

## Features

- 🧠 **Semantic search** via OpenAI embeddings (text-embedding-3-small)
- 🗃️ **PostgreSQL + pgvector** for persistent vector storage
- 🔍 **On-demand injection** — only fetch context when relevant
- 🤖 **Multi-agent support** — all agents read/write the same database
- 📊 **Tiered memory** — hot, warm, cold, archive with importance scoring
- 🏷️ **Metadata filtering** — by context, tier, tags, agent, importance
- 🛡️ **Disaster recovery** — Complete backup/restore system
- ⚡ **Auto-inject hook** — Automatic context loading on agent bootstrap
- 🧩 **Pattern tracking** — recurring issue/pattern aggregation with promotion candidates
- ✅ **Lifecycle governance** — pending/in-progress/resolved/promoted/wont-fix states
- 📈 **Operational metrics** — query latency/result telemetry and memory KPIs

## Architecture

```
Agent A ──┐                    ┌── brainx search
Agent B ──┤── brainx CLI ──── │── brainx add
Agent C ──┤    (Node.js)       │── brainx inject
Agent D ──┘        │           └── brainx health
                   │
                   ▼
          PostgreSQL + pgvector
          (centralized memory)
```

- **Storage**: PostgreSQL with pgvector extension
- **Embeddings**: OpenAI text-embedding-3-small (1536 dimensions)
- **Search**: Cosine similarity + metadata filtering
- **Injection**: Automatic via OpenClaw hook + on-demand manual

## Quick Start

```bash
# 1. Clone
git clone https://github.com/Mdx2025/brainx-v3.git
cd brainx-v3

# 2. Install dependencies
pnpm install  # or npm install

# 3. Configure environment
cp .env.example .env
# Edit: DATABASE_URL, OPENAI_API_KEY

# 4. Setup database (requires PostgreSQL with pgvector)
psql "$DATABASE_URL" -f sql/v3-schema.sql

# 5. Verify
./brainx-v3 health
```

## Auto-Injection (New!)

BrainX V3 now includes an **OpenClaw hook** that automatically injects relevant memories when agents start:

```bash
# On every agent:bootstrap event, the hook:
# 1. Queries recent hot/warm memories from PostgreSQL
# 2. Generates BRAINX_CONTEXT.md in the workspace
# 3. Agent reads this file as part of session initialization
```

**Configuration** in `~/.openclaw/openclaw.json`:
```json
{
  "hooks": {
    "internal": {
      "entries": {
        "brainx-auto-inject": {
          "enabled": true,
          "limit": 5,
          "tier": "hot+warm",
          "minImportance": 5
        }
      }
    }
  }
}
```

## Disaster Recovery 🛡️

### Create Backup

```bash
# Full backup (database + configs + hooks)
./scripts/backup-brainx.sh ~/backups

# Output: ~/backups/brainx-v3_backup_YYYYMMDD_HHMMSS.tar.gz
```

### Restore from Backup

```bash
# On new VPS or after disaster
./scripts/restore-brainx.sh brainx-v3_backup_YYYYMMDD.tar.gz --force
```

### What's Protected?

| Component | Included | Critical? |
|-----------|----------|-----------|
| PostgreSQL database (all memories) | ✅ Yes | 🔴 CRITICAL |
| OpenClaw configuration (hooks) | ✅ Yes | 🟡 Medium |
| Environment variables (.env) | ✅ Yes | 🔴 CRITICAL |
| Skill files | ✅ Yes | 🟢 Reinstallable |
| Workspace brainx.md files | ✅ Yes | 🟢 Recreatable |
| Auto-inject hooks | ✅ Yes | 🟡 Medium |

See [RESILIENCE.md](RESILIENCE.md) for complete disaster recovery documentation.

## OpenClaw Integration

BrainX V3 works as a native **OpenClaw skill**:

```bash
# Install as skill
cp -r brainx-v3 ~/.openclaw/skills/brainx-v3

# Add to PATH in openclaw.json
# "env": { "PATH": "/home/clawd/.openclaw/skills/brainx-v3:$PATH" }

# Add DATABASE_URL to openclaw.json env
# "DATABASE_URL": "postgresql://brainx:pass@127.0.0.1:5432/brainx_v3"

# Now all agents can use: brainx search, brainx add, brainx inject
```

The `SKILL.md` file provides OpenClaw with tool definitions (`brainx_add_memory`, `brainx_search`, `brainx_inject`, `brainx_health`).

## CLI Reference

## BrainX V4 Core Upgrades

BrainX v4 adds governance and operational controls on top of the existing OpenAI-only embedding flow (no provider fallback changes).

### New memory lifecycle metadata

- `status`: `pending | in_progress | resolved | promoted | wont_fix`
- `category`: `learning | error | feature_request | correction | knowledge_gap | best_practice`
- Pattern fields: `pattern_key`, `recurrence_count`, `first_seen`, `last_seen`
- Resolution fields: `resolved_at`, `promoted_to`, `resolution_notes`

### New commands

- `resolve` — update lifecycle status + resolution metadata for a memory (or all memories by `pattern_key`)
- `promote-candidates` — list recurring patterns ready for promotion (default `recurrence >= 3` in `30` days)
- `lifecycle-run` — auto-promote/degrade memories using recency + recurrence + access/importance thresholds
- `metrics` — operational KPIs (counts by status/category/tier, top recurring patterns, query telemetry)

### Phase 2 store controls (pre-store scrub + semantic dedupe)

- PII scrub before embedding/storage (default enabled): emails, phone numbers, common API/token formats
- Config:
  - `BRAINX_PII_SCRUB_ENABLED=true`
  - `BRAINX_PII_SCRUB_REPLACEMENT=[REDACTED]`
- Redaction metadata is recorded on stored rows via tags such as `pii:redacted`, `pii:email`
- Semantic dedupe merge (same `context`/`category`, recent window) avoids noisy duplicates and increments recurrence on the matched record
  - `BRAINX_DEDUPE_SIM_THRESHOLD=0.92` (default)

### Example: Add recurring pattern memory

```bash
./brainx-v3 add \
  --type learning \
  --content "Retry loop silently swallowed 429s" \
  --context api-worker \
  --tier warm \
  --importance 8 \
  --status pending \
  --category error \
  --patternKey retry.429.swallow \
  --tags retry,rate-limit
```

### Example: Resolve or promote a pattern

```bash
# Resolve one memory
./brainx-v3 resolve --id m_123 --status resolved --resolutionNotes "Patched retry backoff"

# Promote all matching pattern memories to an ops runbook
./brainx-v3 resolve \
  --patternKey retry.429.swallow \
  --status promoted \
  --promotedTo docs/runbooks/retry.md \
  --resolutionNotes "Captured standard retry policy"
```

### Example: Promote candidates and metrics

```bash
./brainx-v3 promote-candidates --json
./brainx-v3 lifecycle-run --dryRun --json
./brainx-v3 lifecycle-run --json
./brainx-v3 metrics --days 30 --topPatterns 10 --json
```

### Offline evaluation harness (Phase 2)

Use a small JSON/JSONL dataset of `query` + `expected_key` pairs to track retrieval quality over time.

```bash
npm run eval:memory-quality -- --json
```

Sample dataset: `tests/fixtures/memory-eval-sample.jsonl`

Real dataset seed (from current memories):

```bash
npm run eval:build-real-dataset
node ./scripts/eval-memory-quality.js --dataset ./tests/fixtures/memory-eval-real.jsonl --k 5 --json
```

Reported proxy metrics include:

- `hit_at_k_proxy`
- `avg_top_similarity`
- `duplicates_reduced` (top-k duplicate collapse by `pattern_key`)

## Operations Automation (Production)

Scripts:
- `cron/ops-alerts.sh` → daily operational alerts summary
- `cron/weekly-dashboard.sh` → weekly 7-day trends dashboard
- `cron/health-check.sh` → low-level health check for DB/pgvector

Recommended OpenClaw crons:
- Daily ops alerts
- Weekly dashboard (Mondays)
- Daily lifecycle-run + report
- One-shot 48h dedupe-threshold review when tuning

### Health Check
```bash
./brainx-v3 health
# BrainX V3 health: OK
# - pgvector: yes
# - brainx tables: 6
```

### Add Memory
```bash
./brainx-v3 add --type decision \
  --content "Use embeddings-3-small to reduce costs" \
  --context "openclaw" \
  --tier hot \
  --importance 9 \
  --tags config,openai \
  --agent coder
```

**Types:** `decision`, `action`, `note`, `learning`, `gotcha`  
**Tiers:** `hot`, `warm`, `cold`, `archive`

### Search Memories
```bash
./brainx-v3 search --query "deployment strategy" \
  --limit 10 \
  --minSimilarity 0.15 \
  --context project-x \
  --tier hot
```

### Inject Context (Prompt-Ready)
```bash
./brainx-v3 inject --query "what did we decide?" --limit 8
```

BrainX v4 inject adds low-noise guardrails:

- minimum score gate (default `0.25`, override with `--minScore` / `BRAINX_INJECT_MIN_SCORE`)
- max total output chars (default `12000`, override with `--maxTotalChars` / `BRAINX_INJECT_MAX_TOTAL_CHARS`)

Output format (ready to paste into LLM prompts):
```
[sim:0.82 imp:9 tier:hot type:decision agent:coder ctx:openclaw]
Use embeddings-3-small to reduce costs...

---

[sim:0.41 imp:6 tier:warm type:note agent:writer ctx:project-x]
Another memory...
```

## Injection Limits

To prevent prompt bloat:

| Limit | Default | Env Override | Flag Override |
|-------|---------|--------------|---------------|
| Max chars per item | 2000 | `BRAINX_INJECT_MAX_CHARS_PER_ITEM` | `--maxCharsPerItem` |
| Max lines per item | 80 | `BRAINX_INJECT_MAX_LINES_PER_ITEM` | `--maxLinesPerItem` |
| Max total output chars | 12000 | `BRAINX_INJECT_MAX_TOTAL_CHARS` | `--maxTotalChars` |
| Min score gate | 0.25 | `BRAINX_INJECT_MIN_SCORE` | `--minScore` |

## When to Use

✅ **DO use when:**
- User references past decisions
- Resuming long-running tasks
- "What did we decide about X?"
- Need context from previous work
- Sharing knowledge between agents

❌ **DON'T use when:**
- Simple isolated questions
- General knowledge queries
- Code review without context needs
- Every message "just in case"

## Repository Layout

```
brainx-v3/
├── brainx-v3              # CLI entry point (bash)
├── brainx                 # Wrapper for PATH usage
├── SKILL.md               # OpenClaw skill definition
├── RESILIENCE.md          # 🛡️ Disaster recovery guide
├── lib/
│   ├── cli.js             # Command implementations
│   ├── openai-rag.js      # Embeddings + vector search
│   └── db.js              # PostgreSQL connection pool
├── hook/                  # 🆕 OpenClaw auto-inject hook
│   ├── HOOK.md            # Hook documentation
│   └── inject.sh          # Hook script
├── scripts/               # Utilities
│   ├── backup-brainx.sh   # 🆕 Backup script
│   ├── restore-brainx.sh  # 🆕 Restore script
│   └── migrate-v2-to-v3.js
├── sql/
│   └── v3-schema.sql      # Database schema (6 tables)
├── docs/                  # Architecture documentation
└── tests/                 # Test suite
```

## Database Schema

8+ tables (v4 adds pattern + query log tables):

| Table | Purpose |
|-------|---------|
| `brainx_memories` | Main memory store with embeddings |
| `brainx_learning_details` | Extended learning metadata |
| `brainx_trajectories` | Agent action trajectories |
| `brainx_context_packs` | Bundled context snapshots |
| `brainx_session_snapshots` | Session summaries |
| `brainx_pilot_log` | Audit/pilot log |
| `brainx_patterns` | Recurring pattern aggregation + promotion tracking |
| `brainx_query_log` | Search/inject telemetry (duration/results/similarity) |

## Environment Variables

```bash
# Required
DATABASE_URL=postgresql://user:pass@host:5432/brainx_v3
OPENAI_API_KEY=sk-...

# Optional
OPENAI_EMBEDDING_MODEL=text-embedding-3-small       # default
OPENAI_EMBEDDING_DIMENSIONS=1536                     # default
BRAINX_INJECT_MAX_CHARS_PER_ITEM=2000
BRAINX_INJECT_MAX_LINES_PER_ITEM=80
BRAINX_INJECT_DEFAULT_TIER=warm_or_hot
BRAINX_PII_SCRUB_ENABLED=true
BRAINX_PII_SCRUB_REPLACEMENT=[REDACTED]
BRAINX_PII_SCRUB_ALLOWLIST_CONTEXTS=internal-safe,trusted
BRAINX_DEDUPE_SIM_THRESHOLD=0.55
BRAINX_DEDUPE_RECENT_DAYS=30
```

## Upgrading from V2

```bash
node scripts/migrate-v2-to-v3.js
```

## Automatic Backups (Recommended)

Add to `crontab -e`:

```bash
# Daily backup at 3 AM
0 3 * * * /path/to/brainx-v3/scripts/backup-brainx.sh /path/to/backups >> /path/to/backups/backup.log 2>&1

# Clean old backups (keep 7 days)
0 4 * * * find /path/to/backups -name "brainx-v3_backup_*.tar.gz" -mtime +7 -delete
```

## License

MIT
