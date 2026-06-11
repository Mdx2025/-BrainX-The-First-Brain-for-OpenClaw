# BrainX V5 Scripts Manifest

Este archivo documenta los scripts de mantenimiento en `/home/clawd/.openclaw/skills/brainx/scripts/`.
Los wrappers operativos que OpenClaw agenda viven en `/home/clawd/.openclaw/skills/brainx/cron/`.

La verdad operativa de este host vive en:

- `docs/RUNTIME_STATUS.md` para estado humano
- `config/surface-policy.json` para estado maquina-legible
- `cron/brainx-daily-core-wrapper.sh` para el scheduler consolidado

Última reconciliación contra `config/surface-policy.json` y `docs/CRON.md`: 2026-05-01.

## Leyenda de Recursos
- **RAM**: Bajo (<100MB), Medio (100-500MB), Alto (>500MB)
- **CPU**: Bajo (segundos), Medio (minutos), Alto (largo proceso)

Nota procedural: skill-promoter.js es una superficie review-gated con carriles
estrechos de auto-create y auto-patch. Producción usa el patrón Hermes:
`brainx-background-review-cron.sh` corre el review cercano al evento y
`brainx-skill-curator-cron.sh` corre el lifecycle semanal; el viejo daily-light
queda deshabilitado.
Su responsabilidad es detectar patrones reutilizables y emitir candidatos de
SKILL.md. Para auditorías amplias, `--per-agent` reparte el scan entre agentes
activos antes de agrupar candidatos. `--hybrid` añade lectura cruda de sesiones
JSONL recientes, extracción procedural y confirmación contra BrainX memories/patterns.
En modo `--auto-create`, solo escribe candidatos `create_new_skill` con
evidencia fuerte, sidecar `brainx-created`, registry regen, validación
`openclaw skills check`, auditoría y rollback. En modo `--auto-patch`, solo
escribe skills registradas con riesgo bajo, excepto `agent-core`, `brainx`,
`gws` y `openclaw-runtime`, que requieren autorización. skill-curator.js
gestiona únicamente skills creadas por BrainX.

| Script | Frecuencia | RAM | CPU | Propósito |
| :--- | :--- | :--- | :--- | :--- |
| `session-harvester.js` | Wrapper (Daily) | Bajo | Bajo | Recolecta sesiones frescas para ingestión |
| `self-learning-audit.js` | Wrapper (Daily V5 step 11) / Manual | Bajo | Bajo | Reporte read-only de autonomía: memorias ruidosas/útiles, stale rows, fallos repetidos, gaps y queries con baja recuperación |
| `trajectory-recorder.js` | Wrapper (Daily V5 step 14) | Bajo | Bajo | Registra trayectorias problem→solution→outcome desde sesiones recientes |
| `session-snapshot.js` | Cron every 4h | **Medio** | Medio | Crea snapshots de sesiones recientes y alimenta handoff promotion |
| `skill-promoter.js` | Background Review cron / Apply manual | Medio | Medio | Detecta workflows procedurales reutilizables y emite candidatos SKILL.md review-gated |
| `skill-curator.js` | Skill Curator cron semanal / Manual | Bajo | Bajo | Lifecycle reversible para skills `brainx-created`: status, pin, archive, restore, prune |
| `dedup-supersede.js` | Wrapper (Sunday exact/hash dedup) / Manual | Medio | Alto | Elimina memorias duplicadas/obsoletas por hash/fingerprint exacto |
| `brainx fix --only stale-demotion,auto-dedup,runtime-scoring-backlog` | Wrapper (Sunday) / Manual | Medio | Alto | Cubre warnings accionables de doctor/self-audit: democión hot/warm stale, supersede high-similarity y cierre de scoring runtime viejo |
| `quality-scorer.js` | Manual | Medio | Medio | Evalúa calidad semántica de memorias |
| `eval-memory-quality.js`| Manual | Alto | Alto | Análisis profundo de dataset (Rag/Eval) |
| `backup-brainx.sh` | Semanal | Bajo | Bajo | Backup SQL de BrainX (vía pg_dump) |
| `event-ledger.js` | Manual / CLI | Bajo | Bajo | Índice forense determinístico para fixes, incidentes, decisiones, deployments, handoffs y auditorías |
| `skill-promoter.js` | Manual | Bajo | Bajo | Detecta candidatos de skills desde patrones BrainX, opcionalmente sesiones crudas con `--hybrid`, y aplica cambios Hermes-style con rollback |

*Nota: Cualquier script que gestione datos de BrainX debe ser ejecutado mediante el agente de mantenimiento único para evitar inconsistencias.*
