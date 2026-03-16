---
name: brainx
description: |
  Motor de memoria vectorial con PostgreSQL + pgvector + OpenAI embeddings.
  Permite almacenar, buscar e inyectar memorias contextuales en prompts de LLMs.
  Incluye hook de auto-inyección para OpenClaw y sistema completo de backup/recuperación.
metadata:
  openclaw:
    emoji: "🧠"
    requires:
      bins: ["psql"]
      env: ["DATABASE_URL", "OPENAI_API_KEY"]
    primaryEnv: "DATABASE_URL"
    hooks:
      - name: brainx-auto-inject
        event: agent:bootstrap
        description: Auto-inyecta memorias relevantes al iniciar sesión
user-invocable: true
---

# BrainX V5 - Memoria Vectorial para OpenClaw

Sistema de memoria persistida que usa embeddings vectoriales para recuperación contextual en agentes AI.

## Cuándo Usar

✅ **USAR cuando:**
- Un agente necesita "recordar" información de sesiones previas
- Querés dar contexto adicional a un LLM sobre acciones pasadas
- Necesitás búsqueda semántica por contenido
- Querés guardar decisiones importantes con metadatos

❌ **NO USAR cuando:**
- Información efímera que no necesita persistencia
- Datos estructurados tabulares (usá una DB normal)
- Cache simple (usá Redis o memoria en memoria)

## Auto-Inyección (Hook)

BrainX V5 incluye un **hook de OpenClaw** que automáticamente inyecta memorias relevantes cuando un agente inicia.

### Production Validation Status

Real validation completed on **2026-03-16**:
- global hook enabled in `~/.openclaw/openclaw.json`
- managed hook synced with `~/.openclaw/skills/brainx-v5/hook/`
- active physical database: `brainx_v5`
- real bootstrap smoke test passed for 10 agents:
  - `kron`, `reasoning`, `raider`, `monitor`, `alert`, `clawma`, `sonnet`, `echo`, `max`, `venus`
- expected evidence was confirmed:
  - `<!-- BRAINX:START -->` block written into `MEMORY.md`
  - `Updated:` timestamp present
  - fresh row recorded in `brainx_pilot_log`

If this validation becomes stale, rerun a bootstrap smoke test before assuming runtime is still healthy.

### Cómo funciona:

1. Evento `agent:bootstrap` → Hook se ejecuta automáticamente
2. Consulta PostgreSQL → Obtiene memorias hot/warm recientes
3. Genera archivo → Crea `BRAINX_CONTEXT.md` en el workspace
4. Agente lee → El archivo se carga como contexto inicial

### Configuración:

En `~/.openclaw/openclaw.json`:
```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "brainx-auto-inject": {
          "enabled": true,
          "limit": 5,
          "tier": "hot+warm",
          "minImportance": 5
        }
      }
    }
  }
}
```

### Para cada agente:

Agregar a `AGENTS.md` en cada workspace:
```markdown
## Every Session

1. Read `SOUL.md`
2. Read `USER.md`
3. Read `brainx.md`
4. Read `BRAINX_CONTEXT.md` ← Contexto auto-inyectado
```

## Herramientas Disponibles

### brainx_add_memory

Guarda una memoria en el brain vectorial.

**Parámetros:**
- `content` (requerido) - Texto de la memoria
- `type` (opcional) - Tipo: note, decision, action, learning (default: note)
- `context` (opcional) - Namespace/scope
- `tier` (opcional) - Prioridad: hot, warm, cold, archive (default: warm)
- `importance` (opcional) - Importancia 1-10 (default: 5)
- `tags` (opcional) - Tags separados por coma
- `agent` (opcional) - Nombre del agente que crea la memoria

**Ejemplo:**
```
brainx add --type decision --content "Usar embeddings 3-small para reducir costos" --tier hot --importance 9 --tags config,openai
```

### brainx_search

Busca memorias por similitud semántica.

**Parámetros:**
- `query` (requerido) - Texto a buscar
- `limit` (opcional) - Número de resultados (default: 10)
- `minSimilarity` (opcional) - Umbral 0-1 (default: 0.3)
- `minImportance` (opcional) - Filtro por importancia 0-10
- `tier` (opcional) - Filtro por tier
- `context` (opcional) - Filtro exacto por contexto

**Ejemplo:**
```
brainx search --query "configuracion de API" --limit 5 --minSimilarity 0.5
```

**Retorna:** JSON con resultados.

### brainx_inject

Obtiene memorias formateadas para inyectar directamente en prompts LLM.

**Parámetros:**
- `query` (requerido) - Texto a buscar
- `limit` (opcional) - Número de resultados (default: 10)
- `minImportance` (opcional) - Filtro por importancia
- `tier` (opcional) - Filtro por tier (default: hot+warm)
- `context` (opcional) - Filtro por contexto
- `maxCharsPerItem` (opcional) - Truncar contenido (default: 2000)

**Ejemplo:**
```
brainx inject --query "que decisiones se tomaron sobre openai" --limit 3
```

**Retorna:** Texto formateado listo para inyectar:
```
[sim:0.82 imp:9 tier:hot type:decision agent:coder ctx:openclaw]
Usar embeddings 3-small para reducir costos...

---

[sim:0.71 imp:8 tier:hot type:decision agent:support ctx:brainx]
Crear SKILL.md para integración con OpenClaw...
```

### brainx_health

Verifica que BrainX está operativo.

**Parámetros:** ninguno

**Ejemplo:**
```
brainx health
```

**Retorna:** Estado de conexión a PostgreSQL + pgvector.

## Backup y Recuperación

### Crear Backup

```bash
./scripts/backup-brainx.sh ~/backups
```

Crea archivo `brainx-v5_backup_YYYYMMDD_HHMMSS.tar.gz` con:
- Base de datos PostgreSQL completa (SQL dump)
- Configuración de OpenClaw (hooks, .env)
- Archivos de skill
- Documentación de workspaces

### Restaurar Backup

```bash
./scripts/restore-brainx.sh backup.tar.gz --force
```

Restaura completamente BrainX V5 incluyendo:
- Todas las memorias (126+ registros con embeddings)
- Configuración de hooks
- Variables de entorno

### Documentación Completa

Ver [RESILIENCE.md](RESILIENCE.md) para:
- Escenarios de desastre completos
- Migración a nuevo VPS
- Troubleshooting
- Configuración de backups automáticos

## Configuración

### Variables de Entorno

```bash
# Obligatorias
DATABASE_URL=postgresql://user:pass@host:5432/brainx_v5
OPENAI_API_KEY=sk-...

# Opcionales
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_EMBEDDING_DIMENSIONS=1536
BRAINX_INJECT_DEFAULT_TIER=hot+warm
BRAINX_INJECT_MAX_CHARS_PER_ITEM=2000
BRAINX_INJECT_MAX_LINES_PER_ITEM=80
```

### Setup de Base de Datos

```bash
# El schema está en ~/.openclaw/skills/brainx-v5/sql/
# Requiere PostgreSQL con extensión pgvector

psql $DATABASE_URL -f ~/.openclaw/skills/brainx-v5/sql/v3-schema.sql
```

## Integración Directa

También podés usar el wrapper unificado que lee la API key de OpenClaw:

```bash
cd ~/.openclaw/skills/brainx-v5
./brainx add --type note --content "test"
./brainx search --query "test"
./brainx inject --query "test"
./brainx health
```

Compatibilidad: también funcionan `./brainx-v5` y `./brainx-v5-cli` como alias del wrapper principal.

## Advisory System (Pre-Action Check)

BrainX includes an advisory system that queries relevant memories, trajectories, and recurring patterns before executing high-risk tools. This helps agents avoid repeating past mistakes.

### High-Risk Tools

The following tools automatically trigger advisory checks: `exec`, `deploy`, `railway`, `delete`, `rm`, `drop`, `git push`, `git force-push`, `migration`, `cron`, `message send`, `email send`.

### CLI Usage

```bash
# Check for advisories before a tool execution
./brainx-v5 advisory --tool exec --args '{"command":"rm -rf /tmp/old"}' --agent coder --json

# Quick check via helper script
./scripts/advisory-check.sh exec '{"command":"rm -rf /tmp/old"}' coder
```

### Agent Integration (Manual)

Since only `agent:bootstrap` is supported as a hook event, agents should manually call `brainx advisory` before high-risk tools:

```bash
# In agent SKILL.md or AGENTS.md, add:
# Before exec/deploy/delete/migration, run:
cd ~/.openclaw/skills/brainx-v5 && ./scripts/advisory-check.sh <tool> '<args_json>' <agent>
```

The advisory returns relevant memories, similar past problem→solution paths, and recurring patterns with a confidence score. It's informational — never blocking.

### Agent-Aware Hook Injection

The `agent:bootstrap` hook now uses **agent profiles** (`hook/agent-profiles.json`) to customize memory injection per agent:

- **coder**: Boosts gotcha/error/learning memories; filters by infrastructure/code/deploy/github contexts; excludes notes
- **writer**: Boosts decision/learning; filters by content/seo/marketing; excludes errors
- **monitor**: Boosts gotcha/error; filters by infrastructure/health/monitoring
- **echo**: No filtering (default behavior)

Agents not listed in the profiles file get the default unfiltered injection. Edit `hook/agent-profiles.json` to add new agent profiles.

## Notas

- Las memorias se almacenan con embeddings vectoriales (1536 dimensiones)
- La búsqueda usa similitud coseno
- `inject` es la herramienta más útil para dar contexto a LLMs
- Tier hot = acceso rápido, cold/archive = archive a largo plazo
- Las memorias son persistentes en PostgreSQL (independientes de OpenClaw)
- El hook de auto-inyección funciona en cada `agent:bootstrap`

## Estado de Features (Tablas)

### ✅ Todas Operativas
| Tabla | Función | Status |
|---|---|---|
| `brainx_memories` | Core: almacena memorias con embeddings | ✅ Activa (600+) |
| `brainx_query_log` | Tracking de queries search/inject | ✅ Activa |
| `brainx_pilot_log` | Tracking de auto-inject por agente | ✅ Activa |
| `brainx_context_packs` | Paquetes de contexto pre-generados | ✅ Activa |
| `brainx_patterns` | Detecta errores/issues recurrentes | ✅ Activa (script: `pattern-detector.js`) |
| `brainx_session_snapshots` | Captura estado al cierre de sesión | ✅ Activa (script: `session-snapshot.js`) |
| `brainx_learning_details` | Metadata extendida de memorias learning/gotcha | ✅ Activa (script: `learning-detail-extractor.js`) |
| `brainx_trajectories` | Registro de problem→solution paths | ✅ Activa (script: `trajectory-recorder.js`) |

> 8/8 tablas operativas. Scripts de población implementados el 2026-03-06.

## Inventario Completo de Funcionalidades (35)

### CLI Core (`brainx <cmd>`)
| # | Comando | Función |
|---|---|---|
| 1 | `add` | Guardar memoria (7 types, 20+ categorías, metadata V5) |
| 2 | `search` | Búsqueda semántica por similitud coseno |
| 3 | `inject` | Memorias formateadas para inyectar en prompts LLM |
| 4 | `fact` / `facts` | Shortcut para guardar/listar facts de infraestructura |
| 5 | `resolve` | Marcar pattern como resuelto/promovido/wont_fix |
| 6 | `promote-candidates` | Detectar memorias candidatas a promoción |
| 7 | `lifecycle-run` | Degradar/promover memorias por edad/uso |
| 8 | `metrics` | Dashboard de métricas y top patterns |
| 9 | `doctor` | Diagnóstico completo (schema, integridad, stats) |
| 10 | `fix` | Auto-reparar problemas detectados por doctor |
| 11 | `feedback` | Marcar memoria como useful/useless/incorrect |
| 12 | `health` | Estado de conexión PostgreSQL + pgvector |

### Scripts de Procesamiento (`scripts/`)
| # | Script | Función |
|---|---|---|
| 13 | `memory-bridge.js` | Sincroniza memoria entre sesiones/agentes |
| 14 | `memory-distiller.js` | Destila sesiones en memorias nuevas |
| 15 | `session-harvester.js` | Cosecha info de sesiones pasadas |
| 16 | `session-snapshot.js` | Captura estado al cierre de sesión |
| 17 | `pattern-detector.js` | Detecta errores/issues recurrentes |
| 18 | `learning-detail-extractor.js` | Extrae metadata de learnings/gotchas |
| 19 | `trajectory-recorder.js` | Registra paths problem→solution |
| 20 | `fact-extractor.js` | Extrae facts de conversaciones |
| 21 | `contradiction-detector.js` | Detecta memorias que se contradicen |
| 22 | `cross-agent-learning.js` | Comparte aprendizajes entre agentes |
| 23 | `quality-scorer.js` | Puntúa calidad de memorias |
| 24 | `context-pack-builder.js` | Genera paquetes de contexto pre-armados |
| 25 | `reclassify-memories.js` | Reclasifica memorias con tipos/categorías correctos |
| 26 | `cleanup-low-signal.js` | Limpia memorias de bajo valor |
| 27 | `dedup-supersede.js` | Detecta y marca duplicados |
| 28 | `eval-memory-quality.js` | Evalúa calidad del dataset |
| 29 | `generate-eval-dataset-from-memories.js` | Genera dataset de evaluación |
| 30 | `memory-feedback.js` | Sistema de feedback por memoria |
| 31 | `import-workspace-memory-md.js` | Importa desde MEMORY.md de workspaces |
| 32 | `migrate-v2-to-v3.js` | Migración de schema V2→V3 |

### Hooks e Infraestructura
| # | Componente | Función |
|---|---|---|
| 33 | `brainx-auto-inject` | Hook de auto-inyección al bootstrap de cada agente |
| 34 | `backup-brainx.sh` | Backup completo (DB + config + skills) |
| 35 | `restore-brainx.sh` | Restauración total desde backup |

### Metadata V5
- `sourceKind` — Origen: user_explicit, agent_inference, tool_verified, llm_distilled, etc.
- `sourcePath` — Archivo/URL de origen
- `confidence` — Score 0-1
- `expiresAt` — Expiración automática
- `sensitivity` — normal/sensitive/restricted
- PII scrubbing automático (`BRAINX_PII_SCRUB_ENABLED`)
- Dedup por similitud (`BRAINX_DEDUPE_SIM_THRESHOLD`)
