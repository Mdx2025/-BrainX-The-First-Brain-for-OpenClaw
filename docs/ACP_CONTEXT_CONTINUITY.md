# ACP Context Continuity & Anti-Hallucination System

_Last updated: 2026-05-31 · OpenClaw 2026.5.27 · applies to the 9 Claude Code ACP agents (echo, raider, raider-private, blade, artemis, sonnet, clawma, claude-cli, xefora)._

## Why this exists

Claude Code agents run via ACP as an **external harness** with their own
context window (Opus 4.8, real window **1,000,000** — verified: agents reach
~960K with `compactionCount=0`; the earlier `contextTokens: 400000` config was
stale and made the rotation threshold artificially low, causing churn). On a long persistent
session the live window fills; if it rotates or compacts without a durable
record, the model **hallucinates** IDs/decisions it can no longer see.

The fix is **not** "rotate vs compact" — it's a layered defense with a durable
substrate underneath, so the source of truth never lives only in volatile
context. Order of preference for this workload (code, exact identifiers):

> **clearing → subagent offload → rotation at a clean boundary (primary) → compaction (emergency floor)** — all on top of a durable substrate.

Rotation beats compaction here because continuity is **structured** (BrainX +
WORKING_STATE + handoff) and the data are identifiers compaction mangles.

## The layers (what is live)

| Layer | Mechanism | Where |
|---|---|---|
| L0 · Durable substrate | `WORKING_STATE.md` per workspace + protocol in `CLAUDE.md` (read at session start via `@import`); BrainX injection | agent-core template + 9 workspaces |
| L1 · Tool-result clearing | `softTrim`/`hardClear` (ratios 0.5/0.7) | `openclaw.json` agent defaults |
| L2 · Subagent offload | delegate heavy reading/exploration to an isolated-window subagent that returns a 1-2K summary | `AGENTS.md §0f` (canon) |
| L3 · Rotation at boundary (PRIMARY) | context-budget guard: at **0.65** of budget, only at a clean turn boundary, rotate to a fresh CLI session + write continuity handoff | dist `manager-Cs6wHMF2.js` (tracked patch) |
| L4 · Compaction (floor) | `compaction.mode=safeguard` `reserveTokensFloor=50000` + native CLI auto-compact; `instructions` preserve task-state + force re-grounding | `openclaw.json` + CLI |

## Component reference

### WORKING_STATE.md (L0)
- Seeded in each of the 9 Claude ACP workspaces. Sections: Tarea actual /
  Decisiones / Hilos abiertos / IDs-refs.
- Protocol lives in the `CLAUDE.md` template (`@./WORKING_STATE.md` import +
  maintain/re-read/verify rules). Propagated by `doctor-agents.sh fix`.
- This is the real anti-hallucination guarantee: recall = read a file, not confabulate.

### Context-budget rotation guard (L3)
- Marker `OPENCLAW_CLAUDE_ACP_SESSION_REUSE_CONTEXT_GUARD_20260531`.
- Threshold = `max(1, min(floor(contextTokens*0.65), contextTokens-24000))`.
- **Boundary gate**: rotates only on first attempt + idle session + `state!=="running"` (never failover/retry, never mid-turn).
- Handoff: recency-biased + front-trim "session intents" (`...ROTATION_HANDOFF_SESSION_INTENTS_20260528`), not tail-only.
- History: this guard existed in 5.12, was REMOVED in the 5.27 re-port (`A8 REMOVED`), causing the fleet to ride full windows with no auto-rotation (echo at 831K). Re-ported 2026-05-31.
- **Persistence (critical):** it is a **tracked `patchFile()` block** in `patch-openclaw-dist-fixes-2026.5.27.mjs`. A standalone `--apply` gets WIPED on the next boot because the boot reconcile (ExecStartPre) restores the stock snapshot then re-applies only tracked patches. The boot log shows `reapplied snapshot ... → patched ...GUARD_20260531 → ok`.

### Compaction safety (L4)
- `compaction.instructions` extended: preserve task state + decisions + next step, and treat the post-compaction summary as prior context (re-read `WORKING_STATE.md`, verify vs repo before asserting).
- **PreCompact hook** (`OPENCLAW_PRECOMPACT_WORKING_STATE_20260531`) at `~/.openclaw/hooks/precompact-working-state/hook.mjs`, wired into the 9 `~/.claude-<agent>/settings.json`. Appends a "compaction occurred → re-ground" breadcrumb to `WORKING_STATE.md`. Never blocks compaction.

### Rotation-events ledger (observability)
- On rotation the guard writes a BrainX rotation event (`BRAINX_ACP_ROTATION_EVENT_MARKER_20260513`) to `~/.openclaw/state/brainx/acp-rotation-events/pending/` (eventType `claude-acp-context-budget-rotation`, `currentSessionId="pending-fresh"`).
- Consumed by `brainx-acp-rotation-event-ingest.mjs` → table `brainx_session_rotation_events`. Scheduled in the **Review Loop (~every 2h)**.
- The ingest records the **token level at rotation** in `metadata` (queryable: `metadata->>'total_tokens'`, `'context_tokens'`, `'threshold_tokens'`) — added 2026-05-31 so you can see *at what level* each rotation fired (e.g. sonnet @ 916K vs threshold 650K), not just that it happened. Forward-fill only; pre-2026-05-31 rows stay null (not backfilled — low value).

## Operating notes
- Backups for rollback: dist `.bak-2026-05-31T17-34-05Z` / stock snapshot; patch script `.bak-pre-guard-integration-20260531` + `.bak-pre-rotation-event-emit-20260531`; `openclaw.json.bak-pre-context-mgmt`; settings `.bak-precompact`.
- Not restored from 5.12: byte-size bloat rotation. Only the context-budget guard + its handoff + the BrainX rotation event are live.
- Incident ledger: BrainX `openclaw:bugs` (`m_1780248353085` → resolutions `m_1780249367322`, `m_1780250204977`).
- Tests: `validate-claude-acp-context-budget-guard-20260531.mjs` (10/10).
- Context-engine maintenance perf: the deferred-turn-maintenance (lossless-claw/BrainX, via codex app-server) summarizes turns with `LCM_SUMMARY_MODEL` over OpenAI API. Lowered `gpt-4.1-mini → gpt-4.1-nano` (2026-05-31) for faster per-chunk summarization — sonnet's 40 MB legacy transcripts (fat-context era) were grinding it ~27 min. The extension already chunks/incremental, so no size-cap needed; the rotation fix shrinks new transcripts. `lcm.db` (4.36 GB) is live memory (freelist=0), not bloat — do NOT hand-prune (FTS5 + non-epoch timestamps; use the extension's own retention). `recovery=none` in stall diagnostics is observe-only (anti-watchdog-consistent). BrainX `m_1780277881391`.

## Calibration 2026-05-31 (window fix + tuning)

Root finding: the fleet runs to ~960K with `compactionCount=0`, but OpenClaw
config said `contextTokens: 400000` → threshold computed at 260K → over-eager
rotation churn (clawma 38/24h, sonnet 23/24h under the stale number).

- **Window → 1,000,000** in both `openclaw.json` (model `claude-opus-4-8`:
  `contextTokens`/`contextWindow`) and the anthropic fallback in
  `sync-claude-acp-session-tokens.mjs` (the sync feeds `entry.contextTokens`,
  which the guard reads). Threshold now `0.65 × 1M = 650K`, leaving **350K
  headroom** — more than any single turn, so the next turn always fits without
  mid-turn compaction. (The explicit `reserveTokens` floor stays minimal: at 1M
  the ratio binds, so a larger floor would be inert; it only matters for
  hypothetical small-window models.)
- **Ledger ingest moved to the Review Loop (~every 2h)** from daily-core, for
  near-real-time observability (`run_named_step acp-rotation-event-ingest`).
- **Auto-tuning audit** (read-only): `brainx-acp-rotation-tuning-audit.mjs`,
  daily-core step. Measures rotation freq + how hot each session runs vs window;
  flags churn / near-cap risk / native CLI compaction; recommends RATIO changes.
- QUALITY_RATIO dial. **Lowered 0.65 → 0.30 the same day:** 0.65 (=650K) made
  interactive agents ride ~940K context per turn → slow responses (TTFT +
  generation scale with window length even when cached; observed a 5-min lane
  wait). For chat/interactive agents **responsiveness wins over context
  retention**, so 0.30 (=300K threshold) keeps turns lean/fast. Trade-off dial:
  lower = faster + more rotations; higher = more retained context + heavier turns.
- **The ratio is now env-tunable** (no dist surgery to change it):
  `OPENCLAW_CLAUDE_ACP_CONTEXT_GUARD_RATIO` (default 0.30, range 0–1), read by the
  guard at module load. Export it in the gateway env + restart to re-dial.
  Threshold = `floor(contextTokens × RATIO)`, i.e. `300K` at the 1M window.
