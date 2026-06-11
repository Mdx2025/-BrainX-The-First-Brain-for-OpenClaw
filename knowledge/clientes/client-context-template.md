---
domain: clientes
tags: [clients, context, relationships]
status: canonical
importance: 7
sensitivity: normal
auto_query: "client context expectations communication tone constraints"
---
# Client Context Template

## Manual
Plantilla mental para guardar contexto duradero de cada cliente.

## Reglas
- Documentar tono, tolerancia al riesgo, velocidad esperada y formato preferido de comunicacion.
- Separar hechos del cliente de interpretaciones del equipo.
- Actualizar solo lo estable; no convertir el archivo en changelog de mensajes.

## Notas
- La memoria de cliente sirve para continuidad, no para acumular ruido temporal.
- Conocer el estilo de decision del cliente evita friccion innecesaria.

<!-- BRAINX:AUTO:START -->
## BrainX Auto
_Última sincronización: 2026-06-05T22:15:31.890Z_
_Query: client context expectations communication tone constraints_

- [gotcha | imp:10 | ctx:openclaw:bugs] BUG RESUELTO 2026-04-28 20:09 -04: BrainX handoff no era obligatorio tras rotación de sesión OpenClaw. Síntoma: agentes como coder podían responder 'no tengo contexto' tras idle reset aunque existían reply context, snapshots y artefactos como /home/clawd/.openclaw/media/MDX_Email_Training_Manual_v5.docx. Causa raíz: bridge.ts solo disparaba snapshots por SESSION_CONTINUITY_RE/router; frases como 'Estábamos en esta tarea' caían en short y 'adjúntame el nuevo doc' podía quedar no-signal. Fix: /home/clawd/.openclaw/extensions/brainx/src/bridge.ts ahora tiene mandatory recovery preflight por has_reply_context, continuidad en español/inglés y referencias a doc/archivo; inyecta bloque corto con reply context, brainx_session_snapshots y brainx_artifact_ledger antes de permitir no-context. Artifact ledger lazy + schema/migration 012_artifact_ledger.sql captura rutas durables desde llm_output/tool_result. Validación: signal-gate tests 14/14, bridge tests 3/3, scope-intent tests 20/20, node --check bridge.ts, OpenClaw config valid, gateway RPC OK, Discord connected; simulación coder recuperó MDX_Email_Training_Manual_v5.docx desde snapshot.
- [gotcha | imp:10 | ctx:openclaw:bugs] BUG RESUELTO 2026-04-28 21:31 -04: coder/Kimi exposed OpenClaw runtime context and BrainX mandatory recovery preflight in Discord by echoing display=false custom_message entries. Root cause: sanitize-user-facing-text stripped internal delimited context but not modern 'OpenClaw runtime context for the immediately preceding user message' echoes or BrainX preflight echoes; BrainX snapshot wording also exposed status=blocked/92 turns. Fix: bridge.ts recovery snapshot lines now use user-safe 'prior handoff' wording and instruct silent use; patched dist/sanitize-user-facing-text-DgEphtot.js with stripReasoningAndRuntimeContextEcho to remove runtime context, BrainX preflight echoes, and stray think tags before channel delivery; archived/deleted poisoned coder session 7472d7fe. Validation: node --check OK for bridge/sanitizer/auditor; signal-gate 17/17; sanitizer simulations strip runtime-only and preflight-only echoes while preserving real answer after </think>; gateway RPC OK; Discord connected; audit reports 44 applied including runtime-context leak sanitizer.
<!-- BRAINX:AUTO:END -->
