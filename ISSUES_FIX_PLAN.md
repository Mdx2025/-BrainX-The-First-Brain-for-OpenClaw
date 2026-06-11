# BrainX V5 — Issues & Fixes Log

> Todos los issues resueltos en la release 0.4.0 (2026-04-05).
> Para detalles completos de cada fix, ver [CHANGELOG.md](./CHANGELOG.md).

## Estado: Todo resuelto

| # | Issue | Severidad | Estado |
|---|-------|-----------|--------|
| 1 | Dotenv sin path explícito en 2 scripts | Baja | Resuelto |
| 2 | Modelo hardcodeado en memory-distiller | Baja | Ya estaba resuelto |
| 3 | Rate limiting en OpenAI embed() | Media | Ya estaba resuelto |
| 4 | Tests unitarios faltantes | Baja | Ya existían |
| 5 | Reintentos en hook/handler.js | Media | Ya estaba resuelto |
| 6 | Cross-agent learning roto (99.6% rechazo) | **Crítica** | Resuelto en 0.4.0 |
| 7 | Auto-promotion atascado (0 candidatos) | **Alta** | Resuelto en 0.4.0 |
| 8 | 33 agent profiles idénticos | **Alta** | Resuelto en 0.4.0 |
| 9 | Memorias resueltas/expiradas inyectadas | **Crítica** | Resuelto en 0.4.0 |
| 10 | Filtros de seguridad inconsistentes (auditoría) | **Crítica** | Resuelto en 0.4.0 |
| 11 | Pipeline de 16 pasos redundante | Media | Reestructurado en 0.4.0 |
| 12 | 5 features sin documentación en brainx.md | Baja | Documentado en 0.4.0 |
| 13 | 4 agentes sin perfil (claude, codex, gemini, kimi) | Baja | Agregados en 0.4.0 |

## Filtros de seguridad estándar

Toda query que sirve memorias a agentes DEBE incluir los 4 filtros:

```sql
AND superseded_by IS NULL
AND COALESCE(status, 'pending') NOT IN ('resolved', 'wont_fix')
AND (expires_at IS NULL OR expires_at > NOW())
AND COALESCE(verification_state, 'hypothesis') != 'obsolete'
```

**Archivos que cumplen (verificado 2026-04-05):**
- `hook/handler.js` — queryTopMemories, queryAgentMemories, queryByType, queryFacts, queryScopedMemories
- `lib/openai-rag.js` — search()
- `lib/advisory.js` — queryTrajectories (sin expires_at, tabla no tiene), queryPatterns (filtros en JOIN)
- `lib/cli.js` — cmdFacts, cmdFeatures
- `scripts/context-pack-builder.js` — fetch principal
- `scripts/cross-agent-learning.js` — candidatos

## Pipeline reestructurado (v0.4.0, actualizado 2026-04-28)

**Diario: 13 pasos**
1. bootstrap → memory-distiller → session-harvester → handoff-promoter → memory-bridge → cross-agent-learning → context-pack-builder → error-harvester → reclassify-memories → degrade-over-injected → wiki-compile → runtime-regression-suite → trajectory-recorder

**Miércoles + domingo: +2 pasos**
lifecycle-run + contradiction-detector

**Domingo: 13 + 2 + 7 = 22 pasos**
Los pasos diarios + midweek + memory-consolidation, auto-promoter, promotion-applier, memory-enforcer, memory-audit, dedup-supersede, cleanup-low-signal

**Eliminados:** auto-distiller (redundante), memory-md-harvester (67% duplicados)
