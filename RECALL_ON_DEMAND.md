# BrainX: Recall bajo demanda

A partir de 2026-04-18 el plugin BrainX funciona en modo **silent-by-default**:
no inyecta nada al prompt a menos que detecte una señal de dominio clara o una
**demanda explícita** del usuario / agent.

## Cómo disparar recall explícito

El plugin detecta la demanda con un regex sobre el prompt del turno. Cualquiera
de estas frases (case-insensitive) fuerza una búsqueda en BrainX con gates
relajados (minSimilarity 0.50, minImportance 5, signal gate desactivado):

- `recall …`
- `brainx …`
- `recordá …` / `recuerda …`
- `qué sabemos de …` / `qué recordás de …`
- `memoria de …`
- `context pack de …`
- `histórico de …` / `antecedente …`

Ejemplos:

- > "recordá qué hicimos con el deploy del gateway la semana pasada"
- > "brainx: últimos bugs del plugin de codex"
- > "qué sabemos del ACP stall watchdog?"

## Cómo se dispara recall implícito (sin que lo pidas)

Si el prompt **no** tiene demanda explícita, el plugin sólo inyecta cuando el
texto trae al menos:

- Un término de dominio conocido (agents, tools, archivos, errores, proyectos).
- Un identificador reconocible (`CamelCase`, rutas `/foo/bar`, `errors`,
  fechas `YYYY-MM-DD`, `PR #123`, `v1.2.3`).

Si nada de eso aparece, el prompt se envía limpio — BrainX no habla.

## Guardrails globales

- **Un solo surface por turno**: si `jit_recall` inyectó, `working_memory` y
  `wiki_digest` no vuelven a pronunciarse en ese mismo turno.
- **Presupuesto duro**: 800 chars totales inyectados por turno como máximo.
- **Anti-dup**: si la memoria es muy similar al prompt (>40% shingle overlap),
  se descarta.
- **Cross-agent OFF por default** (requires explicit tag + verified).

## Consulta offline (sin inyectar)

Para buscar en BrainX fuera del path del prompt (debug, inspección), usar la
CLI directamente:

```bash
cd /home/clawd/.openclaw/skills/brainx
node brainx/cli.js query "tu query" --limit 5 --min-similarity 0.5
```

## Observabilidad

- Inyecciones se registran en `brainx_runtime_injections` (columnas:
  `agent`, `surface`, `selected_count`, `referenced_count`, `latency_ms`).
- Reporte diario a Discord: cron `BrainX Injection Health (24h)` a las 07:30
  America/Caracas → channel `1490714485755740290`.
- El reporte alerta si alguna combinación `agent × surface` tiene hit-rate
  < 0.25 con n ≥ 20 inyecciones. Esa es la señal para endurecer gates.
