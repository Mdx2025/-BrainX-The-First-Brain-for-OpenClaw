---
name: brainx-auto-inject
description: "Auto-inject BrainX vector memory context on agent bootstrap"
homepage: https://github.com/Mdx2025/brainx
metadata:
  {
    "openclaw":
      {
        "emoji": "🧠",
        "events": ["agent:bootstrap"],
        "requires": { "env": ["DATABASE_URL"] },
        "install": [{ "id": "managed", "kind": "local", "label": "BrainX Hook" }],
      },
  }
---

# BrainX Auto-Inject Hook

Automatically injects relevant BrainX vector memories into agent context on every session start.

## What It Does

When an agent bootstraps (starts a new session):

1. **Queries BrainX DB** - Fetches local-first hot/warm memories, prioritizing verified signal and excluding `learning` by default
2. **Appends to MEMORY.md** - Adds a `<!-- BRAINX:START -->` section to the workspace MEMORY.md (which IS injected by OpenClaw)
3. **Updates BRAINX_CONTEXT.md** - Compact index with topic references for backward compatibility
4. **Writes topic files** - `brainx-topics/*.md` for on-demand deep-reads
5. **Logs telemetry** - Records injection stats to `brainx_pilot_log` table

## Trust Model And Precedence

BrainX auto-injection is **advisory context**, not a source of truth.

- Use injected memory to form hypotheses, checklists, and recall prior decisions.
- If injected memory conflicts with active code, runtime behavior, DB state, logs, tests, screenshots, or a direct user correction, **live evidence wins**.
- Do not mark a fix as done, revert code, or re-derive a production flow from memory alone when the real artifact is available.
- `learning` memories are intentionally excluded from bootstrap injection by default because they drift more easily than facts, decisions, errors, and gotchas.
- `Top Memories` is intentionally stricter than `My Memories`: top injected context uses only higher-signal verified memories, while own memories may still surface useful changelog context.
- Cross-agent knowledge remains available through explicit `brainx search` / `brainx inject` fallback when local context is insufficient.

## How Context Reaches Agents

OpenClaw injects `MEMORY.md` into every agent's system prompt. This hook appends a BrainX section
to MEMORY.md using HTML comment markers (`<!-- BRAINX:START -->` / `<!-- BRAINX:END -->`), ensuring
agents automatically receive relevant vector memories without any extra configuration. Those memories
must always be treated as briefing material, never as stronger evidence than the current system state.

## Deployment

The hook source lives in `brainx/hook/` (compat path `brainx/hook/`). Deploy by copying to the managed hooks directory:

```bash
mkdir -p ~/.openclaw/hooks/brainx-auto-inject
cp ~/.openclaw/skills/brainx/hook/{HOOK.md,handler.js,package.json} ~/.openclaw/hooks/brainx-auto-inject/
openclaw hooks enable brainx-auto-inject
```

## Configuration

In `openclaw.json`:

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

## Requirements

- `DATABASE_URL` - PostgreSQL connection string for the BrainX database (the physical DB name may still be legacy-named in existing deployments)
- BrainX skill installed at `~/.openclaw/skills/brainx/` (compat path `brainx/`)
- `pg` module available in `brainx/node_modules/`
