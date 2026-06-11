# brainx.md - BrainX Memory System

> **Sistema de memoria vectorial compartida** entre todos los agentes de OpenClaw.
> Usa PostgreSQL + pgvector + OpenAI embeddings para búsqueda semántica.

---

## ¿Qué es BrainX?

BrainX permite que los agentes:
- **Guarden** memorias persistentes (decisiones, aprendizajes, notas)
- **Busquen** por similitud semántica (no solo palabras clave)
- **Compartan** contexto entre sesiones y entre agentes
- **Compilen** una wiki navegable y compatible con Obsidian
- **Complementen** el runtime con un digest compilado via plugin `brainx`

Es la **memoria colectiva** de todos tus agentes.

### Naming actual

- **Marca/capa canónica:** `BrainX`
- **Comando/skill canónico:** `brainx`
- **Ruta real del host:** `~/.openclaw/skills/brainx`
- **No usar nombres versionados antiguos** como rutas canónicas en este host

### Split actual

- `BrainX` = memoria persistente de largo plazo
- `BrainX Wiki` = capa compilada read-mostly para claims, dashboards, digests y Obsidian
- `brainx plugin` = unica ruta runtime para digests compilados + recall/advisories cuando se habiliten
- `LLM del agente` = razonamiento

Los hooks internos `brainx-auto-inject` y `brainx-live-capture` quedan como superficie legacy/review-gated. No son la ruta normal de runtime en este host.

La working memory nueva no reemplaza BrainX. Mantiene estado vivo de la sesion actual:

- objetivo actual
- tarea actual
- ultimo error relevante
- ultimo tool usado
- archivos/comandos recientes
- siguiente paso

Si se habilita, puede usar un LLM barato como `MiniMax-M2.7` para resumir y compactar ese estado, pero la fuente de verdad base sigue siendo estructurada y deterministica.

### lossless-claw absorbido como feature interno de BrainX (2026-05-29, fork in-place)

`lossless-claw` (`@martian-engineering` v0.10.0, motor de contexto de terceros) **ya NO es un plugin separado**: BrainX lo **carga en proceso como capacidad interna**. Para OpenClaw existe **un solo plugin: BrainX**. La regla sigue siendo **un solo orquestador del prompt: BrainX**, pero ahora la neutralización es **estructural** (no un text-patch frágil sobre el dist de lossless que un update pudiera borrar).

Las tres capas NO son redundantes — cada una resuelve algo distinto:

- ⚙️ **Compactación nativa de OpenClaw** = trunca turnos viejos al llegar al límite de tokens (lossy, intra-conversación). Fallback. (El context-engine slot está en `"legacy"`: lossless nunca fue el engine activo.)
- 🗜️ **lossless-claw** = graba el transcript verbatim en `lcm.db` (SQLite, ~4 GB) vía sus hooks de sesión (`session_end`/`before_reset`) y expone recall on-demand. Lossless, intra-conversación. **El archivo.**
- 🧠 **BrainX** = memoria semántica curada cross-session + **único dueño del `before_prompt_build`** + **host del motor lossless**. **El cerebro/orquestador.**

Cómo está absorbido (marker `LOSSLESS_ABSORB_20260529`):
- BrainX importa lossless como **especificador externo** `import lcmPlugin from "lossless-claw"` (resuelto por symlink `extensions/brainx/node_modules/lossless-claw → ../../lossless-claw`; esbuild lo deja `--external`, no lo bundlea). Sus `node_modules` (sqlite-vec/`vec0.so`, `@earendil-works/*`) resuelven desde su carpeta real (Node usa el real-path del symlink).
- En `register()`, BrainX llama `lcmPlugin.register(buildLosslessApiShim(api))` (`src/lossless-bridge.ts`). El **shim** es un Proxy sobre el `api` que:
  - **DROPEA** `on("before_prompt_build")` → BrainX es el único que inyecta. Neutralización estructural (nunca reenvía el registro), update-proof.
  - **reenvía** todo lo demás: `registerContextEngine` + 4 tools (`lcm_grep`/`lcm_describe`/`lcm_expand`/`lcm_expand_query`) + `registerCommand(lossless)` + `on(session_end|before_reset|gateway_start|gateway_stop)` → captura, recall y command quedan vivos.
  - **sintetiza** la vista de config que lcmPlugin necesita: sus lookups internos están hardcodeados a `plugins.entries["lossless-claw"].config/.llm`, pero esa entry **ya no existe en openclaw.json** — el shim la inyecta on-the-fly desde `plugins.entries.brainx.config.lossless` (marker `LOSSLESS_ABSORB_CONFIG_20260530`). `pluginConfig: {}` para que lcmPlugin caiga al config sintetizado.
- BrainX declara `contracts.tools: [lcm_grep, lcm_describe, lcm_expand, lcm_expand_query]` en su `openclaw.plugin.json` para surfacearlas.

Cuándo usar las tools `lcm_*` (como agente): solo para recuperar el **texto exacto de turnos previos de ESTA conversación** que la compactación pudo descartar. Para memoria entre sesiones / largo plazo, usar BrainX (recall semántico). Roles disjuntos: lossless = fidelidad intra-conversación; BrainX = conocimiento cross-session.

Config (en `openclaw.json`) — **fuente única bajo BrainX, cero referencias a `lossless-claw`**:
- La entry `plugins.entries.lossless-claw` **fue eliminada** y `lossless-claw` **quitado del `plugins.allow`** → OpenClaw no lo conoce como plugin. El dir `extensions/lossless-claw/` queda solo como librería que BrainX importa.
- `plugins.entries.brainx.config.lossless` = `{ config: {...}, llm: {...} }` → **la config de lossless vive acá** (contextThreshold, freshTailCount, ignoreSessionPatterns + política de modelo `gpt-5.4-mini`). El shim la sintetiza como `entries["lossless-claw"]` para los lookups de lcmPlugin.
- `plugins.entries.brainx.config.losslessRecallHandoff: true` → BrainX referencia las tools en su recovery preflight cuando hay contenido sustantivo.

Por qué fork in-place y no copia física: conserva mejoras upstream (el código vive en su carpeta, no se congela) y evita el riesgo de re-vendorizar `node_modules` nativos. Rollback: restaurar `openclaw.json` + `extensions/brainx/{index.ts,src/,dist/index.js,openclaw.plugin.json}` desde backups + restart (vuelve a ser plugin independiente con su entry+allow). Backups: `backups/brainx-pre-lossless-absorb-*` (absorción), `backups/brainx-pre-config-migrate-*` (migración de config), `backups/openclaw.json.bak-pre-*`.

Build de BrainX (esbuild manual, reproducible byte-a-byte):
`npx esbuild index.ts --bundle --platform=node --target=node22 --format=esm --outfile=dist/index.js --external:openclaw --external:lossless-claw --external:"@earendil-works/*"`

Pendiente: política de retención/poda de `lcm.db` (vía el command `lossless`) + envío a R2. Detalle e incidentes: memorias `project_lossless_claw_disabled_20260529` + `project_discord_async_const_channel_crash_20260529`.

---

## 🚀 Comandos Disponibles

### Estado del sistema
```bash
brainx health
```
Verifica conexión a PostgreSQL y pgvector.

### Agregar memoria
```bash
# Nota simple
brainx add --content "Decisión importante sobre API" --type note

# Decisión importante (alta prioridad)
brainx add --type decision --content "Usar Railway para deploy" --tier hot --importance 9 --tags deploy,infrastructure

# Aprendizaje
brainx add --type learning --content "MiniMax funciona mejor para código que GLM" --tier warm --importance 7

# Acción realizada
brainx add --type action --content "Actualizado AGENTS.md en todos los workspaces" --agent main
```

**Flags importantes:**
- `--type`: note | decision | learning | action | fact | gotcha
- `--tier`: hot (siempre disponible) | warm (contexto relevante) | cold | archive
- `--importance`: 1-10 (default: 5)
- `--tags`: separados por coma
- `--agent`: nombre del agente (main, coder, reasoning, etc.)

### Buscar memorias
```bash
# Búsqueda simple
brainx search --query "configuración railway"

# Búsqueda avanzada
brainx search --query "deploy" --tier hot+warm --minImportance 7 --limit 10

# Buscar por contexto específico
brainx search --context "openclaw" --limit 5
```

### Inyectar en sesión actual
```bash
# Obtener memorias formateadas para el prompt
brainx inject --tier hot+warm --limit 5 --minImportance 5

# Esto genera output como:
# [sim:0.92 imp:9 tier:hot type:decision agent:main]
# Usar Railway para deploy...
```

### Auditar runtime
```bash
# Reporte de inyecciones runtime, con señal hard/soft separada
brainx runtime-report --days 7
brainx runtime-report --days 7 --json

# Reporte consolidado por agente: config + cobertura + métricas runtime
brainx agent-metrics --days 7
brainx agent-metrics --days 7 --json
brainx agent-metrics --days 7 --include-media-gen

# Calidad del router: utilidad, precisión aproximada, drops y latencia
brainx router-quality --days 7
brainx router-quality --days 7 --agent matrix
brainx router-quality --days 7 --surface jit_recall --json

# Explicar una decisión de inyección concreta
brainx explain --id <runtime_injection_id>
brainx explain --agent coder --limit 1
brainx explain --sessionKey <session_key> --limit 3 --json
```

`runtime-report` es read-only y usa:
- `hard_signal_ratio_pct = sum(referenced_count) / sum(selected_count)`
- `soft_signal_ratio_pct = sum(soft_referenced_count) / sum(selected_count)`

`explain` es read-only y sirve para ver surface, prompt preview, decisión del router/surface planner, memorias seleccionadas y si luego fueron referenciadas hard/soft.

`agent-metrics` es read-only y cruza la lista real de agentes en `openclaw.json`, la config del plugin `brainx`, y `brainx_runtime_injections`. Devuelve por agente:
- BrainX habilitado/deshabilitado y motivo.
- features activas por agente.
- última inyección.
- inyecciones, memorias seleccionadas, hard/soft signal, drops y latencia.
- superficies usadas.
- estado operativo: `healthy`, `low-signal`, `no-recent-activity`, `disabled-intentional` o `plugin-disabled`.

Por defecto excluye agentes `media-gen*` porque son agentes visuales; usar `--include-media-gen` para incluirlos en auditorías completas.

`router-quality` es read-only y mira solo filas runtime donde el router estuvo activo. Devuelve:
- eventos de router, applied/errors/fail-closed.
- propuestas del router, selected overlap, strict guard drops y signal gate drops.
- hard/soft signal posterior.
- latencia total y latencia del router.
- etiquetas de calidad para muestra reciente: `good`, `safe-empty`, `weak`, `pending-score`, `router-error` o `no-selection`.

Usarlo antes de tocar prompt del router, thresholds, strict guards o reglas de fatiga.

### Event Ledger determinístico
```bash
# Guardar evento importante con evidencia
brainx event add --type fix --project brainx --domain observability \
  --title "Runtime report corrected" \
  --summary "Corrected hard/soft signal metrics and validated tests"

# Buscar por proyecto/dominio/fecha
brainx event search --project brainx --domain observability --from 2026-05-01 --to 2026-05-02

# Ver un evento exacto
brainx event show --id evt_20260501_brainx_runtime_observability_explain_cli
```

Usar Event Ledger para fixes, incidents, decisions, deployments, handoffs y audits. Complementa `brainx search`: memoria semántica responde "qué es relevante"; Event Ledger responde "qué ocurrió, cuándo, dónde y con qué evidencia".

### BrainX Wiki + Obsidian
```bash
# Ver estado del vault compilado
brainx wiki status

# Crear vault compatible con Obsidian
brainx wiki init

# Compilar knowledge + memorias durables al vault
brainx wiki compile

# Leer digest compartido o por agente
brainx wiki digest --agent coder

# Validar freshness, claims y compatibilidad Obsidian
brainx wiki lint
```

**Default vault:** `~/brainx-vault`

---

## 📋 Cuándo Usar BrainX

| Situación | Acción Recomendada |
|-----------|-------------------|
| Antes de responder algo complejo | `brainx search --query "contexto"` |
| Tomar una decisión importante | `brainx add --type decision --tier hot` |
| Aprender algo nuevo | `brainx add --type learning` |
| Completar una tarea significativa | `brainx add --type action` |
| Investigación | Buscar info previa antes de empezar |
| Delegar a otro agente | Agregar contexto para el siguiente agente |

---

## 🏷️ Sistema de Tiers

| Tier | Uso | TTL aproximado |
|------|-----|----------------|
| **hot** | Decisiones críticas, configuraciones actuales | Siempre accesible |
| **warm** | Aprendizajes recientes, contexto útil | Semanas |
| **cold** | Historial, referencias | Meses |
| **archive** | Registro histórico | Años |

---

## 👥 Agentes Disponibles

Todos los agentes pueden usar BrainX:

**Agentes principales:**
- `main` (Jarvis) - Agente principal
- `coder` - Desarrollo de código
- `reasoning` - Razonamiento profundo
- `researcher` - Investigación
- `writer` - Escritura creativa
- `clawma` - Tareas auxiliares
- `support` - Soporte
- `monitor` - Monitoreo
- `raider` - Outreach / leads
- `bill` - Bill
- `karl` - Karl
- `alert` - Alertas y SEO publisher
- `kron` - Reasoning / cron tasks
- `max` - Writer / SEO
- `animus` - Writer
- `venus` - Writer
- `ghost` - Writer
- `echo` - Raider (canal público)
- `matrix` - Writer
- `sonnet` - Clawma

**CLIs y agentes de coding:**
- `claude-cli` - Claude Code CLI
- `codex-cli` - Codex CLI
- `gemini-cli` - Gemini CLI
- `kimi-cli` - Kimi CLI
- `opencode-cli` - OpenCode

**Agentes de canal (privados/públicos):**
- `coder-public`, `coder-private-social-media`
- `researcher-public`, `researcher-private`
- `support-public`, `support-private`, `support-private-emails`
- `monitor-public`
- `reasoning-private-propuestas`

---

## 🔄 Flujo de Trabajo Recomendado

```
1. Usuario hace una pregunta
2. → brainx search --query "pregunta del usuario"
3. Si encuentras info relevante → úsala en tu respuesta
4. Si no → responde con tu conocimiento actual
5. Si es información importante para recordar:
   → brainx add --content "dato importante" --tier warm
```

## 🔧 Antes de Cambiar BrainX

Cuando diagnostiques o parches BrainX, no vayas directo del sintoma al fix. Primero recorre las superficies reales que pueden estar involucradas:

1. Runtime plugin: `~/.openclaw/extensions/brainx/src/bridge.ts`; tambien `router.ts`, `config.ts` y `runtime-deps.ts` si toca routing, policy, config o carga de dependencias.
2. Dependencias runtime del skill: `~/.openclaw/skills/brainx/lib/working-memory.js`, `lib/db.js`, `lib/openai-rag.js`, `lib/advisory.js` o `lib/brainx-phase2.js` segun el caso.
3. Daily Core si el sintoma toca cron, handoff, wiki, cleanup, promotion o memoria programada: `/home/clawd/.openclaw/workspace/scripts/brainx-daily-core-wrapper.sh`, `docs/CRON.md` y el script especifico del paso afectado.
4. Verdad actual del host: `docs/RUNTIME_STATUS.md`, `config/surface-policy.json`, `brainx doctor --full --json` y `HOME=/home/clawd openclaw gateway call brainx.status`.
5. Evidencia previa: `brainx search --query "<sintoma o surface>"`, `brainx runtime-report`, `brainx router-quality` o `brainx explain` segun aplique. Las memorias son pistas, no autoridad.

Gates anti-regresion:
- Ruta runtime: `~/.openclaw/extensions/brainx/package.json` declara `runtimeExtensions: ["./dist/index.js"]`. Antes de decir que un cambio del plugin esta vivo, confirma si OpenClaw carga `index.ts` o `dist/index.js`; sincroniza fuente, bundle runtime y tests, o documenta por que solo cambia una ruta.
- Config: mantener alineados `src/config.ts`, `openclaw.plugin.json`, `~/.openclaw/openclaw.json`, `config/surface-policy.json` y `docs/CONFIG.md`. Cuidado con keys nuevas: el schema del plugin usa `additionalProperties: false`.
- DB/schema: agregar migracion idempotente en `sql/migrations/`, actualizar `docs/SCHEMA.md`, y extender `doctor`/`fix` si el invariante puede volver a romperse. Evitar cambios destructivos en caliente; escribir rollback/restore antes de tocar data productiva.
- Prompt-time: preservar el presupuesto actual de `before_prompt_build` tanto en source como en bundle runtime, single-flight, router fail-closed, presupuesto por turno, denylist de ops agents, politica ACP quieta, filtro `active_scope` y recuperacion por `session_rotation`.
- Telemetria: cambios en seleccion, scoring, policy o delivery deben dejar utiles `brainx_runtime_injections`, `brainx_policy_decisions`, `brainx_session_rotation_events`, `brainx explain`, `runtime-report` y `router-quality`; verificar que selected rows se scorean o se finalizan deliberadamente.
- Privacidad/salida: mantener PII/secret scrubbing, recalibracion de sensibilidad, wording seguro de recovery preflight y sanitizacion de delivery. Nunca exponer labels internos, runtime context, credenciales, envelopes de sesion crudos ni memorias restricted.
- Tests: agregar casos negativos, no solo happy path: memorias no relacionadas rechazadas, ops agents quietos, ACP generic recall suprimido, session rotation solo recupera prompts significativos, artifacts debiles degradados y cross-agent recall gobernado por la config activa. Si tag/verificacion estan encendidos, testearlos directo; si estan apagados en este host, testear router/context-broker/scope guards.
- Docs/ledger: si cambia comportamiento, actualizar los docs relevantes (`README.md`, `CHANGELOG.md`, `docs/RUNTIME_STATUS.md`, `docs/CRON.md`, `docs/TESTS.md`, `brainx.md`) y crear Event Ledger para cambios validados de arquitectura/runtime.

Validacion minima:
- Archivo JS/TS/MJS editado: `node --check <file>` cuando el runtime lo soporte.
- Plugin editado: `npm test` con workdir `/home/clawd/.openclaw/extensions/brainx`.
- Skill CLI/libs/scripts editados: `npm test` y `npm run test:smoke` con workdir `/home/clawd/.openclaw/skills/brainx` si DB/env estan disponibles.
- Runtime/config/Daily Core/recovery/policy/telemetry/bundle editado: `/home/clawd/.openclaw/workspace/scripts/brainx-regression-suite.sh` y checks OpenClaw relevantes (`openclaw config validate --json`, health/status smoke, gateway `brainx.status`, journal loaded-line o dry-run del wrapper si existe).
- Si el cambio requiere reload del gateway: reiniciar solo despues de tests/config validate, luego confirmar `openclaw health --json`, `openclaw tasks audit --json` y smoke dirigido de la surface cambiada sin ruido publico.
- Incidente OpenClaw/runtime/tool/integracion resuelto: registrar en BrainX bugs con fecha, version OpenClaw, archivos, validacion, estado y rollback/workaround.

---

## 🔧 Configuración

**Ubicación canónica:** `~/.openclaw/skills/brainx/`
**Compatibilidad:** `~/.openclaw/skills/brainx/`
**Estado operativo real:** `~/.openclaw/skills/brainx/docs/RUNTIME_STATUS.md`
**Policy registry:** `~/.openclaw/skills/brainx/config/surface-policy.json`

**Variables requeridas:**
- `DATABASE_URL` - PostgreSQL con pgvector
- `OPENAI_API_KEY` - Para generar embeddings

**Ruta runtime actual:**
- Plugin: `~/.openclaw/extensions/brainx/`
- Config: `~/.openclaw/openclaw.json -> plugins.entries.brainx.config`
- Vault wiki: `~/brainx-vault` o `BRAINX_WIKI_VAULT_DIR`
- Baseline real del host: `wikiDigest=true`, `wikiDigestPromptSignalsOnly=true`, `jitRecall=true`, `workingMemory=true`, `toolAdvisories=true`, `bootstrapMode=off`, `captureOutboundMode=off`
- Router runtime: `routerMode=active`, primary `gpt-5-nano`, fallback disabled (`routerFallbackModel=""`); timeout/error keeps only strictly aligned candidates
- Policy controller runtime: `policyController=true`, `policyDecisionLog=true`. Esta es la capa anti-calibracion manual: usa `brainx_runtime_injections` por agente/surface para permitir, suprimir o explorar surfaces segun utilidad reciente. `recovery_preflight`, recall explicito y `project_ground` deterministico quedan protegidos.
- Handoff runtime: `BrainX Session Snapshot` every 4h + `handoff-promoter` to durable hot memories and `brainx_artifact_ledger`
- Context broker runtime: plugin classifies every turn, selects one context surface, and keeps ACP agents quiet only at the injection layer unless the turn asks for recovery, historical/procedural memory, or troubleshooting evidence. ACP turns must still pass through BrainX typed runtime hooks for intake, working-memory state, and scoring telemetry.
- Artifact runtime: `brainx_artifact_ledger` v2 stores `artifact_role`, `provenance`, `finality_score`, and metadata so final deliverables outrank `/tmp`, tool-read, and exec noise
- Session state runtime: `brainx_context_state` keeps a compact latest state per `agent + session_key` for recovery after OpenClaw rotates `sessionId`
- Recovery runtime: semantic recovery preflight can trigger from recent context state, artifact ledger and session snapshots; it also detects a changed OpenClaw `sessionId` for the same `sessionKey` before overwriting state, so short meaningful follow-ups after rotation can recover. `session_rotation` has priority over generic triggers and is logged in `brainx_session_rotation_events`.
- Rotation telemetry: `/home/clawd/.openclaw/workspace/scripts/brainx-session-rotation-monitor.mjs` summarizes `brainx_session_rotation_events` by agent/sessionKey and reports whether recovery fired and handoff was injected. Rotation timestamps are normalized to ISO before DB insert; `/home/clawd/.openclaw/workspace/scripts/brainx-backfill-rotation-events.mjs` can repair historical runtime rows that missed the event table.
- Scoring fallback: exact `NO_REPLY`/`HEARTBEAT_OK` does not clear selected-injection cache. The plugin observes typed `message_sent` as scoring-only so Codex/background delivery-mirror replies can close `recovery_preflight` telemetry by `sessionKey` without enabling broad live capture or replaying raw transcripts. `brainx_runtime_injections.session_key` is persisted, and stale selected rows with no visible answer are finalized as zero-reference telemetry by `brainx-injection-health.sh` after the scoring window.
- Runtime observability: `brainx runtime-report` reports aggregate hard and soft signal ratios from `brainx_runtime_injections`; `brainx explain` inspects an individual runtime injection decision without changing runtime behavior.
- Policy observability: `brainx_policy_decisions` records the controller action/reason/stats per prompt surface. Before changing thresholds, inspect this table together with `brainx runtime-report` and `brainx router-quality`.
- Event Ledger: `brainx_event_ledger` is the deterministic forensic index for fixes/incidents/decisions/handoffs/audits. It complements semantic memories and should be used for validated architecture/runtime changes.
- ACP runtime-heal boundary: Claude ACP continuity/repair is owned by `claude-cli-runtime-heal` and ACP `resumeSessionId`/handoff consumers. BrainX must not reset ACP sessions, rewrite ACP metadata, or compete with upstream resume. BrainX may only add compact prompt-time evidence when the turn needs memory/recovery.
- Ops-agent recall policy: `alert`, `monitor`, and `monitor-public` are excluded from JIT recall to avoid cron/heartbeat context noise and unscored telemetry
- Scheduler reality: 4 direct BrainX/Memory OpenClaw jobs; 8 including mixed `clawd` crontab wrappers; Daily Core wrapper runs 15 daily steps, 2 Wednesday/Sunday steps, 7 Sunday-only steps
- `captureToolFailures`: `true`
- `writeFailuresToDailyMemory`: `true`
- `writeFailuresToBrainx`: `true`
- Cambios recomendados: modificar capacidades una por una, pero cualquier surface de escritura en runtime debe quedar global o apagada; no usar pilotos parciales por agente como estado estable
- Surfaces manuales/dormidas/deshabilitadas deben evaluarse contra `config/surface-policy.json`, no por mera existencia de scripts o tablas

**Artefactos legacy:**
- `BRAINX_CONTEXT.md` y `brainx-topics/` pueden existir por compatibilidad o troubleshooting
- No deben cargarse automáticamente en cada sesión

---

## 💡 Tips

- Usa `--tier hot` para configuraciones que usas diariamente
- Usa `--importance 9-10` para decisiones arquitectónicas
- Busca antes de preguntar - alguien podría haber documentado la respuesta
- Agrega contexto cuando termines una tarea compleja para el próximo agente
- BrainX no reemplaza a memory/YYYY-MM-DD.md - son complementarios

---

---

## 👍 Memory Feedback (Feature #27)

Permite calificar memorias para refinar la calidad del sistema. Las memorias marcadas como inútiles o incorrectas se penalizan en futuras búsquedas.

```bash
# Marcar una memoria como útil (sube su score)
brainx feedback --id mem_abc123 --rating useful

# Marcar como inútil (baja su score)
brainx feedback --id mem_abc123 --rating useless

# Marcar como incorrecta (penalización fuerte)
brainx feedback --id mem_abc123 --rating incorrect

# Marcar como dudosa
brainx feedback --id mem_abc123 --rating doubtful
```

El `feedback_score` afecta el ranking de búsqueda: memorias con feedback negativo aparecen más abajo o se excluyen.

---

## 📝 Learning Details (Feature #29)

Extrae metadata extendida de memorias tipo `learning` y `gotcha` para enriquecer el contexto.

En este host el script existe, pero no forma parte del scheduler consolidado actual. Tratarlo como superficie manual o dormida salvo que `docs/RUNTIME_STATUS.md` indique lo contrario.

```bash
# Ejecutar manualmente
node scripts/learning-detail-extractor.js --verbose

# Solo para un agente
node scripts/learning-detail-extractor.js --agent coder --verbose
```

Almacena en la tabla `brainx_learning_details`: causa raíz, impacto, solución aplicada, y si es reproducible. Mejora la calidad de las inyecciones futuras cuando se ejecuta.

---

## 🏗️ Session Snapshots (Feature #33)

Captura el estado completo de un agente al cerrar sesión para análisis posterior.

En este host sí está activo en scheduler: OpenClaw cron `BrainX Session Snapshot` corre cada 4h vía `/home/clawd/.openclaw/workspace/scripts/brainx-session-snapshot-cron.sh`, ejecuta `scripts/session-snapshot.js --hours 5 --max-sessions 12 --json` y luego alimenta `handoff-promoter`.

```bash
# Ejecutar ciclo manual de snapshots recientes
node scripts/session-snapshot.js --hours 5 --max-sessions 12 --json

# Estado operativo
brainx doctor --json
openclaw cron list --json
```

Los snapshots se almacenan en `brainx_session_snapshots`; `handoff-promoter` puede promover señales estables a `brainx_memories` tier hot y artefactos finales a `brainx_artifact_ledger`.

---

## 🧹 Low-Signal Cleanup (Feature #34)

Elimina memorias de bajo valor: duplicados semánticos, contenido muy corto, memorias antiguas sin accesos, o con feedback negativo acumulado.

```bash
# Ejecutar limpieza (modo seguro: muestra qué eliminaría)
node scripts/cleanup-low-signal.js --dry-run

# Ejecutar limpieza real
node scripts/cleanup-low-signal.js

# Con verbose para ver cada decisión
node scripts/cleanup-low-signal.js --verbose
```

En este host no forma parte del wrapper diario+semanal actual. Criterios de limpieza cuando se ejecuta:
- Memorias con `importance < 3` y sin accesos en 30+ días
- Memorias con `feedback_score < -2`
- Memorias supersedidas (con `superseded_by` no nulo)
- Contenido menor a 20 caracteres

---

## 🔃 Memory Reclassification (Feature #35)

Reclasifica memorias que fueron auto-tipificadas incorrectamente. Útil después de cambios en las reglas de clasificación.

```bash
# Reclasificar memorias (modo seguro)
node scripts/reclassify-memories.js --dry-run

# Reclasificar memorias reales
node scripts/reclassify-memories.js

# Solo memorias de un agente
node scripts/reclassify-memories.js --agent coder --verbose
```

Revisa memorias existentes y corrige `type` y `category` cuando la clasificación original no coincide con el contenido actual. Los cambios se registran en el log de distilación.

---

**Documentación completa:** Ver `SKILL.md` en `~/.openclaw/skills/brainx/`

**Actualizado:** 2026-05-01

---

## 🧠 Auto-Escritura (OBLIGATORIO para todos los agentes)

Después de completar una tarea significativa, evalúa si hubo algo que guardar:

| Situación | Comando |
|-----------|---------|
| Decisión importante | `brainx add --type decision --context agent:TU_ID --importance 7 --content "..."` |
| Error/bug resuelto | `brainx add --type learning --context agent:TU_ID --importance 7 --content "..."` |
| Gotcha/trap descubierto | `brainx add --type learning --context agent:TU_ID --importance 8 --content "..."` |
| Algo nuevo sobre el sistema | `brainx add --type learning --context agent:TU_ID --importance 6 --content "..."` |
| Tarea rutinaria sin novedad | No escribir nada |

**Ruta del CLI:** `cd ~/.openclaw/skills/brainx && ./brainx add ...`

### Namespace Convention (OBLIGATORIO)

Usar SIEMPRE `--context` con el namespace correcto:
- `agent:coder`, `agent:writer`, `agent:main`, `agent:raider`, etc.
- `project:emailbot`, `project:ia-robots` para proyectos
- `global` para memorias cross-agent

### Tags recomendados

Agregar siempre `--tags` con al menos el nombre del agente:
`--tags "agent:coder,project:emailbot,api-fix"`

### NO escribir en BrainX:
- Operaciones rutinarias (commits, deploys exitosos sin novedad)
- Contenido de archivos completos
- Logs o outputs de herramientas
- Mensajes del usuario
