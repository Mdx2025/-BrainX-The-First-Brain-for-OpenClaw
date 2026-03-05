---
name: brainx-auto-inject
description: "Auto-inject BrainX V4 vector memory context on agent bootstrap"
homepage: https://github.com/Mdx2025/brainx-v4
metadata:
  {
    "openclaw":
      {
        "emoji": "🧠",
        "events": ["agent:bootstrap"],
        "requires": { "env": ["DATABASE_URL"] },
        "install": [{ "id": "managed", "kind": "local", "label": "BrainX V4 Hook" }],
      },
  }
---

# BrainX V4 Auto-Inject Hook

Automatically injects relevant BrainX vector memories into agent context on every session start.

## What It Does

When an agent bootstraps (starts a new session):

1. **Queries BrainX DB** - Fetches top hot/warm memories (importance >= 5)
2. **Appends to MEMORY.md** - Adds a `<!-- BRAINX:START -->` section to the workspace MEMORY.md (which IS injected by OpenClaw)
3. **Updates BRAINX_CONTEXT.md** - Compact index with topic references for backward compatibility
4. **Writes topic files** - `brainx-topics/*.md` for on-demand deep-reads
5. **Logs telemetry** - Records injection stats to `brainx_pilot_log` table

## How Context Reaches Agents

OpenClaw injects `MEMORY.md` into every agent's system prompt. This hook appends a BrainX section
to MEMORY.md using HTML comment markers (`<!-- BRAINX:START -->` / `<!-- BRAINX:END -->`), ensuring
agents automatically receive relevant vector memories without any extra configuration.

## Deployment

The hook source lives in `brainx-v4/hook/`. Deploy by copying to the managed hooks directory:

```bash
mkdir -p ~/.openclaw/hooks/brainx-auto-inject
cp ~/.openclaw/skills/brainx-v4/hook/{HOOK.md,handler.js,package.json} ~/.openclaw/hooks/brainx-auto-inject/
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

- `DATABASE_URL` - PostgreSQL connection string (brainx_v4 database)
- BrainX V4 skill installed at `~/.openclaw/skills/brainx-v4/`
- `pg` module available in brainx-v4/node_modules/
