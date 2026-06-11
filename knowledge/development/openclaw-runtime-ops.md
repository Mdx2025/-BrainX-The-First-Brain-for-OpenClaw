---
domain: development
tags: [openclaw, agents, cron, discord, acp, gateway, debugging, sessions, ownership]
status: canonical
importance: 9
sensitivity: normal
auto_query: "openclaw runtime ops discord acp gateway cron agents debugging recovery sessions ownership"
---
# OpenClaw Runtime Ops

## Manual
Playbook canonico para fallos operativos recurrentes de OpenClaw, sus agentes, canales vivos, cron jobs, gateway y bridges. Aqui no va el incidente crudo completo; aqui van reglas que siguen siendo utiles despues del incidente.

## Regla de promocion
- `bugs.md` es el ledger crudo de incidentes, fixes, validaciones y tradeoffs.
- Este archivo solo debe absorber conocimiento reusable y duradero.
- No copiar aqui estados temporales, conteos puntuales, ni reportes post-upgrade que solo sirven como fotografia de una fecha.

## Workflow operativo
- Seguir escribiendo manualmente cada incidente nuevo en `/home/clawd/.openclaw/skills/brainx/data/bugs.md`.
- `bugs.md` no se reemplaza por `knowledge/`; sigue siendo la bitácora principal de bugs, reparaciones, verificaciones y contexto cronológico.
- Cuando un patrón ya demuestra ser reusable, promoverlo desde `bugs.md` a un tópico canónico de `knowledge/`.
- Regla simple:
  - `bugs.md` = incidente crudo y timeline
  - `knowledge/` = regla durable y playbook reutilizable

## Reglas
- Si un fallo aparece en Discord o en un canal `*-cli`, no asumir primero que el problema es del agente o del modelo; validar antes binding, approvals, runtime backend y salud del gateway.
- OpenClaw y CLIs externos no comparten automaticamente providers, auth ni estado de sesion; si una integracion depende de otro runtime, el wrapper explicito es parte del sistema, no un detalle accesorio.
- Si un agente `claude-cli` pierde continuidad despues de un reset o `--resume` fallido, tratarlo primero como problema de rollover sin handoff, no como amnesia del prompt; en este host la continuidad practica de esos agentes vive en `~/.claude/projects` mas que en el transcript casi vacio de OpenClaw.
- Un cron o watchdog solo vale si valida la superficie real. Un monitor sobre un unit inexistente, un puerto viejo o un endpoint equivocado mete ruido y baja confianza operacional.
- Si aparece `EACCES` o `PermissionError` sobre `~/.openclaw/agents/*/sessions/*.jsonl` o `sessions.json`, tratarlo primero como problema de ownership o identidad del escritor, no como fallo de modelo, auth o billing.
- El gateway es el escritor legitimo de sesiones live y debe correr bajo el usuario operativo del host; en este host esa identidad canonica es `clawd`.
- Ningun cron lanzado por `root` debe tocar stores de sesion de OpenClaw directamente. Si un wrapper puede ejecutarse desde `root`, debe bajar privilegios al usuario operativo antes de leer o escribir estado OpenClaw.
- Todo cambio sensible de runtime debe cerrar con cuatro pruebas: config parseable, restart o reload limpio, logs utiles y una senal funcional real del frente afectado.
- Si un fix expone comandos, secretos o approvals en un canal vivo, preferir primero el camino mas seguro (`dm`) y abrir al canal solo cuando el tradeoff este aceptado.
- Si `eventLoop.degraded` coincide con `prepStages` largos, status/config RPCs lentos o Discord heartbeat/fetch delays, no tratarlo como solo ruido del health checker. En hosts con `lossless-claw`/LCM y DB grande, validar si context-engine maintenance esta corriendo foreground dentro del hot path del gateway.

## Playbooks

### Discord exec approvals
- Si aparece `Exec approval is required, but chat exec approvals are not enabled on Discord`, revisar `channels.discord.execApprovals` antes de tocar el agente.
- Validar que `approvers` incluya el user ID real del requester.
- Usar `target = "dm"` por defecto si el approval puede exponer secretos inline.
- Usar `target = "both"` solo si el valor operativo de aprobar en canal compensa la exposicion extra.

### ACP y canales vivos
- Si una sesion ACP persistente cae en `queue owner unavailable`, tratarlo primero como problema de binding o salud ACP, no como fallo del prompt.
- Validar el frente ACP con una senal directa del bridge cuando sea posible.
- Si un canal vivo sufre timeouts o sesiones muertas recurrentes, preferir backend CLI normal antes que insistir con ACP persistente.
- En ACP/Claude Code, `Read /ruta/archivo` no adjunta archivos; solo los lee internamente. Si el agente no tiene tool `message`, debe copiar el entregable a `/home/clawd/.openclaw/media/` y responder con una linea standalone `MEDIA:/home/clawd/.openclaw/media/archivo.ext`.
- Para `MEDIA:` en ACP, no usar `/tmp`, `~` ni rutas dentro de `workspace-*`; mover primero a `/home/clawd/.openclaw/media/`.
- Si un agente ACP ya estaba en sesion persistente antes de esta regla, puede retener instrucciones viejas; hacer fresh reset solo de ese agente cuando el problema se observe en vivo.
- Si `MEDIA:` aparece como texto literal, revisar primero si el dispatcher ACP esta parseando lineas standalone a `mediaUrl/mediaUrls` antes de enviar al canal.
- Si el payload ya contiene `mediaUrl` pero Discord/WhatsApp entrega texto-only (`attachments=[]`, `hasMedia:false`), revisar el shim de deps del gateway: puede estar interceptando `sendMedia` y reenviando por `sendText`. En OpenClaw `2026.4.5`, el hotfix local fue hacer que `createChannelOutboundRuntimeSend` elija `outbound.sendMedia` cuando `opts.mediaUrl` o `opts.mediaUrls` estan presentes.

### Providers externos
- Si una CLI externa no ve el provider esperado, no asumir que heredara el auth de OpenClaw.
- Reutilizar el token o perfil ya existente puede ser correcto, pero el provider, el base URL y el modelo default deben declararse explicitamente en el wrapper o backend real.

### Gateway event loop y context engine
- Si un restart deja `eventLoop.degraded=true`, separar ruido de sampling corto vs bloqueo real. Ruido: health aislado con `top` idle y sin liveness warnings. Bloqueo real: `prepStages` de decenas de segundos, WS `status/config.get` lento, Discord fetch timer delayed o heartbeat ACK timeout.
- En OpenClaw `2026.5.3-1`, el incidente local de 2026-05-07 fue `lossless-claw` bootstrap maintenance esperado foreground desde `bootstrapHarnessContextEngine`, con `lcm.db` alrededor de 3.3GB. El fix local protegido por patch guard salta ese maintenance por default para `lossless-claw` y deja override `OPENCLAW_CONTEXT_ENGINE_BOOTSTRAP_MAINTENANCE=off|background|foreground`.
- Doc del incidente: `/home/clawd/.openclaw/brainx-docs/fix-openclaw-202653-lossless-claw-bootstrap-hotpath-20260507.md`.
- Despues de aplicar patches dist-level, recordar que el gateway vivo no los carga hasta restart; validar post-restart con logs de `prepStages`, no solo con `openclaw health`.

### Dist patch guard ownership
- Para scripts de patch dist de OpenClaw, usar exactamente un owner activo a la vez. Si hay 2+ terminales editando el mismo patch-script o reiniciando gateway, pausar y asignar ownership antes de escribir mas cambios.
- El gate verde debe incluir `node --check` del patch-script y de cada chunk JS tocado, no solo presencia de markers. `verify-only` puede verificar un marker aunque el JS generado sea invalido.
- Si un anchor de string-replace puede matchear dentro de una forma mas larga, por ejemplo `function X` dentro de `async function X`, no re-aplicar el patch tal cual. Exigir anchor exacto, transform estructural o test que demuestre que no genera sintaxis rota.
- Para chunks de Discord provider/message-handler, validar live chunk y snapshot, luego hacer un solo restart controlado y confirmar canal resuelto sin crash-loop.

### Claude CLI rollover
- Si OpenClaw invalida una sesion `claude-cli` por tamaño, edad, transcript faltante o `session_expired`, esperar continuidad solo si existe handoff durable; sin esa capa el agente puede responder “sin contexto” aunque el transcript viejo siga existiendo.
- En este host, el handoff de `claude-cli` vive en `~/.openclaw/state/claude-cli-handoffs/` y debe consumirse una sola vez en la primera sesion fresh del mismo `sessionKey` o `sessionId`.
- Antes de culpar a LCM, verificar si el historial util de ese agente esta realmente en `~/.claude/projects/.../*.jsonl` y no en el `.jsonl` de OpenClaw.

### Cron y watchdogs
- Cuando un monitor alerta, verificar primero que el target observado existe y sigue siendo el canonico.
- Un monitor sano debe vigilar el servicio, endpoint o path real; si no, conviene corregir el monitor antes que perseguir fantasmas.
- Antes de culpar al runtime, revisar si el mismo job esta duplicado en mas de una identidad (`root` y usuario operativo); cron duplicado basta para reintroducir drift de ownership.
- `cron-heartbeat-runner.sh` o wrappers equivalentes deben actuar como barrera de identidad: si arrancan con `EUID=0`, deben re-ejecutarse como el usuario operativo antes de tocar `state/` o `agents/*/sessions/*`.

### Ownership de sessions
- Si un canal live devuelve error generico y en logs aparece `EACCES` o `PermissionError`, revisar primero el owner del `.jsonl` activo y de `sessions.json`.
- No asumir de entrada mismatch de sesion, auth roto o timeout del provider si el archivo no es legible por el usuario del gateway.
- `sudo` sobre `~/.openclaw/agents/*/sessions/*` solo como repair puntual; despues restaurar ownership correcto y cerrar la fuente que lo ensucio.
- Si la reparacion local funciona pero el drift reaparece, investigar primero:
  - cron duplicado
  - wrappers ejecutados bajo `root`
  - procesos de backup o restore que reescriban sessions fuera del usuario operativo

## Casos promovibles desde `bugs.md`
- approvals de Discord
- bindings ACP inestables
- wrappers de providers externos
- watchdogs o crons con superficie equivocada
- errores del gateway que dejan una regla de diagnostico reusable

## No promover tal cual
- conteos puntuales de parches activos
- estados `post-upgrade` atados a una version concreta
- incidentes que ya no representan una regla reusable

<!-- BRAINX:AUTO:START -->
## BrainX Auto
_Última sincronización: 2026-06-05T22:15:34.599Z_
_Query: openclaw runtime ops discord acp gateway cron agents debugging recovery sessions ownership_

- [gotcha | imp:9 | ctx:openclaw:bugs] 2026-05-05 OpenClaw ACP incident: max concurrent sessions 12/12 was capacity saturation from 12 live claude-agent-acp runtimes, not a 4.26 cap difference. 4.26 also used cap 12 but had manager prepareFreshSession retry for persistent resume failures; 2026.5.3-1 lost that retry. Final fix: acp.maxConcurrentSessions=16, manager-CfCNcTAm.js restored prepareFreshSession retry, reapply guard verified=17 drift=0, validator C1 requires runtime-heal identity preservation plus manager retry. Full entry in ~/.openclaw/skills/brainx/data/bugs.md.
- [gotcha | imp:10 | ctx:openclaw:bugs] BUG RESUELTO 2026-04-28 21:31 -04: coder/Kimi exposed OpenClaw runtime context and BrainX mandatory recovery preflight in Discord by echoing display=false custom_message entries. Root cause: sanitize-user-facing-text stripped internal delimited context but not modern 'OpenClaw runtime context for the immediately preceding user message' echoes or BrainX preflight echoes; BrainX snapshot wording also exposed status=blocked/92 turns. Fix: bridge.ts recovery snapshot lines now use user-safe 'prior handoff' wording and instruct silent use; patched dist/sanitize-user-facing-text-DgEphtot.js with stripReasoningAndRuntimeContextEcho to remove runtime context, BrainX preflight echoes, and stray think tags before channel delivery; archived/deleted poisoned coder session 7472d7fe. Validation: node --check OK for bridge/sanitizer/auditor; signal-gate 17/17; sanitizer simulations strip runtime-only and preflight-only echoes while preserving real answer after </think>; gateway RPC OK; Discord connected; audit reports 44 applied including runtime-context leak sanitizer.
- [gotcha | imp:10 | ctx:openclaw:bugs] OpenClaw 2026.5.6 gotcha: gateway config watcher (server-reload-handlers-CNCGSeR3.js applySnapshot via diffConfigPaths) generates phantom 'env.X changed' deltas in compareConfig comparison even when process.env values are bit-identical and source files have identical md5. Root cause: compareConfig construction uses {...env} spread (io-DDcMg_WY.js:18667 envSnapshotForRestore) and re-load reconstruction differs from boot snapshot in non-content ways. Symptom that's easy to misdiagnose: every ~3 min '[reload] config change detected; evaluating reload (env.OPENAI_API_KEY, ...)' followed by '[reload] config change requires gateway restart' followed by SIGUSR1. Looks like external env mutator but no mutator exists — verified by inotifywait/poll md5sum 8min showing zero physical changes. The 3 OAuth/credential timers (claude-acp-token-sync, claude-credential-sync, gemini-oauth-refresh) all have 'if new == old: return changed=False' guards and are NOT the source. sync-openclaw-env.sh also has 'rendered != current.read_text()' guard. Fix: add {prefix:'env',kind:'none'} as first entry of BASE_RELOAD_RULES_TAIL in dist/config-reload-plan-DBZfWK-S.js (marker OPENCLAW_ENV_RELOAD_NOOP_20260507). Architecturally correct because process.env of Node is captured at boot from systemd EnvironmentFile= and cannot mutate during runtime — any 'env.X changed' reported by watcher in runtime is spurious by definition. Bug observed first 2026-05-07 with 49 restarts/day. Verified: with patch, 12+ min and 17+ min gateway uptime sin SIGUSR1, Discord channel status 'connected'. Cross-agent value: any agent investigating mysterious gateway restart loops or Discord 'awaiting gateway readiness' stuck patterns should check journalctl for '[reload] config change detected (env.X' and apply this patch instead of going down the rabbit hole of 'Discord plugin Carbon Client lifecycle bug' which can be just downstream symptom.
- [gotcha | imp:10 | ctx:openclaw:bugs] BUG RESUELTO 2026-04-28 20:09 -04: BrainX handoff no era obligatorio tras rotación de sesión OpenClaw. Síntoma: agentes como coder podían responder 'no tengo contexto' tras idle reset aunque existían reply context, snapshots y artefactos como /home/clawd/.openclaw/media/MDX_Email_Training_Manual_v5.docx. Causa raíz: bridge.ts solo disparaba snapshots por SESSION_CONTINUITY_RE/router; frases como 'Estábamos en esta tarea' caían en short y 'adjúntame el nuevo doc' podía quedar no-signal. Fix: /home/clawd/.openclaw/extensions/brainx/src/bridge.ts ahora tiene mandatory recovery preflight por has_reply_context, continuidad en español/inglés y referencias a doc/archivo; inyecta bloque corto con reply context, brainx_session_snapshots y brainx_artifact_ledger antes de permitir no-context. Artifact ledger lazy + schema/migration 012_artifact_ledger.sql captura rutas durables desde llm_output/tool_result. Validación: signal-gate tests 14/14, bridge tests 3/3, scope-intent tests 20/20, node --check bridge.ts, OpenClaw config valid, gateway RPC OK, Discord connected; simulación coder recuperó MDX_Email_Training_Manual_v5.docx desde snapshot.
- [fact | imp:10 | ctx:project:openclaw] Handoff summary for main/openclaw: OpenClaw media autostage live validation action-route 2026-05-05 13:22 AST: /home/clawd/openclaw-autostage-live-20260505.png Discord media/autostage live retest fixed 2026-05-05 13:25 AST /home/clawd/openclaw-autostage-live-20260505.png Bastantes bugs abiertos. Voy a priorizar los que matchean con nuestro setup (Discord, gateway restart, memory, exec, cron). Errors: error body, hiding provider error detail (e.g. Gemini 400) 2026-05-06T01:36:04Z; fail with -32001 (followup to #57969) 2026-05-05T22:12:50Z Blockers: 78264 OPEN [Bug]: Telegram replies may be duplicated after a gateway restart / auto-compaction retry. bug, bug:behavior 2026-05-06T04:22:12Z 78262 OPEN Feishu: topic session key mismatch — first messa; 78196 OPEN [Bug]: Extension plugins silently skipped by gateway loader in v5.3+ (loads in CLI process, not in long-running daemon) bug, regr… - Handoff artifact for main/openclaw: image at /home/clawd/openclaw-autostage-live-20260505 - Relevant session notes: OpenClaw media autostage live validation action-route 2026-05-05 13:22 AST: /home/clawd/openclaw-autostage-live-20260505 - Gemini 400) 2026-05-06T01:36:04Z; fail with -32001 (followup to #57969) 2026-05-05T22:12:50Z Blocker… Use this path as the durable artifact candidate when the user asks for the prior/final document or file
- [fact | imp:8 | ctx:project_registry:openclaw_gateway] El gateway openclaw está corriendo correctamente con PID [REDACTED] y RPC operativo tras las correcciones de configuración y variables de entorno.
<!-- BRAINX:AUTO:END -->
