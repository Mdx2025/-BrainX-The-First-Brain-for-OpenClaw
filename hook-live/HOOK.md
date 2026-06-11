---
name: brainx-live-capture
description: "Near-real-time capture of outbound high-signal recommendations into daily memory and BrainX V5"
homepage: https://github.com/Mdx2025/brainx
metadata:
  {
    "openclaw":
      {
        "emoji": "⚡",
        "events": ["message:sent"],
        "requires": { "env": ["DATABASE_URL"] },
        "install": [{ "id": "managed", "kind": "local", "label": "BrainX V5 Live Capture Hook" }],
      },
  }
---

# BrainX V5 Live Capture Hook

Captures high-signal outbound agent recommendations in near-real-time when OpenClaw sends a message.

## What It Does

When an agent successfully sends an outbound message:

1. Filters out low-signal chatter, status updates, greetings, and code dumps
2. Detects recommendation/decision/gotcha style messages with strong operational signal
3. Writes a compact bullet into the agent workspace `memory/YYYY-MM-DD.md`
4. Stores the same distilled summary into BrainX V5 immediately
5. Deduplicates by message/session/content hash so retries do not double-write

## Why It Exists

BrainX bootstrap injection and the daily pipeline are strong, but they are not immediate.
This hook closes the gap between:

- "the agent just recommended something important"
- and "that recommendation is durable memory now"

## Configuration

In `openclaw.json`:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "brainx-live-capture": {
          "enabled": true,
          "minChars": 120,
          "maxChars": 1200,
          "maxBullets": 6,
          "storeToBrainx": true,
          "storeToDailyMemory": true,
          "allowGroups": true
        }
      }
    }
  }
}
```

## Trust Model

- This hook stores what the agent **recommended**, not what is necessarily true.
- Live artifacts still outrank memory.
- Captured items default to conservative provenance and are meant for recall, not authority.
