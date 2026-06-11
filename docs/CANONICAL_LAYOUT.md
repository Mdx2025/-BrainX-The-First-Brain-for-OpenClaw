# BrainX V5 Canonical Layout

Este documento define la arquitectura canónica de BrainX V5 en este host: qué vive en la skill, qué vive por workspace, qué se genera en runtime, y qué rutas son fuente de verdad.

---

## 1. Principio base

BrainX V5 separa tres capas:

1. **Source estable versionado**
   Vive dentro de `~/.openclaw/skills/brainx/`.
2. **Runtime por workspace**
   Vive dentro de cada `~/.openclaw/workspace*`.
3. **Store persistente**
   Vive en PostgreSQL (`brainx`) y logs asociados.

No mezclar estas capas.

---

## 2. Fuente de verdad por artefacto

| Artefacto | Ruta canónica | Tipo | Quién lo escribe | Quién lo lee |
|---|---|---|---|---|
| Guía BrainX | `~/.openclaw/skills/brainx/brainx.md` | estable | humano/repo | agentes |
| Skill docs | `~/.openclaw/skills/brainx/docs/` | estable | humano/repo | humanos/agentes |
| Knowledge manual | `~/.openclaw/skills/brainx/knowledge/` | estable | humano/repo | `knowledge-sync`, `knowledge-locate`, agentes |
| Bootstrap context | `~/.openclaw/workspace*/BRAINX_CONTEXT.md` | runtime | `hook/handler.js` | agente del workspace |
| Topic deep reads | `~/.openclaw/workspace*/brainx-topics/*.md` | runtime | `hook/handler.js` | agente del workspace |
| Prompt summary | `~/.openclaw/workspace*/MEMORY.md` | runtime | `hook/handler.js` | agente del workspace |
| Daily notes | `~/.openclaw/workspace*/memory/YYYY-MM-DD.md` | runtime/humano | agentes + `hook-live/handler.js` | agentes/humanos |
| Vector memory | PostgreSQL `brainx` | persistente | CLI/scripts/hooks | CLI/scripts/hooks |

---

## 3. Qué vive dentro de la skill

Dentro de `~/.openclaw/skills/brainx/` deben vivir solamente artefactos estables o reinstalables:

- `brainx.md`
- `SKILL.md`
- `README.md`
- `docs/`
- `knowledge/`
- `hook/`
- `hook-live/`
- `scripts/`
- `lib/`
- `sql/`
- `tests/`

Regla:
- La skill **sí** contiene la guía canónica.
- La skill **no** debe contener `BRAINX_CONTEXT.md` ni `brainx-topics/` como source activa.

Si aparecen `BRAINX_CONTEXT.md` o `brainx-topics/` dentro de la skill, tratarlos como drift o residuos runtime, no como diseño correcto.

---

## 4. Qué vive por workspace

Cada workspace de agente (`~/.openclaw/workspace*`) es dueño de su contexto operativo local.

Archivos runtime esperados:

- `BRAINX_CONTEXT.md`
- `brainx-topics/decisions.md`
- `brainx-topics/facts.md`
- `brainx-topics/gotchas.md`
- `brainx-topics/own.md`
- `brainx-topics/team.md`
- `brainx-topics/learnings.md` cuando esté habilitado
- bloque `BRAINX:START/END` dentro de `MEMORY.md`
- `memory/YYYY-MM-DD.md`

Reglas:

- Estos archivos son **output del hook**, no docs canónicas de repo.
- Pueden faltar en workspaces nunca bootstrappeados o inactivos.
- No deben moverse a la skill.
- No deben tratarse como fuente estable compartida entre agentes.

---

## 5. Bootstrap canónico

Hook: `~/.openclaw/skills/brainx/hook/handler.js`

Trigger:
- `agent:bootstrap`

Input principal:
- `event.context.workspaceDir`
- PostgreSQL `brainx`
- perfiles y reglas de ranking

Output canónico en el workspace del agente:

1. actualiza `MEMORY.md`
2. genera o refresca `brainx-topics/*.md`
3. genera o refresca `BRAINX_CONTEXT.md`

Contrato:
- `brainx.md` **no** se genera en bootstrap
- `brainx.md` **no** se replica por workspace como fuente de verdad
- el agente debe leer la guía desde la skill y el contexto desde su workspace

---

## 6. Live capture canónico

Hook: `~/.openclaw/skills/brainx/hook-live/handler.js`

Trigger:
- `message:sent`

Escrituras esperadas:
- DB BrainX
- `memory/YYYY-MM-DD.md` del workspace resuelto

No escribe:
- `brainx.md`
- `BRAINX_CONTEXT.md`
- `brainx-topics/`

---

## 7. Knowledge canónico

Rama manual y durable:
- `~/.openclaw/skills/brainx/knowledge/<domain>/*.md`

Responsabilidad:
- documentos manuales, canónicos y revisables
- pricing, propuestas, playbooks, branding, procesos, SOPs, etc.

Herramientas:
- `scripts/import-knowledge-md.js`
- `scripts/knowledge-sync.js`
- `scripts/knowledge-locate.js`

Regla:
- `knowledge/` es canónico
- `BRAINX_CONTEXT.md` y `brainx-topics/` no reemplazan `knowledge/`

---

## 8. Guía de lectura para agentes

Setup correcto para agentes:

1. leer `~/.openclaw/skills/brainx/brainx.md`
2. leer `BRAINX_CONTEXT.md` del workspace actual si existe
3. leer `brainx-topics/*.md` bajo demanda
4. usar `brainx knowledge-locate --query "<tarea>"` cuando la tarea dependa de docs canónicas

No depender de:

- `~/.openclaw/workspace*/brainx.md` como fuente estable
- copias legacy de `brainx.md` en workspaces
- templates externas como si fueran la verdad principal

Compatibilidad:
- `~/.openclaw/skills/agent-core/templates/brainx.md` puede existir como puntero
- esa template ya no debe mantener una copia completa paralela

---

## 9. Backup y restore

Scripts:
- `scripts/backup-brainx.sh`
- `scripts/restore-brainx.sh`

Lo que se respalda/restaura:

- DB
- skill dir
- config/hook
- `MEMORY.md` por workspace
- `brainx-topics/` por workspace
- `BRAINX_CONTEXT.md` por workspace

Lo que no debe restaurarse como doc canónica por workspace:

- `brainx.md`

Regla:
- la restauración de runtime debe reconstruir o devolver contexto operativo
- la guía estable se toma de la skill restaurada, no de copias por workspace

---

## 10. Anti-drift rules

Se considera drift si ocurre cualquiera de estos:

- aparece `BRAINX_CONTEXT.md` dentro de `~/.openclaw/skills/brainx/`
- aparece `brainx-topics/` dentro de `~/.openclaw/skills/brainx/`
- se vuelve a tratar `~/.openclaw/workspace*/brainx.md` como fuente canónica
- `AGENTS.md` o `TOOLS.md` apuntan al `brainx.md` de un workspace en vez del de la skill
- scripts de restore vuelven a copiar `brainx.md` a workspaces como si fuera verdad primaria

Si pasa, corregir de inmediato para volver a este layout.
