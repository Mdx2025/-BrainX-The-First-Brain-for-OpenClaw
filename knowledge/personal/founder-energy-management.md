---
domain: personal
tags: [personal, energy, founder]
status: canonical
importance: 7
sensitivity: normal
auto_query: "founder energy management focus routines recovery"
---
# Founder Energy Management

## Manual
Reglas para sostener rendimiento sin quemar criterio ni presencia.

## Reglas
- No poner trabajo profundo en horarios donde solo hay capacidad reactiva.
- Proteger energia estrategica como si fuera un recurso financiero escaso.
- Las decisiones importantes empeoran cuando se toman ya drenado.

## Notas
- Gestionar energia no es suavidad; es capacidad de rendimiento sostenido.
- El multitasking cobra caro cuando la mente entra y sale de contextos complejos sin cierre.

<!-- BRAINX:AUTO:START -->
## BrainX Auto
_Última sincronización: 2026-06-05T22:15:39.500Z_
_Query: founder energy management focus routines recovery_

- [decision | imp:9 | ctx:openclaw:bugs] 2026-04-28 21:16 -04: BrainX recovery was upgraded from regex-only to semantic LLM classification. Deterministic triggers remain as fast high-precision signals, but no-signal live messaging turns now fetch recent brainx_artifact_ledger and brainx_session_snapshots candidates for the same agent/session key, add a recovery_intent_policy candidate, and ask the existing BrainX router LLM whether the message depends on prior work/artifacts/context. If selected, trigger=semantic_recovery and mandatory recovery preflight is injected. Validation: bridge.ts node --check OK; signal-gate 17/17; bridge 3/3; scope-intent-olvida 20/20; live simulation with '¿todavía estás perdido con el PDF?' returned recovery preflight with /home/clawd/.openclaw/media/MDX_Email_Training_Manual_v5.docx; gateway RPC OK and Discord connected.
- [gotcha | imp:10 | ctx:openclaw:bugs] OpenClaw 2026.5.6 gotcha: gateway config watcher (server-reload-handlers-CNCGSeR3.js applySnapshot via diffConfigPaths) generates phantom 'env.X changed' deltas in compareConfig comparison even when process.env values are bit-identical and source files have identical md5. Root cause: compareConfig construction uses {...env} spread (io-DDcMg_WY.js:18667 envSnapshotForRestore) and re-load reconstruction differs from boot snapshot in non-content ways. Symptom that's easy to misdiagnose: every ~3 min '[reload] config change detected; evaluating reload (env.OPENAI_API_KEY, ...)' followed by '[reload] config change requires gateway restart' followed by SIGUSR1. Looks like external env mutator but no mutator exists — verified by inotifywait/poll md5sum 8min showing zero physical changes. The 3 OAuth/credential timers (claude-acp-token-sync, claude-credential-sync, gemini-oauth-refresh) all have 'if new == old: return changed=False' guards and are NOT the source. sync-openclaw-env.sh also has 'rendered != current.read_text()' guard. Fix: add {prefix:'env',kind:'none'} as first entry of BASE_RELOAD_RULES_TAIL in dist/config-reload-plan-DBZfWK-S.js (marker OPENCLAW_ENV_RELOAD_NOOP_20260507). Architecturally correct because process.env of Node is captured at boot from systemd EnvironmentFile= and cannot mutate during runtime — any 'env.X changed' reported by watcher in runtime is spurious by definition. Bug observed first 2026-05-07 with 49 restarts/day. Verified: with patch, 12+ min and 17+ min gateway uptime sin SIGUSR1, Discord channel status 'connected'. Cross-agent value: any agent investigating mysterious gateway restart loops or Discord 'awaiting gateway readiness' stuck patterns should check journalctl for '[reload] config change detected (env.X' and apply this patch instead of going down the rabbit hole of 'Discord plugin Carbon Client lifecycle bug' which can be just downstream symptom.
<!-- BRAINX:AUTO:END -->
