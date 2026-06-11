# Tests

## `tests/smoke.js`

A basic health check for:

- database connectivity
- pgvector extension installed
- schema installed (counts `brainx_*` tables)

Run:

```bash
node tests/smoke.js
# or
npm run test:smoke
```

## `tests/rag.js`

A minimal end-to-end RAG test:

- stores a small `note` memory
- searches with a related query
- prints the top results

Run:

```bash
node tests/rag.js
```

Notes:

- Requires `OPENAI_API_KEY` and a working `DATABASE_URL`.

## OpenClaw Plugin Tests

The production runtime plugin has its own test suite:

```bash
cd /home/clawd/.openclaw/extensions/brainx
npm test
```

Current expected result after the 2026-05-30 runtime/recall-health hardening:

```text
136/136 pass
```

Important canaries covered there:

- ACP domain chatter does not receive generic JIT recall.
- ACP procedural/historical questions can still receive relevant recall.
- `session_rotation` for the same `agent + sessionKey` triggers `recovery_preflight` for meaningful prompts.
- Exact acknowledgements and cron prompts do not trigger recovery by rotation.
- Command-only cron prompts do not trigger `jit_recall` or the router.
- Weak/unrelated memories are rejected before building a recall block.

## Recall Health

The CLI unit suite includes fake-DB coverage for `brainx recall-health`:

- low-yield runtime surfaces produce warnings
- healthy JIT intent-gate/router-empty turns are notes instead of warnings
- `working_memory` and `project_ground` use surface-aware classification
- query-log `inject` zero-result rate is included
- `inject` self-calibrates against its own baseline (`testRecallHealthInjectSelfCalibratesVsBaseline`): quiet on healthy diversity vs a low baseline (`mode=adaptive`, no warning), warns on a genuine regression, and falls back to the fixed cold-start threshold when no baseline exists
- the command stays read-only
- JSON output includes expected runtime surfaces even when there is no recent activity

## Runtime Regression Suite

The host-level suite validates BrainX as deployed inside OpenClaw:

```bash
/home/clawd/.openclaw/skills/brainx/cron/brainx-regression-suite.sh
```

Target expected result:

```text
25/25 pass
```

Latest live recheck, 2026-05-26:

```text
25/25 pass
runtime-session-key-telemetry-column: columns=1
session-rotation-runtime-events-logged: missing=0
recent-selected-injections-scored: recent_unscored_selected=0
```

The former Codex/background `NO_REPLY` + delivery-mirror telemetry gap is covered by a scoring-only `message_sent` fallback plus DB-backed scoring lookup by `session_key`. The fallback does not enable broad live capture and does not replay raw transcripts. The scoring invariant intentionally excludes OpenClaw `:cron:` sessions and agents in the configured BrainX JIT denylist (including `brainx-reviewer` turn-harvester runs); those are internal scheduler/maintenance prompts and should not be used as conversational usefulness samples.

Important checks:

- `brainx.status` RPC is reachable.
- Runtime surfaces are enabled.
- Ops agents `alert`, `monitor`, `monitor-public` are in the JIT denylist.
- Router policy is active and cross-agent policy is intentional.
- Recent selected conversational injections are scored, including `recovery_preflight` under background/delivery-mirror turns.
- No noisy archive memory was injected in the last 24h.
