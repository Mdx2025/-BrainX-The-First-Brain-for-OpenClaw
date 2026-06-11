#!/usr/bin/env node
/**
 * method-error-report.js — trazabilidad READ-ONLY del loop de errores de método.
 *
 * Muestra el embudo completo, todo desde datos ya registrados:
 *   CAPTURADO  (brainx_memories, tag method-error)
 *     → INYECTADO  (brainx_runtime_injections.memory_ids: el plugin lo puso en el prompt de un agente)
 *       → REFERENCIADO  (referenced_ids / soft_referenced_ids: el agente REALMENTE lo usó)
 *         → PROMOVIDO a durable  (source_kind=knowledge_canonical + tag usage-validated)
 *
 * No escribe nada. Corré esto en 1 semana para ver si el loop funcionó de verdad.
 *
 * Uso: node method-error-report.js [--days 30] [--json]
 */
'use strict';
const { query } = require('../lib/db.js');

const days = (() => { const i = process.argv.indexOf('--days'); return i >= 0 ? parseInt(process.argv[i + 1], 10) || 30 : 30; })();
const asJson = process.argv.includes('--json');

(async () => {
  // 1. CAPTURADO
  const caps = await query(
    `SELECT id, agent, tier, source_kind, importance, created_at,
            (source_kind = 'knowledge_canonical') AS promoted,
            EXISTS (SELECT 1 FROM unnest(tags) t WHERE t LIKE 'usage-validated:%') AS has_promo_tag,
            LEFT(content, 90) AS preview
       FROM brainx_memories
      WHERE type = 'gotcha' AND tags @> ARRAY['method-error']::text[]
      ORDER BY created_at DESC`,
  );
  const ids = caps.rows.map((r) => r.id);

  // 2/3. INYECTADO + REFERENCIADO (por gotcha)
  let injByMem = {};
  if (ids.length) {
    const inj = await query(
      `
      SELECT mid,
        COUNT(*)::int AS times_injected,
        SUM(CASE WHEN mid = ANY(ri.referenced_ids) THEN 1 ELSE 0 END)::int AS hard_ref,
        SUM(CASE WHEN mid = ANY(ri.soft_referenced_ids) THEN 1 ELSE 0 END)::int AS soft_ref,
        COUNT(DISTINCT ri.agent)::int AS distinct_agents,
        MAX(ri.injected_at) AS last_injected
      FROM brainx_runtime_injections ri, LATERAL unnest(ri.memory_ids) mid
      WHERE ri.injected_at > NOW() - ($2::int || ' days')::interval
        AND mid = ANY($1::text[])
      GROUP BY mid
      `,
      [ids, days],
    );
    for (const r of inj.rows) injByMem[r.mid] = r;
  }

  const rows = caps.rows.map((c) => {
    const i = injByMem[c.id] || {};
    return {
      id: c.id, agent: c.agent, tier: c.tier, source_kind: c.source_kind, importance: c.importance,
      promoted: Boolean(c.promoted || c.has_promo_tag),
      times_injected: i.times_injected || 0,
      hard_ref: i.hard_ref || 0,
      soft_ref: i.soft_ref || 0,
      distinct_agents: i.distinct_agents || 0,
      preview: c.preview,
    };
  });

  const funnel = {
    windowDays: days,
    captured: rows.length,
    injected_at_least_once: rows.filter((r) => r.times_injected > 0).length,
    referenced_at_least_once: rows.filter((r) => r.hard_ref > 0 || r.soft_ref > 0).length,
    hard_referenced: rows.filter((r) => r.hard_ref > 0).length,
    promoted_durable: rows.filter((r) => r.promoted).length,
    total_injections: rows.reduce((a, r) => a + r.times_injected, 0),
    cross_agent_spread: rows.reduce((a, r) => Math.max(a, r.distinct_agents), 0),
  };

  if (asJson) {
    console.log(JSON.stringify({ funnel, rows }, null, 2));
    process.exit(0);
  }

  console.log('═══ BrainX — Trazabilidad del loop de errores de método ═══');
  console.log(`Ventana: últimos ${days} días\n`);
  console.log('EMBUDO:');
  console.log(`  📥 Capturados (gotchas method-error) ........ ${funnel.captured}`);
  console.log(`  📡 Inyectados a un agente ≥1 vez ............ ${funnel.injected_at_least_once}  (${funnel.total_injections} inyecciones totales)`);
  console.log(`  ✅ Referenciados por un agente (lo USÓ) ..... ${funnel.referenced_at_least_once}  (hard: ${funnel.hard_referenced})`);
  console.log(`  ⭐ Promovidos a durable (knowledge_canonical) ${funnel.promoted_durable}`);
  console.log(`  🔀 Máx. agentes distintos sobre un gotcha ... ${funnel.cross_agent_spread}`);
  console.log('\n─── Detalle por gotcha ───\n');
  for (const r of rows) {
    const flags = [r.promoted ? '⭐durable' : '', r.hard_ref > 0 ? '✅usado' : r.times_injected > 0 ? '📡inyectado' : '·dormido'].filter(Boolean).join(' ');
    console.log(`• ${r.id}  [${r.agent}] ${flags}`);
    console.log(`  inj=${r.times_injected} hard_ref=${r.hard_ref} soft_ref=${r.soft_ref} agentes=${r.distinct_agents} src=${r.source_kind}`);
    console.log(`  ${r.preview}\n`);
  }
  if (!rows.some((r) => r.times_injected > 0)) {
    console.log('(Nada inyectado aún: normal si los gotchas son recientes y no hubo prompts afines todavía.)');
  }
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
