# Configuration

BrainX V5 is configured through environment variables.

Recommended workflow:

- keep a local `.env` for development
- for production/system services, inject env vars via your process manager (systemd, Railway, Docker, etc.)

## Required

### `DATABASE_URL`

Postgres connection string.

Example:

```bash
DATABASE_URL=postgresql://brainx:brainx_change_me@127.0.0.1:5432/brainx
```

Note:
- existing deployments may still use a legacy physical database name such as `brainx`
- that naming drift does not block BrainX V5 itself, but docs and code should not assume a specific DB name unless a migration was actually executed

### `OPENAI_API_KEY`

Used by `lib/openai-rag.js` to call the OpenAI embeddings endpoint.

## Embeddings

### `OPENAI_EMBEDDING_MODEL`

Default: `text-embedding-3-small`

### `OPENAI_EMBEDDING_DIMENSIONS`

Default: `1536`

Must match the schema type:

- `brainx_memories.embedding vector(1536)`

If you change dimensions:

1. change schema
2. rebuild embeddings for existing rows

## Shared env file

### `BRAINX_ENV`

Path to a shared env file.

`lib/db.js` and `lib/openai-rag.js` both support loading env from `BRAINX_ENV` if the main variables are missing.

This is useful when multiple agents share one secrets file.

## Search performance flags

### `BRAINX_SEARCH_TWO_STAGE`

Default: `true`.

Enables `BRAINX_SEARCH_TWO_STAGE_HNSW_RERANK_20260606`: BrainX first asks pgvector/HNSW for nearest vector candidates, then applies the existing weighted score rerank on that smaller pool. Set to `0`, `false`, `off`, or `legacy` to roll back to the old full weighted scan.

### `BRAINX_SEARCH_TWO_STAGE_CANDIDATES`

Optional explicit candidate pool size. If unset, BrainX uses `max(limit * BRAINX_SEARCH_TWO_STAGE_MULTIPLIER, BRAINX_SEARCH_TWO_STAGE_MIN_CANDIDATES)`, capped by `BRAINX_SEARCH_TWO_STAGE_MAX_CANDIDATES`.

Defaults:

- `BRAINX_SEARCH_TWO_STAGE_MIN_CANDIDATES=40`
- `BRAINX_SEARCH_TWO_STAGE_MULTIPLIER=2`
- `BRAINX_SEARCH_TWO_STAGE_MAX_CANDIDATES=400`

### `BRAINX_SEARCH_TWO_STAGE_SET_EF_SEARCH`

Default: `true`.

When enabled, the two-stage query sets `hnsw.ef_search` locally to the candidate pool size so pgvector can return the requested candidate count. Set to `0` to use the database default. `BRAINX_SEARCH_TWO_STAGE_EF_SEARCH` can override the exact value.

## OpenClaw Plugin Runtime Config

The production runtime plugin is configured in:

```text
/home/clawd/.openclaw/openclaw.json -> plugins.entries.brainx.config
```

Current host rules:

- `routerMode=active`
- `routerFallbackModel=""` — empty means no LLM fallback model; router failure falls back only to strictly aligned deterministic candidates
- `policyController=true` — adaptive allow/suppress/explore gate using recent `brainx_runtime_injections`
- `policyDecisionLog=true` — writes audit rows to `brainx_policy_decisions`
- `policyWindowDays=7`, `policyMinSamples=10`, `policyMinUsefulRate=0.20`, `policyExploreRate=0.10`
- `jitRecallDisabledAgents=["alert","monitor","monitor-public"]` — ops/cron agents stay quiet
- `bootstrapMode=off`
- `captureOutboundMode=off`
- `wikiDigest=true`, `jitRecall=true`, `workingMemory=true`, `toolAdvisories=true`, `captureToolFailures=true`

Runtime ownership boundary:

- BrainX owns prompt-time context intelligence: recall, recovery preflight, artifact lookup, compact `brainx_context_state`, and telemetry.
- The policy controller owns calibration pressure: it should suppress or re-explore noisy surfaces from evidence before humans change thresholds.
- `claude-cli-runtime-heal` owns Claude ACP health: dead process handling, stale metadata, `acpxSessionId`, prune/observe actions, and upstream resume/handoff.
- Do not configure BrainX to reset ACP sessions or rewrite ACP metadata.

## Inject formatting

### `BRAINX_INJECT_DEFAULT_TIER`

Default: `warm_or_hot`.

If unset and you don’t pass `--tier`, the inject command:

1. searches `hot`
2. searches `warm`
3. merges results unique by id

### `BRAINX_INJECT_MAX_CHARS_PER_ITEM`

Default: `2000`.

### `BRAINX_INJECT_MAX_LINES_PER_ITEM`

Default: `80`.
