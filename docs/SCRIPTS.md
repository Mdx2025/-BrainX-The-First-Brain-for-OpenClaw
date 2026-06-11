# Scripts

This folder contains one-shot utilities for migration, imports, and cleanup.

All scripts use `dotenv/config`, so they read `.env` automatically.

Operational truth is split:

- `docs/RUNTIME_STATUS.md` is the human-readable source of truth
- `config/surface-policy.json` is the machine-readable policy used by `doctor`
- `/home/clawd/.openclaw/skills/brainx/cron/brainx-daily-core-wrapper.sh` is the active consolidated scheduler

If a script exists here, that does not mean it is active in production on this host.

## `scripts/migrate-v2-to-v3.js`

Migrates BrainX V2 JSON storage (files) into the V3 Postgres database.

### What it does

- Looks for V2 storage under `${BRAINX_LEGACY_HOME}/storage/<tier>/*.json`
  - tiers scanned: `hot`, `warm`, `cold`
- For each file:
  - parses JSON
  - generates a stable id if missing
  - maps tier into V3 tiers
  - calls `rag.storeMemory()` to upsert into Postgres
  - if V2 has `timestamp`, it preserves it by updating `created_at` and `last_accessed`

### Env

- `BRAINX_LEGACY_HOME` (optional)
  - default: `../../brainx` relative to this repo

### Run

```bash
node scripts/migrate-v2-to-v3.js
```

## `scripts/import-workspace-memory-md.js`

Imports a `MEMORY.md` style file into V3.

### What it does

- Reads a file path (`MEMORY_MD`), defaulting to `../../../MEMORY.md`
- Splits it into ~5000 char chunks
- Stores each chunk as a `note` memory:
  - `tier=hot`, `importance=9`, `agent=system`
  - tags: `import:memory-md`, `source:workspace-coder`

### Env

- `MEMORY_MD` (optional)

### Run

```bash
node scripts/import-workspace-memory-md.js
```

## `scripts/import-knowledge-md.js`

Imports curated documents from `knowledge/` into BrainX without mixing them with `memory/*.md`.

### What it does

- Scans `knowledge/<domain>/**/*.md`
- Skips `README.md`, `INDEX.md`, and files prefixed with `_`
- Treats canonical docs as stronger provenance than raw markdown logs
- Marks removed chunks from a re-imported source file as `obsolete`

### Run

```bash
# canonical only
node scripts/import-knowledge-md.js

# preview one domain
node scripts/import-knowledge-md.js --domain development --dry-run --verbose
```

## `scripts/knowledge-sync.js`

High-level sync for `knowledge/`.

### What it does

- Detects manual changes in canonical knowledge docs
- Runs the importer only when needed
- Refreshes the BrainX auto block afterwards
- Stores sync state so cron can no-op cleanly when nothing changed

### Run

```bash
node scripts/knowledge-sync.js
node scripts/knowledge-sync.js --dry-run --json
```

## `scripts/knowledge-locate.js`

Finds the canonical `knowledge/` docs an agent should read in full for a concrete task.

### What it does

- Runs one semantic query against BrainX
- Keeps only `knowledge_canonical` hits
- Groups them by source file
- Ranks the best files to read first
- Returns exact file paths plus short supporting snippets

### Run

```bash
node scripts/knowledge-locate.js --query "draft a sponsorship reply"
node scripts/knowledge-locate.js --query "prepare a premium website proposal" --json
```

## `scripts/new-knowledge-topic.js`

Scaffolds a canonical knowledge topic file with manual sections plus the BrainX auto block markers.

### Run

```bash
node scripts/new-knowledge-topic.js --category development --name nextjs-server-actions
node scripts/new-knowledge-topic.js --category branding --name mdx-voice --title "MDX Voice"
```

## `scripts/sync-knowledge-auto-blocks.js`

Refreshes only the `BRAINX:AUTO` block inside canonical knowledge docs.

### Run

```bash
node scripts/sync-knowledge-auto-blocks.js
node scripts/sync-knowledge-auto-blocks.js --domain development --dry-run --verbose
```

## `scripts/seed-knowledge-library.js`

Creates realistic starter topics across the knowledge taxonomy.

### Run

```bash
# preview
node scripts/seed-knowledge-library.js --dry-run

# create missing seed topics
node scripts/seed-knowledge-library.js
```

## `scripts/dedup-supersede.js`

Supersedes exact duplicates (same type/content/context/agent).

### What it does

- Finds duplicates by fingerprint:
  - `md5(type|content|context|agent)`
- Keeps the oldest `created_at`
- Updates newer duplicates:
  - `superseded_by = keep_id`
  - appends tag `dedup_superseded`

### Env

- `DEDUP_DRY_RUN=true` to preview without writing.

### Run

```bash
# preview
DEDUP_DRY_RUN=true node scripts/dedup-supersede.js

# apply
node scripts/dedup-supersede.js
```

## `scripts/cleanup-low-signal.js`

Downranks or re-tiers very short/low-signal memories.

### What it does

- For memories not superseded:
  - if `length(content) <= CLEANUP_MAX_LEN`
  - and type in `decision|action|learning|note`
- then:
  - sets `tier=CLEANUP_TIER` (default `cold`)
  - clamps `importance` to `<= CLEANUP_MAX_IMPORTANCE` (default `2`)
  - adds tag `low_signal`

### Env

- `CLEANUP_MAX_LEN` (default `12`)
- `CLEANUP_TIER` (default `cold`)
- `CLEANUP_MAX_IMPORTANCE` (default `2`)

### Run

```bash
node scripts/cleanup-low-signal.js
```

Current host state: implemented, but not part of the active daily/midweek/Sunday wrapper.

## `scripts/learning-detail-extractor.js`

Extracts extended metadata for `learning` and `gotcha` memories into `brainx_learning_details`.

### Current host state

- Implemented
- Not scheduled in the active daily/midweek/Sunday wrapper
- Treated as `dormant` in `config/surface-policy.json`

### Run

```bash
node scripts/learning-detail-extractor.js --verbose
node scripts/learning-detail-extractor.js --agent coder --verbose
```

## `scripts/session-snapshot.js`

Captures structured session state for handoff and recall.

### Current host state

- Implemented
- Scheduled every 4h through `BrainX Session Snapshot`
- Wrapped by `/home/clawd/.openclaw/skills/brainx/cron/brainx-session-snapshot-cron.sh`
- Followed immediately by `handoff-promoter.js`
- Treated as `active` in `config/surface-policy.json`

### Run

```bash
node scripts/session-snapshot.js --agent coder --session-id abc123
```

## `scripts/handoff-promoter.js`

Promotes high-signal session snapshots into durable memories and artifact ledger rows.

### Current host state

- Implemented
- Scheduled every 4h after `session-snapshot.js`
- Also runs daily inside `brainx-daily-core-wrapper.sh`
- Writes hot facts/actions to `brainx_memories`
- Upserts durable paths to `brainx_artifact_ledger`
- Writes artifact v2 fields: `artifact_role=final_deliverable`, `provenance=promoted_handoff`, `finality_score=0.95`, and snapshot metadata
- Filters `/tmp`, credentials/tokens/passwords, and system agents such as `alert`, `monitor`, and `heartbeat`

### Run

```bash
node scripts/handoff-promoter.js --hours 24 --limit 30 --json
node scripts/handoff-promoter.js --hours 48 --limit 50 --dry-run --json
```

## `scripts/trajectory-recorder.js`

Extracts problem to solution trajectories into `brainx_trajectories`.

### Current host state

- Implemented
- Scheduled daily as step 13 of `brainx-daily-core-wrapper.sh`
- Treated as `active` in `config/surface-policy.json`

### Run

```bash
node scripts/trajectory-recorder.js --hours 24 --max-sessions 10
```

## `scripts/calibrate-verification-state.js`

Promotes only durable `changelog` memories to `verified` using conservative heuristics.

### What it does

- Scans `fact|decision|gotcha` memories with `verification_state='changelog'`
- Rejects temporal or changelog-like entries
- Promotes only durable operational memories
- Tags promoted rows with `calibrated_verified`

### Run

```bash
# preview
node scripts/calibrate-verification-state.js --json

# apply
node scripts/calibrate-verification-state.js --apply --json
```

## `scripts/calibrate-sensitivity.js`

Backfills `sensitivity` for already-stored memories using current redaction tags and credential heuristics.

### What it does

- Scans existing memories, defaulting to rows still marked `normal`
- Re-derives the safe sensitivity level from:
  - existing `pii:*` tags
  - redaction markers
  - credential/login wording in the stored content
- Updates rows to `sensitive` or `restricted` when needed

### Run

```bash
# preview
node scripts/calibrate-sensitivity.js --json

# apply
node scripts/calibrate-sensitivity.js --apply --json
```

## `scripts/cleanup-promotion-suggestions.js`

Marks low-signal or duplicate `promotion-suggestion` memories as `wont_fix` so they do not reach `promotion-applier.js`.

### What it does

- Scans pending memories tagged `promotion-suggestion`
- Rejects JSON blobs, temporal facts, article/report status, nested/truncated rules, and duplicates of either already promoted suggestions or the canonical sink itself
- Marks rejected suggestions as `status='wont_fix'` and `verification_state='obsolete'`

### Run

```bash
# preview
node scripts/cleanup-promotion-suggestions.js --json

# apply
node scripts/cleanup-promotion-suggestions.js --apply --json
```

## `scripts/cleanup-snapshots-trajectories.js`

Weekly retention sweep for the two long-lived secondary tables that previously had zero retention policy.

### What it does

- **`brainx_session_snapshots` purge by age**: drops rows older than `--max-age-days` (default 30). Snapshots with `status IN ('blocked','critical')` get 2x age budget (default 60d) — they hold unresolved-blocker context that may still be relevant.
- **`brainx_session_snapshots` dedup**: within `(agent, project, DATE(session_end))`, keeps newest row. The same session re-snapshotted hourly while open would otherwise accumulate ~6-24 dups per day per session.
- **`brainx_trajectories` purge**: drops rows with `times_used = 0 AND created_at < now() - --trajectory-max-age-days` (default 60). Used trajectories (`times_used > 0`) are kept indefinitely — they've proven valuable.

### Run

```bash
# preview (no mutation)
node scripts/cleanup-snapshots-trajectories.js --dry-run

# apply
node scripts/cleanup-snapshots-trajectories.js

# verbose
node scripts/cleanup-snapshots-trajectories.js --verbose

# custom thresholds
node scripts/cleanup-snapshots-trajectories.js --max-age-days 14 --trajectory-max-age-days 30
```

### Output (JSON)

```json
{
  "dryRun": false,
  "config": { "maxAgeDays": 30, "trajectoryMaxAgeDays": 60 },
  "before": { "snapshots": 92, "trajectories": 91 },
  "purgedOldSnapshots": 18,
  "dedupedSnapshots": 34,
  "purgedUnusedTrajectories": 0,
  "errors": [],
  "after": { "snapshots": 40, "trajectories": 91 },
  "totalRemoved": 52,
  "status": "ok"
}
```

`status` is `ok` (changes), `noop` (nothing to clean), or `error` (any step failed; partial results in `errors[]`).

### Schedule

Wrapped by `/home/clawd/.openclaw/skills/brainx/cron/brainx-cleanup-cron.sh`.
In the current OpenClaw scheduler it runs as the Sunday cleanup step inside `BrainX Maintenance`; legacy `workspace/scripts/brainx-cleanup-cron.sh` is a symlink kept for rollback compatibility.

### Idempotency

Safe to run multiple times. The second run reports `noop` if the first cleared everything.

## `scripts/dedup-supersede.js`

Hash-fingerprint exact-duplicate detector and supersede operator. Marks exact duplicates (same `type + content + context + agent` after md5 hash) as `superseded_by` the oldest row in the group.

### What it does

- Computes `md5(type || '|' || content || '|' || context || '|' || agent)` per row where `superseded_by IS NULL`.
- Groups by fingerprint; if a group has >1 rows, all-but-the-oldest are flagged.
- Newest copies receive `superseded_by = oldest_id` and tag `dedup_superseded`.

### Run

```bash
# preview
node scripts/dedup-supersede.js --dry-run

# apply
node scripts/dedup-supersede.js
```

### Schedule

Daily V5 wrapper, Sunday block (step 20). Runs after `memory-audit`.

### Idempotency

Safe to run multiple times. Already-superseded rows are filtered out.

### Why it survives the router migration

The LLM router (gpt-5-nano) can return 2 IDs that both pass `filterRecallRows` — if both rows are exact duplicates, the router has no way to know that. Keeping the corpus deduplicated at the source is the cleaner solution than asking the router to deduplicate per-fire.

## `scripts/cleanup-low-signal.js`

Degrades memorias whose content is too short to carry signal. Targets capture artifacts like `"coder\n"`, `"writer\n"`, `"main\n"` that slip through harvesters with high importance but zero retrieval value.

### What it does

- Selects rows where `length(content) <= maxLen` (default 12) AND type ∈ `(decision, action, learning, note)`.
- Updates: `tier = 'cold'`, `importance = LEAST(importance, 2)`, `tags += 'low_signal'`.
- Skips already-degraded rows (idempotent).

### Why types are limited

`fact` and `gotcha` are deliberately excluded — those types can be legitimately short (a port number, an env var name, a one-liner gotcha). Restricting to `decision/action/learning/note` catches noise without false positives.

### Run

```bash
# preview
node scripts/cleanup-low-signal.js --dry-run

# apply
node scripts/cleanup-low-signal.js

# custom thresholds
CLEANUP_MAX_LEN=8 CLEANUP_MAX_IMPORTANCE=1 node scripts/cleanup-low-signal.js
```

### Schedule

Daily V5 wrapper, Sunday block (step 21). Runs after `dedup-supersede`.

### Idempotency

Safe. Re-runs only update rows that don't already have `tier=cold AND importance<=2 AND tag low_signal`.
