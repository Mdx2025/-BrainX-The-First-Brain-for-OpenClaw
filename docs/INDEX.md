# BrainX V5 Documentation

- [**How It Works**](./HOW-IT-WORKS.md) — Guía funcional completa (empieza aquí)
- [Architecture](./ARCHITECTURE.md) — Arquitectura del skill/plugin y surfaces legacy
- [Configuration](./CONFIG.md)
- [CLI Reference](./CLI.md) — `doctor`, `metrics` y telemetría de `brainx-live-capture`
- [Database Schema](./SCHEMA.md)
- [Scripts](./SCRIPTS.md)
- [Cron & Pipeline](./CRON.md) — 7 jobs directos, 17 daily steps, midweek/Sunday steps, handoff-promoter y jobs mixtos
- [ACP Context Continuity](./ACP_CONTEXT_CONTINUITY.md) — Sistema anti-alucinación de los 9 agentes Claude ACP: WORKING_STATE durable, guard de rotación por contexto (0.65 + boundary-gate), PreCompact hooks, compactación segura, y el ledger de rotation-events
- [Runtime Status](./RUNTIME_STATUS.md) — Fuente de verdad humana para surfaces activas, manuales, dormidas o deshabilitadas; incluye auditoría 2026-05-06 de runtime sano con arquitectura acoplada
- [Skill Promoter](./SKILL_PROMOTER.md) — Puente procedural tipo Hermes: patrones BrainX recurrentes a candidatos review-gated de SKILL.md
- [Tests](./TESTS.md)
- [OpenClaw Alignment 2026-03-28](./OPENCLAW_ALIGNMENT_2026-03-28.md) - Current generic-baseline policy, validation state, and future pending work for OpenClaw agents

## Runtime Notes

Do not read this index as “everything below is active in production”.

- Human truth: `docs/RUNTIME_STATUS.md`
- Machine-readable truth: `config/surface-policy.json`
- Active scheduler truth: `/home/clawd/.openclaw/skills/brainx/cron/brainx-daily-core-wrapper.sh`

## Core Surfaces on This Host

The following scripts/jobs are part of the current production path or direct support path:

| Script | Location | Description |
|--------|----------|-------------|
| session-harvester.js | scripts/ | Extracts memories from OpenClaw sessions |
| handoff-promoter.js | scripts/ | Promotes session snapshots into durable hot memories and artifact ledger rows |
| memory-bridge.js | scripts/ | Syncs markdown files to vector DB |
| cross-agent-learning.js | scripts/ | Propagates learnings across agents |
| contradiction-detector.js | scripts/ | Finds duplicate/contradictory memories |
| context-pack-builder.js | scripts/ | Generates/upserts maintenance summary packs |
| knowledge-sync.js | scripts/ | Syncs canonical knowledge docs when they changed |
| session-snapshot.js | scripts/ | Captures structured handoff snapshots every 4h |
| trajectory-recorder.js | scripts/ | Records problem-to-solution trajectories daily |
| cleanup-snapshots-trajectories.js | scripts/ | Weekly cleanup for snapshot/trajectory tables |
| doctor / fix | lib/cli.js | Operational diagnostics and safe hygiene repair |

Manual or dormant surfaces such as `learning-detail-extractor.js`, `quality-scorer.js`, some legacy hooks, and EIDOS should be treated according to `docs/RUNTIME_STATUS.md` and `config/surface-policy.json`, not by repo presence alone.
