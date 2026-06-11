# Cómo Funciona BrainX V5

BrainX es el sistema de memoria persistente de OpenClaw. Usa PostgreSQL + pgvector + OpenAI embeddings para que los agentes recuerden entre sesiones, aprendan de conversaciones pasadas, y compartan conocimiento entre sí.

Desde la evolucion V6, el runtime se separa asi:

- `BrainX skill` = memoria larga, retrieval, cron, knowledge sync
- `brainx plugin` = context broker prompt-time: working memory de sesion, JIT recall, recovery preflight, artifact ledger, advisories, tool-failure capture
- `claude-cli-runtime-heal` / ACP = salud de sesiones Claude ACP, metadata stale, `acpxSessionId`, resume/handoff runtime
- `LLM` = razonamiento

Regla de frontera: BrainX no cura procesos ACP ni reescribe metadata ACP. Si un agente Claude ACP rota o se cura por runtime-heal, esa capa manda. BrainX solo complementa con evidencia compacta si el prompt actual necesita memoria, recovery, contexto historico/procedural o troubleshooting.

---

## 1. Ciclo de Vida de una Memoria

```
Conversación / Archivo .md
        │
        ▼
   ┌─────────┐     ┌──────────┐     ┌──────────┐     ┌────────────┐
   │ Captura  │ ──► │ Embedding│ ──► │ Storage  │ ──► │ Retrieval  │
   │          │     │ (OpenAI) │     │ (Postgres│     │ / digest   │
   │ Scripts  │     │ 1536-dim │     │ +pgvector│     │ plugin o   │
   │ o manual │     │ coseno   │     │  )       │     │ search CLI │
   └─────────┘     └──────────┘     └──────────┘     └────────────┘
                                          │
                                          ▼
                                   ┌──────────────┐
                                   │ Curación     │
                                   │ (dedup,      │
                                   │  lifecycle,  │
                                   │  quality)    │
                                   └──────────────┘
```

### Paso a paso:

1. **Captura**: un script o hook extrae información de sesiones de agentes, respuestas outbound o archivos markdown.
2. **Embedding**: el texto se convierte en un vector de 1536 dimensiones vía `text-embedding-3-small` de OpenAI.
3. **Storage**: el vector + metadata (tipo, tier, importancia, agente, tags) se guarda en `brainx_memories` en PostgreSQL.
4. **Curación**: scripts automáticos deduplicar, puntúan calidad, promueven/degradan, y detectan contradicciones.
5. **Runtime recall/context broker**: cuando está habilitado, el plugin clasifica el turno, elige una sola surface (`recovery_preflight`, `jit_recall`, `working_memory`, `wiki_digest` o ninguna), aplica el policy controller adaptativo y solo inyecta evidencia compacta si la surface tiene señal suficiente.

Para rotaciones OpenClaw no-ACP, `brainx_context_state` permite detectar que cambió el `sessionId` para el mismo `agent + session_key` y activar `recovery_preflight` si el prompt es significativo. Para Claude ACP, el owner primario de continuidad sigue siendo ACP/runtime-heal; BrainX no compite con `resumeSessionId`.

Scoring de delivery-mirror: en turns Codex/background con `NO_REPLY`, BrainX no trata ese token como respuesta final. Mantiene el cache de inyección y usa un observer `message_sent` solo para scoring de la respuesta visible por `sessionKey`, sin activar captura outbound general ni reinyectar transcript crudo.

---

## 2. Tipos de Memoria

| Tipo | Para qué |
|---|---|
| `note` | Información general |
| `decision` | Decisiones tomadas (ej: "usar CDN Cloudflare") |
| `action` | Acciones ejecutadas |
| `learning` | Lecciones aprendidas (ej: "no usar innerHTML sin sanitizar") |
| `fact` | Datos duros extraídos (URLs, puertos, repos, configs) |
| `gotcha` | Trampas/bugs conocidos que otros agentes deben evitar |

### Tiers (prioridad):

| Tier | Significado | Comportamiento |
|---|---|---|
| `hot` | Alta prioridad, acceso frecuente | Se prioriza en retrieval y recall cuando una superficie de inyección está habilitada |
| `warm` | Relevante pero no urgente | Sigue siendo elegible para search/inject, con menor prioridad que `hot` |
| `cold` | Baja prioridad / poco acceso | Normalmente queda para búsqueda explícita o mantenimiento |
| `archive` | Histórico | Solo se usa como historial o búsqueda deliberada |

La importancia va de 1 a 10. Los umbrales reales dependen de la superficie activa del host; no asumir bootstrap automático si `docs/RUNTIME_STATUS.md` no lo marca como activo.

---

## 3. Pipeline Automático (Crons)

Estos scripts mantienen BrainX vivo. En produccion actual OpenClaw agenda los jobs, pero los wrappers ejecutables viven dentro del skill en `~/.openclaw/skills/brainx/cron/`:

- 13 pasos diarios todos los dias
- 2 pasos extra miercoles y domingo
- 7 pasos extra solo los domingos
- 4 crons directos BrainX
- 7 crons si se incluyen wrappers mixtos de `clawd` que ejecutan BrainX

La fuente de verdad operativa para el host `/home/clawd` es `docs/RUNTIME_STATUS.md`. Las tablas de abajo describen el scheduling actual del host, no todas las superficies que existen en disco.

### Jobs activos del host

| Cadencia | Surface | Qué hace |
|---|---|---|
| Diario | `memory-daily-bootstrap` | Crea `memory/YYYY-MM-DD.md` en los workspaces |
| Diario | `memory-distiller` | Lee transcripts recientes y extrae memorias con LLM |
| Diario | `session-harvester` | Lee JSONL de sesiones y captura señal alta con heurísticas |
| Diario | `handoff-promoter` | Promueve handoffs de snapshots a memorias hot y artifact ledger |
| Diario | `memory-bridge` | Sincroniza `memory/*.md` hacia BrainX |
| Diario | `cross-agent-learning` | Comparte learnings/gotchas verificados entre agentes |
| Diario | `context-pack-builder` | Genera/upsertea context packs compactos de mantenimiento |
| Diario | `error-harvester` | Escanea fallos recientes para gotchas |
| Diario | `reclassify-memories` | Mantiene categorías/tipos al día |
| Diario | `degrade-over-injected` | Degrada memorias sobreinyectadas y no usadas |
| Diario | `wiki-compile` | Recompila el vault/digest de BrainX |
| Diario | `runtime-regression-suite` | Valida guardrails runtime |
| Diario | `trajectory-recorder` | Extrae trayectorias problema→solución |
| Miércoles + Domingo | `lifecycle-run` | Ejecuta decay, stale cleanup y stats |
| Miércoles + Domingo | `contradiction-detector` | Busca conflictos semánticos |
| Domingo | `weekly-semantic-consolidation` | Consolida memorias maduras y cercanas |
| Domingo | `auto-promoter` | Genera sugerencias review-gated |
| Domingo | `promotion-applier` | Destila sugerencias hacia la referencia canónica |
| Domingo | `memory-enforcer` | Verifica estructura de memoria en workspaces |
| Domingo | `memory-audit` | Audita salud de memoria y reporta anomalías |
| Domingo | `dedup-supersede` | Marca duplicados exactos como superseded |
| Domingo | `cleanup-low-signal` | Degrada memorias cortas de baja señal |
| Cada 4 horas | `BrainX Session Snapshot` | Captura estado de sesiones y corre handoff-promoter |
| Cada 7 horas | `BrainX Knowledge Sync` | Sincroniza `knowledge/` hacia el wiki/DB cuando hay cambios |
| Diario 07:30 | `BrainX Injection Health` | Reporte compacto de inyección por surface |
| Diario 23:50 | `BrainX Nightly Memory Loop` | Orquesta `Memory Daily Consolidate` + `Memory Daily Closeout` |

### Superficies existentes pero no programadas por defecto

| Surface | Estado actual |
|---|---|
| `learning-detail-extractor.js` | Existe, pero no está en el scheduler consolidado actual |
| `learning-detail-extractor.js` | Existe, pero no está en el scheduler consolidado actual |
| `quality-scorer.js` | Existe, pero no está en el scheduler consolidado actual |
| `pattern-detector.js` | Existe, pero no está en el scheduler consolidado actual |
| `hook-live/handler.js` | Legacy, deshabilitado por defecto en este host |
| `hook/handler.js` | Legacy, deshabilitado por defecto en este host |

### Scripts disponibles (ejecución manual)

| Script | Uso |
|---|---|
| `quality-scorer.js` | Evalúa y puntúa calidad de memorias |
| `dedup-supersede.js` | Elimina duplicados exactos por fingerprint |
| `contradiction-detector.js` | Encuentra memorias que se contradicen |
| `cleanup-low-signal.js` | Degrada memorias muy cortas o de baja señal |
| `context-pack-builder.js` | Genera paquetes de contexto semanales; no es retrieval runtime activo |
| `fact-extractor.js` | Extrae datos duros (URLs, puertos, etc.) con regex |

---

## 4. Runtime en Agentes

La arquitectura vigente separa ownership asi:

- `BrainX skill` = memoria larga, cron, doctor, knowledge sync
- `brainx plugin` = working memory de sesion + recall JIT + advisories cuando se habilitan
- hooks internos BrainX = compatibilidad legacy, no ruta default

### Flujo recomendado

```
Prompt actual del usuario
        │
        ▼
brainx plugin
        │
        ├── 1. Sanitiza prompt y estado vivo de la sesion
        ├── 2. Si working memory está habilitada, resume objetivo/tarea/tooling reciente
        ├── 3. Si recall está habilitado, consulta BrainX con filtros de trust y relevancia
        ├── 4. Aplica policyController con feedback real por agente/surface
        └── 5. Antepone solo el bloque compacto y relevante al prompt final
```

El `policyController` es la capa para evitar calibracion manual repetida: mira utilidad reciente en `brainx_runtime_injections`, registra cada allow/suppress/explore en `brainx_policy_decisions`, protege recovery/recall explicito/project ground deterministico y deja una pequena exploracion para que una surface pueda recuperarse.

### Artefactos persistentes

- **`~/.openclaw/skills/brainx/brainx.md`**: guía canónica estable
- **`memory/YYYY-MM-DD.md`**: notas operativas y cierres diarios
- **`knowledge/`**: documentación canónica sincronizable

### Artefactos legacy

- `BRAINX_CONTEXT.md`
- `brainx-topics/*.md`
- bloques `<!-- BRAINX:START -->` en `MEMORY.md`

Pueden seguir existiendo para troubleshooting o compatibilidad, pero no deben ser la base del bootstrap cotidiano.

### Captura near-real-time (`message:sent`)

La captura outbound puede existir en dos superficies, pero solo una debe estar activa a la vez:

```
Evento: message:sent
        │
        ▼
Plugin bridge o hook legacy
        │
        ├── 1. Filtra chatter, respuestas cortas, status updates y code dumps
        ├── 2. Detecta recomendaciones/gotchas/decisiones con señal fuerte
        ├── 3. Deduplica por sessionKey + messageId + summary hash
        ├── 4. Escribe una bala compacta en memory/YYYY-MM-DD.md del workspace
        └── 5. Guarda el mismo resumen en BrainX con provenance conservadora
```

Esto cierra el gap entre:

- "el agente acaba de recomendar algo"
- y "esa recomendación ya es memoria durable"

## 4.5. Runtime V6: Working Memory + Recall

Antes de cada prompt, el plugin `brainx` puede inyectar dos capas distintas:

1. **Working memory de sesion**
   - objetivo actual
   - tarea actual
   - ultimo error
   - ultimo tool usado
   - archivos/comandos recientes
   - siguiente paso

2. **Recall historico**
   - facts, decisions y gotchas verificados desde BrainX

Orden recomendado:

```text
working memory viva
        ↓
recall historico BrainX
        ↓
LLM responde/actua
```

La working memory vive por sesion y se actualiza con eventos del runtime cuando esta habilitada. Puede usar `MiniMax-M2.7` como resumidor barato para mantener el estado compacto, pero no reemplaza la base estructurada/deterministica.

### Config actual (`openclaw.json`):

```json
{
  "plugins": {
    "entries": {
      "brainx": {
        "enabled": true,
        "config": {
          "wikiDigest": true,
          "wikiDigestPromptSignalsOnly": true,
          "jitRecall": false,
          "workingMemory": false,
          "toolAdvisories": false,
          "captureToolFailures": false,
          "bootstrapMode": "off",
          "captureOutboundMode": "off"
        }
      }
    }
  }
}
```

---

## 5. Búsqueda y Ranking

Cuando un agente busca memorias (`brainx search` o `brainx inject`):

1. El query se convierte en embedding
2. PostgreSQL calcula similitud coseno contra todas las memorias
3. El score final combina:
   - **Similitud semántica** (base)
   - **Importancia** (+0 a +0.25 según importance/10)
   - **Tier boost**: hot +0.15, warm +0.05, cold -0.05, archive -0.10
4. Se filtran memorias supersedidas (`superseded_by IS NULL`)
5. Se actualiza `access_count` y `last_accessed` de cada resultado

---

## 6. Cross-Agent Learning

Corre dentro del wrapper diario actual. Hace que el conocimiento fluya entre agentes:

1. Busca memorias tipo `gotcha` y `learning` con alta importancia
2. Las propaga a agentes que no las tienen
3. Respeta el contexto original (no inyecta info irrelevante)

Resultado: si un agente descubre que "innerHTML sin sanitizar causa XSS", todos los demás agentes lo saben en la siguiente sesión.

---

## 7. Estado Actual

Los conteos cambian continuamente. Para estado vivo del host:

- usa `docs/RUNTIME_STATUS.md` como verdad operativa
- corre `brainx health`
- corre `./brainx doctor --json` o `./brainx doctor --full --json`

Lectura correcta del estado actual:

- el core de memoria, search, wiki, cron y promotion review-gated si esta operativo
- el runtime del plugin esta activo en modo conservador, hoy enfocado en `wikiDigest`
- varias superficies avanzadas existen en disco pero no deben asumirse activas si no aparecen marcadas como tales en `docs/RUNTIME_STATUS.md`

---

## 8. Uso Rápido (CLI)

```bash
# Verificar salud
brainx health

# Guardar una memoria
brainx add --type decision --content "Usar Cloudflare CDN" --tier hot --importance 9

# Buscar
brainx search --query "CDN" --limit 5

# Obtener contexto para prompt
brainx inject --query "configuración de deploy" --limit 3

# Guardar un fact
brainx fact --content "Puerto nginx: 443" --context mdx-infra
```

---

## 9. Dónde Vive Todo

| Qué | Ruta |
|---|---|
| Skill completa | `~/.openclaw/skills/brainx/` |
| CLI wrapper | `~/.openclaw/skills/brainx/brainx` |
| Cron wrappers | `~/.openclaw/skills/brainx/cron/` |
| Plugin runtime | `~/.openclaw/extensions/brainx/` |
| Config runtime | `openclaw.json → plugins.entries.brainx.config` |
| Hook de inyección (legacy) | `~/.openclaw/hooks/brainx-auto-inject/handler.js` |
| Hook live capture (legacy) | `~/.openclaw/hooks/brainx-live-capture/handler.js` |
| Base de datos | PostgreSQL local (`127.0.0.1:5432/brainx`) |
| Logs de cron | `~/.openclaw/skills/brainx/cron/cron-output.log` |
| Log de live capture | `~/.openclaw/logs/brainx-live-capture.log` |
| Schema SQL | `~/.openclaw/skills/brainx/sql/` |
| Variables de entorno | `~/.openclaw/skills/brainx/.env` |
| Docs detallados | `~/.openclaw/skills/brainx/docs/` |
| README completo | `~/.openclaw/skills/brainx/README.md` (107KB) |

---

_Última actualización: 2026-04-13_
