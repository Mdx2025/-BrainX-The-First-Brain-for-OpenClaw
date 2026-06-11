# BrainX V5 / OpenClaw Alignment - 2026-03-28

This note captures the current alignment work between BrainX V5 and OpenClaw agents so future maintenance does not depend on chat history.

> Historical note: this file records the 2026-03-28 alignment pass. For the current `/home/clawd` host runtime truth, use `docs/RUNTIME_STATUS.md`. Legacy hooks discussed here are not the default runtime path today.

## Scope

Applies to the OpenClaw runtime under `/home/clawd/.openclaw/` and to the BrainX V5 skill under `/home/clawd/.openclaw/skills/brainx/`.

## What Was Done

### 1. Unified all current agent profiles to one generic baseline

Source files:
- `/home/clawd/.openclaw/hooks/brainx-auto-inject/agent-profiles.json`
- `/home/clawd/.openclaw/skills/brainx/hook/agent-profiles.json`

Current baseline:
- `contexts`: `project`, `project_registry`, `agent`, `workspace`, `business`, `personal`, `tools`, `infrastructure`, `qa`, `audit`, `test`
- `excludeTypes`: `learning`, `note`
- `boostTypes`: `decision`, `fact`, `gotcha`, `action`
- `scoringWeights`: `recency=0.15`, `relevance=0.55`, `importance=0.20`
- `allowCrossAgent=false`
- `crossAgentTagRequired=true`
- `crossAgentRatio=0`

Decision:
- Do not personalize agent families yet.
- Keep the baseline broad, generic, and local-first.
- Cross-agent knowledge stays available through explicit `brainx search` / `brainx inject`, not automatic bootstrap injection.

### 2. Made profile JSON changes hot-reload on bootstrap

Source files:
- `/home/clawd/.openclaw/hooks/brainx-auto-inject/handler.js`
- `/home/clawd/.openclaw/skills/brainx/hook/handler.js`

Behavior:
- The hook now re-reads `hook/agent-profiles.json` on every `agent:bootstrap`.
- Profile JSON changes do not require a gateway restart.

### 3. Made `scoringWeights` real

Before:
- `scoringWeights` existed in profile JSON but did not affect bootstrap ranking.

Now:
- The hook normalizes `recency`, `relevance`, and `importance`.
- Ranking uses a weighted score built from:
  - context match ratio
  - type boost match
  - normalized importance
  - recency decay from `last_seen` / `created_at`

Effect:
- Profiles now influence retrieval quality, not just filtering.

### 4. Revalidated runtime after hook changes

Validation rechecked on 2026-04-01:
- `brainx doctor --full --json` -> `ok: true`, `40 passed`, `1 warning`, `0 failures`
- `openclaw-gateway.service` active after restart
- hook loader registered `brainx-auto-inject`
- managed hook source == deployed after re-sync
- bootstrap smoke after baseline hardening:
  - `agent=coder team=0 own=5 facts=18 decisions=8`
  - no `Cross-Agent Intel` section emitted into `MEMORY.md`

## Current Operating Policy

- All current agents stay on the same generic BrainX baseline for now.
- Bootstrap remains local-first by default.
- Cross-agent recall is explicit, not automatic.
- No family-specific tuning unless a specific agent proves underperforming in real use.
- BrainX V5 is considered operationally aligned with OpenClaw at this stage.

## Important Gotchas

### JSON profile edits vs code edits

- Editing `agent-profiles.json`: hot-reloaded on bootstrap
- Editing `hooks/brainx-auto-inject/handler.js`: requires

```bash
systemctl --user restart openclaw-gateway.service
```

Reason:
- Managed hooks are loaded into the gateway process.

### Embeddings provider constraint

As of 2026-03-28, BrainX V5 embeddings still depend on OpenAI only:
- `lib/embedding-client.js` calls the OpenAI embeddings API directly
- there is no clean alternate embeddings provider or fallback path yet

Observed blocker on 2026-03-28:
- `brainx add` and `brainx search` failed with OpenAI embeddings `429 insufficient_quota`

Decision:
- Do not insert fake or null-embedding documentation rows just to force this note into the vector DB.
- Keep BrainX health clean rather than polluting it with temporary null-embedding records.

## Future Pending

Do later, only if needed:
- Clean up `context` taxonomy to reduce drift and improve match quality.
- Decide whether `learning` should return for selected agents or remain out of generic bootstrap.
- Run broader real-turn validation across more agents after a few days of production usage.
- Revisit family-specific profiles only if a concrete agent underperforms.

Do not do yet:
- no family-specific personalization
- no widening of the bootstrap just for completeness
- no speculative profile tuning

## Follow-Up When Embeddings Quota Is Restored

When OpenAI embeddings are healthy again:
1. Persist the key alignment decisions/facts into BrainX memory with `brainx add`.
2. Re-run a semantic retrieval check for:
   - generic baseline
   - scoringWeights behavior
   - restart gotcha
   - future freeze policy

This document is the canonical temporary record until that semantic write path is available again.
