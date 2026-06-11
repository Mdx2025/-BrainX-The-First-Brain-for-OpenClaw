# Architecture (BrainX V5)

BrainX V5 is a lightweight memory service implemented as:

- **PostgreSQL** for storage + metadata filters
- **pgvector** for vector similarity search
- **OpenAI embeddings API** to generate vectors
- A small **Node.js CLI** to write/search/inject memory into prompts
- A production OpenClaw plugin runtime in `~/.openclaw/extensions/brainx/`
- Legacy hooks kept for controlled/manual paths:
  - `hook/handler.js` for bootstrap injection
  - `hook-live/handler.js` for near-real-time outbound capture on `message:sent`

This repo is intentionally minimal: it can be embedded into larger systems (e.g. OpenClaw) without running a dedicated HTTP service.

## High-level components

### 1) CLI entrypoints

- `./brainx` (bash wrapper)
  - `health` → runs `tests/smoke.js`
  - `add|search|inject` → runs `lib/cli.js`

### 2) CLI implementation

- `lib/cli.js`
  - `add`: validates input, generates an id, calls `openai-rag.storeMemory()`
  - `search`: calls `openai-rag.search()` and prints JSON
  - `inject`: calls `search()` and prints a **prompt-ready text block** with metadata headers per item

### 3) Storage + vector search

- `lib/openai-rag.js`
  - `embed(text)` → calls `POST https://api.openai.com/v1/embeddings`
  - `storeMemory(memory)` → inserts/updates `brainx_memories` (with `embedding`)
  - `search(query, opts)` → embeds query, runs SQL with pgvector distance operator, applies filters, orders by `score`

### 3.5) Live capture telemetry

- `lib/live-capture-stats.js`
  - `appendLiveCaptureEvent(payload)` → appends structured runtime telemetry to `~/.openclaw/logs/brainx-live-capture.log`
  - `summarizeLiveCapture(opts)` → aggregates `seen`, `captured`, `low_signal`, `duplicate`, store failures, latency, and last success/error

### 3.6) OpenClaw plugin runtime

- `~/.openclaw/extensions/brainx/src/bridge.ts`
  - observes prompts/tool calls/assistant output
  - classifies turn intent and runtime family
  - selects one context surface per turn
  - applies adaptive policy from recent runtime usefulness telemetry before retrieval/injection
  - writes compact `brainx_context_state` rows keyed by `agent + session_key`
  - records artifacts into `brainx_artifact_ledger`
- `~/.openclaw/extensions/brainx/src/router.ts`
  - strict LLM relevance router for candidate memories/snapshots
  - empty selection means inject nothing
  - timeout/error falls back only to strongly aligned candidates

### 4) Database layer

- `lib/db.js`
  - wraps a `pg.Pool`
  - exposes `query()` and `health()`

## Execution flow

### Add

1. CLI receives `--type`, `--content`, etc.
2. `openai-rag.storeMemory()`:
   - runs `assessMemoryQuality()` before paying for embeddings
   - skips acknowledgements/placeholders/noise and downgrades borderline signal
   - builds an embedding input string: `"${type}: ${content} [context: ${context}]"`
   - calls OpenAI embeddings
   - upserts into `brainx_memories`

### Weekly consolidation

1. `cron/weekly-semantic-consolidation.sh` gates execution to the configured UTC weekday
2. `scripts/memory-consolidator.js` selects only mature, non-superseded memories with embeddings
3. Eligibility rejects runtime/subagent wrappers, changelog noise, borderline quality, and already-consolidated rows
4. Clusters are constrained to the same `type + agent + context + category + sensitivity`
5. Merged memories are persisted through `openai-rag.storeMemoryWithClient(..., { skipDedupe: true })`
6. Originals are superseded transactionally only after the consolidated memory is stored

### Search

1. `openai-rag.search()` embeds the query
2. By default, `BRAINX_SEARCH_TWO_STAGE_HNSW_RERANK_20260606` asks pgvector/HNSW for vector-nearest candidates first, using `ORDER BY embedding <=> query_embedding LIMIT candidate_pool`.
3. SQL reranks that candidate pool using:
   - cosine similarity (via `1 - (embedding <=> query_embedding)`)
   - importance boost
   - tier boost/penalty
4. Results are returned (and filtered by `minSimilarity` in JS)
5. Access tracking updates `last_accessed` and increments `access_count`

Rollback/tuning:

- `BRAINX_SEARCH_TWO_STAGE=0` restores the legacy full weighted scan.
- `BRAINX_SEARCH_TWO_STAGE_CANDIDATES`, `BRAINX_SEARCH_TWO_STAGE_MIN_CANDIDATES`, `BRAINX_SEARCH_TWO_STAGE_MULTIPLIER`, and `BRAINX_SEARCH_TWO_STAGE_MAX_CANDIDATES` tune recall breadth vs CPU.
- `BRAINX_SEARCH_TWO_STAGE_SET_EF_SEARCH=0` disables the local pgvector `hnsw.ef_search` adjustment.

### Event ledger

`scripts/event-ledger.js` owns `brainx_event_ledger`, a deterministic forensic
index for fixes, incidents, decisions, deployments, handoffs, and audits. It
does not replace `brainx_memories`; it complements them with structured filters
for date, project, domain, agent, runtime family, event type, status, tags,
source path, related ids, files touched, and commands run. Embeddings are
optional and used only to improve semantic discovery.

### Inject

Same as search, but output is formatted for direct prompt injection:

- Each memory is printed as:

```
[sim:0.62 imp:9 tier:hot type:decision agent:coder ctx:openclaw]
<content...>
```

### Runtime context broker

Production prompt-time injection is plugin-owned, not CLI-owned.

1. The plugin receives the prompt from OpenClaw.
2. It classifies the turn:
   - artifact request
   - session continuity
   - session rotation for the same `agent + session_key`
   - context-loss complaint
   - historical/procedural query
   - troubleshooting
   - project/domain recall
   - casual/control
3. It infers runtime family:
   - ACP
   - Codex
   - embedded Kimi/MiniMax
   - unknown
4. It selects one surface:
   - `recovery_preflight`
   - `jit_recall`
   - `working_memory`
   - `wiki_digest`
   - none
5. It applies the adaptive policy controller:
   - `recovery_preflight`, explicit recall/high-value turns, and deterministic `project_ground` sources are protected
   - low-signal surfaces can be suppressed per agent/surface after enough samples
   - a deterministic exploration budget lets suppressed surfaces recover without manual threshold changes
6. It injects a compact evidence block only if the selected surface has useful evidence and policy allows it.

`active_scope` is the project/domain guard before evidence injection. The plugin derives it from prompt text, immediate thread context, `brainx_context_state`, working memory, and path scope. For ambiguous continuations (`que mas nos falta`, `sigue`, `lo pendiente`, `hazlo`, etc.), `active_scope` becomes strict: recovery snapshots/artifacts/context states and JIT recall rows from other detected projects are filtered out unless the user explicitly broadens to all memories/workspace/other projects.

ACP policy is intentionally quieter at the injection layer: ACP sessions often preserve context upstream, so generic domain recall is suppressed unless the turn needs recovery, historical/procedural memory, or troubleshooting evidence. This must not be implemented as plugin absence. ACP turns still need BrainX typed runtime hooks for intake gates, working-memory/session state, and scoring telemetry.

Policy telemetry is stored in `brainx_policy_decisions`. It complements `brainx_runtime_injections`: the latter records what was injected and later referenced, while the policy table records why a surface was allowed, suppressed, or explored. Operationally, this is the first place to inspect before changing static thresholds.

### Claude ACP Runtime-Heal Boundary

BrainX is not the owner of Claude ACP runtime health.

On this host, `claude-cli-runtime-heal` owns:

- dead ACP process detection
- stale ACP metadata cleanup
- `acpxSessionId` preservation/repair
- `observe_acp_rotation_required` and `prune` remediation actions
- upstream ACP resume/handoff consumption

BrainX owns only prompt-time context intelligence:

- compact evidence retrieval
- semantic recall
- artifact ledger lookup
- session snapshot/handoff evidence
- `brainx_context_state` recovery for OpenClaw `sessionId` rotation

Therefore BrainX must not reset ACP sessions, rewrite ACP metadata, or compete with ACP `resumeSessionId`. Any future ACP-rotation BrainX feature should be passive and idempotent: observe the event, store concise evidence, and inject only when the prompt actually needs context. A safe idempotency key is `agent + session_key + previous_session_id + new_session_id` or the equivalent ACP identity tuple.

Ops policy is quieter too: `alert`, `monitor`, and `monitor-public` do not receive generic JIT recall. Cron/heartbeat turns should produce compact operational output, not memory-search context.

### Artifact ledger v2

`brainx_artifact_ledger` is a typed artifact index, not a raw path dump.

Important fields:

- `artifact_role`: `final_deliverable`, `generated_asset`, `screenshot_evidence`, `report`, `referenced_file`, `temp_candidate`, etc.
- `provenance`: `promoted_handoff`, `assistant_final`, `tool_write`, `tool_read`, `tool_exec`, etc.
- `finality_score`: ranking signal so final deliverables outrank `/tmp`, read-only references, and weak tool output.
- `metadata`: structured capture/backfill/source details.

Recovery preflight queries artifacts by session match, finality, and recency.

### SessionKey state

`brainx_context_state` stores a compact latest-state row by `agent + session_key`:

- last user prompt
- last assistant output
- last artifact path/role
- runtime family
- turn intent

This gives OpenClaw a deterministic handoff surface when `sessionId` rotates but the Discord/channel `sessionKey` remains the same. The runtime reads this row before it upserts the current turn; if the stored `session_id` differs from the current `sessionId`, a meaningful non-ack prompt can force `recovery_preflight` with only compact historical evidence. Raw transcripts are not replayed.

### Runtime scoring caveat

Runtime scoring is normally closed by `llm_output`: the plugin compares the final answer against selected evidence and updates `brainx_runtime_injections.scored_at`.

Fixed 2026-04-29: Codex/background turns can emit `NO_REPLY` while the visible answer is delivered later through OpenClaw delivery-mirror. BrainX now treats exact `NO_REPLY`/`HEARTBEAT_OK` as non-answer outputs, keeps selected-injection cache entries alive, and observes typed `message_sent` as scoring-only. This closes scoring from the visible delivery text by `sessionKey` without re-enabling broad outbound capture or replaying raw transcripts.

### Live capture

1. OpenClaw emits `message:sent`
2. `hook-live/handler.js` filters for high-signal outbound recommendations
3. The hook writes a compact bullet to `memory/YYYY-MM-DD.md`
4. The same summary is stored in `brainx_memories` with conservative provenance
5. `appendLiveCaptureEvent()` records the runtime outcome for observability

Terminal outcomes are:

- `captured`
- `low_signal`
- `duplicate`
- `capture_failed`

## Filters and ranking

### Filters

`search()` supports:

- `minImportance`
- `tierFilter` (exact tier)
- `contextFilter` (exact context)
- excludes superseded memories: `superseded_by IS NULL`

### Ranking

CLI search still uses SQL/vector composite ranking. Runtime injection adds:

`BRAINX_SEARCH_TWO_STAGE_HNSW_RERANK_20260606` makes that SQL ranking two-stage by default: HNSW candidate retrieval first, weighted SQL rerank second. The ranking formula is unchanged; only the row set is bounded before rerank. Rollback is `BRAINX_SEARCH_TWO_STAGE=0`.

- scope scoring
- tool-behavior intent scoring
- usage/fatigue scoring
- strict LLM router selection
- deterministic post-router guard
- surface planner policy before retrieval

## Environment

Common env vars (see `.env.example`):

- `DATABASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_EMBEDDING_MODEL`
- `OPENAI_EMBEDDING_DIMENSIONS` (must match schema vector dim)

Optional:

- `BRAINX_ENV` path to an env file to load from multiple processes
- `BRAINX_INJECT_DEFAULT_TIER` (`warm_or_hot` by default)
- `BRAINX_INJECT_MAX_CHARS_PER_ITEM`
- `BRAINX_INJECT_MAX_LINES_PER_ITEM`

## Design notes / tradeoffs

- No HTTP service by default: easier to run locally, in cron jobs, or as a library.
- `context` filtering is exact-match right now (simple + predictable).
- `superseded_by` enables cheap “soft delete” / dedup without losing history.
- Near-real-time capture is intentionally heuristic and conservative: it prefers skipping weak signals over filling BrainX with noise.
- Runtime injection is not blind memory injection. The plugin acts as a context broker: classify intent, choose a surface, retrieve evidence, inject minimally.

## Architecture audit 2026-05-06

Live validation on 2026-05-06 found BrainX healthy in production: `brainx health` OK, `doctor --full --json` OK with 0 failures when pointed at the canonical vault, gateway `brainx.status` OK, and the 7 direct BrainX/Memory cron jobs OK.

The audit did not find a runtime incident. It did find a maintainability boundary issue:

- the OpenClaw plugin is the active runtime owner
- the skill remains the owner of CLI, DB, maintenance, knowledge, wiki, scripts, docs, and dormant/legacy surfaces
- the plugin still imports skill modules directly for RAG, DB, advisory, working memory, phase2 behavior, and legacy hook bridges

This means the current architecture is operationally valid but coupled. The next cleanup should split plugin-owned runtime dependencies from skill-owned CLI/maintenance dependencies before adding more prompt-time surfaces. Until that happens, avoid treating the skill as a purely offline package: edits to `lib/*`, `hook/*`, or shared env/vault assumptions can affect production runtime.

First low-risk cut applied: plugin runtime dependency loading now lives behind `~/.openclaw/extensions/brainx/src/runtime-deps.ts`. `bridge.ts` still uses the same skill-owned modules, but the direct `createRequire(...)`, legacy hook imports, and cached skill-module access are isolated behind one plugin-side boundary. This is not full decoupling; it is the stable boundary for later extracting runtime-owned modules without changing prompt-time behavior in the same step.

## Recommended next improvements (optional)

- Make vector dimension configurable end-to-end (schema + code) without manual edits.
- Add migrations tool (e.g. `node scripts/migrate.js`).
- Add a migrations runner so SQL files do not rely on ad hoc application.
- Add artifact lineage grouping by task/project, not just path/session.
