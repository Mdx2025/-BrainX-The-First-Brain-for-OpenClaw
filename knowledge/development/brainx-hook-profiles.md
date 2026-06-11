---
domain: development
tags: [brainx, openclaw, hook, profiles, bootstrap, recall]
status: canonical
importance: 9
sensitivity: normal
auto_query: "brainx hook agent profiles bootstrap allowCrossAgent crossAgentRatio hot reload"
---
# BrainX Hook Profiles

## Manual
Fuente canonica para el estado vigente del hook interno de BrainX que inyecta memoria al bootstrap de agentes. Sirve para responder preguntas sobre perfiles, contexts, cross-agent recall y comportamiento de `agent-profiles.json` sin depender de snapshots viejos.

## Reglas
- El archivo canonico de perfiles es `/home/clawd/.openclaw/skills/brainx/hook/agent-profiles.json`.
- El handler del hook lee `agent-profiles.json` en cada bootstrap del agente; cambios en ese JSON aplican sin reiniciar el gateway.
- El baseline actual usa `allowCrossAgent=false`.
- El baseline actual usa `crossAgentRatio=0`.
- `crossAgentTagRequired=true` sigue activo, pero mientras `allowCrossAgent=false` no se deben inyectar slots cross-agent en el baseline.
- Los contexts baseline vigentes son `project`, `project_registry`, `agent`, `workspace`, `business`, `personal`, `tools`, `infrastructure`, `qa`, `audit`, `test`.
- Los `excludeTypes` baseline vigentes son `learning` y `note`.
- Los `boostTypes` baseline vigentes son `decision`, `fact`, `gotcha`, `action`.

## No usar como verdad actual
- Snapshots viejos que hablen de `allowCrossAgent=true`.
- Recuerdos de experimentos con slots cross-agent al 30%.
- Paths legacy bajo `/home/clawd/.openclaw/hooks/brainx-auto-inject/` como fuente de verdad del baseline actual.

## Aplicacion practica
- Si el prompt pregunta por perfiles actuales de BrainX, bootstrap del hook o cross-agent recall actual, esta es la referencia correcta.
- Si codigo o runtime cambian, actualizar este topico y resincronizar `knowledge/`.

<!-- BRAINX:AUTO:START -->
## BrainX Auto
_Última sincronización: 2026-06-05T22:15:34.273Z_
_Query: brainx hook agent profiles bootstrap allowCrossAgent crossAgentRatio hot reload_

- [gotcha | imp:10 | ctx:openclaw:bugs] BUG RESUELTO 2026-04-28 20:09 -04: BrainX handoff no era obligatorio tras rotación de sesión OpenClaw. Síntoma: agentes como coder podían responder 'no tengo contexto' tras idle reset aunque existían reply context, snapshots y artefactos como /home/clawd/.openclaw/media/MDX_Email_Training_Manual_v5.docx. Causa raíz: bridge.ts solo disparaba snapshots por SESSION_CONTINUITY_RE/router; frases como 'Estábamos en esta tarea' caían en short y 'adjúntame el nuevo doc' podía quedar no-signal. Fix: /home/clawd/.openclaw/extensions/brainx/src/bridge.ts ahora tiene mandatory recovery preflight por has_reply_context, continuidad en español/inglés y referencias a doc/archivo; inyecta bloque corto con reply context, brainx_session_snapshots y brainx_artifact_ledger antes de permitir no-context. Artifact ledger lazy + schema/migration 012_artifact_ledger.sql captura rutas durables desde llm_output/tool_result. Validación: signal-gate tests 14/14, bridge tests 3/3, scope-intent tests 20/20, node --check bridge.ts, OpenClaw config valid, gateway RPC OK, Discord connected; simulación coder recuperó MDX_Email_Training_Manual_v5.docx desde snapshot.
- [gotcha | imp:8 | ctx:project:brainx-v4] El hook de auto-inject en BrainX V4 no inyectaba memorias reales, solo un placeholder, por lo que los agentes arrancaban sin contexto útil en cada sesión.
- [gotcha | imp:10 | ctx:openclaw:bugs] OpenClaw 2026.5.6 gotcha: gateway config watcher (server-reload-handlers-CNCGSeR3.js applySnapshot via diffConfigPaths) generates phantom 'env.X changed' deltas in compareConfig comparison even when process.env values are bit-identical and source files have identical md5. Root cause: compareConfig construction uses {...env} spread (io-DDcMg_WY.js:18667 envSnapshotForRestore) and re-load reconstruction differs from boot snapshot in non-content ways. Symptom that's easy to misdiagnose: every ~3 min '[reload] config change detected; evaluating reload (env.OPENAI_API_KEY, ...)' followed by '[reload] config change requires gateway restart' followed by SIGUSR1. Looks like external env mutator but no mutator exists — verified by inotifywait/poll md5sum 8min showing zero physical changes. The 3 OAuth/credential timers (claude-acp-token-sync, claude-credential-sync, gemini-oauth-refresh) all have 'if new == old: return changed=False' guards and are NOT the source. sync-openclaw-env.sh also has 'rendered != current.read_text()' guard. Fix: add {prefix:'env',kind:'none'} as first entry of BASE_RELOAD_RULES_TAIL in dist/config-reload-plan-DBZfWK-S.js (marker OPENCLAW_ENV_RELOAD_NOOP_20260507). Architecturally correct because process.env of Node is captured at boot from systemd EnvironmentFile= and cannot mutate during runtime — any 'env.X changed' reported by watcher in runtime is spurious by definition. Bug observed first 2026-05-07 with 49 restarts/day. Verified: with patch, 12+ min and 17+ min gateway uptime sin SIGUSR1, Discord channel status 'connected'. Cross-agent value: any agent investigating mysterious gateway restart loops or Discord 'awaiting gateway readiness' stuck patterns should check journalctl for '[reload] config change detected (env.X' and apply this patch instead of going down the rabbit hole of 'Discord plugin Carbon Client lifecycle bug' which can be just downstream symptom.
- [gotcha | imp:10 | ctx:openclaw:brainx] BrainX gotcha: doctor check 'Sensitivity calibration' (lib/doctor.js:476) fails when any memory has sensitivity='normal' AND tag 'pii:redacted' (excepting credit_card-only with no financial keywords in content). The canonical write path (lib/cli.js:cmdAdd -> lib/openai-rag.js:storeMemory line 239) ALWAYS calls deriveSensitivity before INSERT/upsert, so if a row drifts into this failure bucket it means SOME OTHER PATH UPDATED the row's tags post-insert WITHOUT recalculating sensitivity. Confirmed via manual repro: deriveSensitivity with tags including pii:redacted+pii:password_inline correctly returns 'restricted'. Suspect callers (not all confirmed): scripts/contradiction-detector.js:211 (UPDATE tags), scripts/cross-agent-learning.js:113 (UPDATE tags), unidentified hooks. Resolution is trivial: 'brainx fix' step Sensitivity calibration (lib/fix.js:280 recalibrateSensitivity) re-scans all sensitivity=normal rows and reapplies deriveSensitivity — idempotent, safe to run repeatedly. Doctor will catch any future regression. Architectural fix would be enforcing deriveSensitivity in any UPDATE-tags path or adding a DB trigger on tags column, but not justified for one-off occurrences. First observed 2026-05-07 (m_1778164057971_c0d3af66). Cross-agent value: any agent that writes brainx memories should know this gotcha because misattributing to a 'add path bug' wastes investigation time when canonical path is correct.
- [fact | imp:8 | ctx:project:OpenClaw] Hay más de 30 agentes configurados en openclaw.json, pero solo 10 perfiles de agente definidos en agent-profiles.json (coder, writer, monitor, raider, clawma, reasoning, support, researcher, karl, echo). json, dejando 22 agentes con inyección genérica sin filtros personalizados.
- [gotcha | imp:9 | ctx:agent:raider] [Bootstrap optimization — AGENTS.md + TOOLS.md restructura (03:00-05:30 UTC)] Creados 4 archivos en `~/.openclaw/standards/references/`: - GWS_RECIPES.md, RAILWAY_GITHUB_RECIPES.md, SUBAGENT_MECHANICS.md, CODING_STANDARDS.md openclaw/standards/agent-core/templates/` y propagados a todos los workspaces. md: 18,012 → 6,850 chars (34% del límite 20K). Contenido movido a references/. md: 13,195 → 3,759 chars (18%). Recetas GWS/Railway movidas a references/. md restructura (03:00-05:30 UTC)] Cada uno referenciado con puntero explícito desde AGENTS.
<!-- BRAINX:AUTO:END -->
