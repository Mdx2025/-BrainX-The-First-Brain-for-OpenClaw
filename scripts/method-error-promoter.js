#!/usr/bin/env node
/**
 * method-error-promoter.js — promueve gotchas de error-de-método que YA
 * demostraron utilidad (fueron REFERENCIADOS por agentes reales) a un estado
 * DURABLE, para que no caduquen por la ventana de recencia de 14d del path
 * SECONDARY (`agent_inference`) en bridge.ts.
 *
 * Mecanismo honesto: el criterio de promoción es EVIDENCIA real de uso
 * (`brainx_runtime_injections.referenced_ids` — un agente referenció la memoria
 * en su output), no una suposición. Al graduar a `source_kind=knowledge_canonical`
 * el gotcha entra al path PRIMARY de `decideRecallRow` (bridge.ts:2709), que NO
 * tiene cap de recencia → recall indefinido mientras siga siendo útil. Se tagea
 * `usage-validated:<fecha>:refN` para trazabilidad. Idempotente: tras promover,
 * `source_kind` ya no es `agent_inference`, así que no re-matchea.
 *
 * Uso: node method-error-promoter.js [--window 90] [--min-referenced 1]
 *      [--limit 50] [--apply] [--json]   (dry-run por defecto)
 */
'use strict';
const { query } = require('../lib/db.js');

function parseArgs(argv) {
  const a = { window: 90, minReferenced: 1, limit: 50, apply: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--window') a.window = parseInt(argv[++i], 10) || 90;
    else if (k === '--min-referenced') a.minReferenced = parseInt(argv[++i], 10) || 1;
    else if (k === '--limit') a.limit = parseInt(argv[++i], 10) || 50;
    else if (k === '--apply') a.apply = true;
    else if (k === '--json') a.json = true;
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function findCandidates(cfg) {
  const r = await query(
    `
    WITH per_mem AS (
      SELECT mid,
        SUM(CASE WHEN mid = ANY(ri.referenced_ids) THEN 1 ELSE 0 END)::int AS times_referenced,
        COUNT(*)::int AS times_injected,
        COUNT(DISTINCT ri.agent)::int AS distinct_agents
      FROM brainx_runtime_injections ri,
           LATERAL unnest(ri.memory_ids) mid
      WHERE ri.injected_at > NOW() - ($1::int || ' days')::interval
      GROUP BY mid
    )
    SELECT m.id, m.tier, m.importance, m.tags,
           p.times_referenced, p.times_injected, p.distinct_agents,
           LEFT(m.content, 160) AS preview
    FROM per_mem p
    JOIN brainx_memories m ON m.id = p.mid
    WHERE m.type = 'gotcha'
      AND m.source_kind = 'agent_inference'
      AND m.tags @> ARRAY['method-error']::text[]
      AND m.superseded_by IS NULL
      AND p.times_referenced >= $2::int
    ORDER BY p.times_referenced DESC, p.distinct_agents DESC
    LIMIT $3::int
    `,
    [cfg.window, cfg.minReferenced, cfg.limit],
  );
  return r.rows;
}

async function promote(row, day) {
  const tags = Array.isArray(row.tags) ? row.tags.slice() : [];
  const tag = `usage-validated:${day}:ref${row.times_referenced}`;
  if (!tags.includes(tag)) tags.push(tag);
  // Durabilidad = source_kind PRIMARY (path L2709 de decideRecallRow, SIN cap de
  // recencia; el SECONDARY agent_inference caduca a 14d desde created_at porque
  // brainx_memories no tiene updated_at y rowAgeDays cae a created_at). No cambia
  // tier (warm/hot ya inyectan). Conserva verification_state=verified.
  await query(
    `UPDATE brainx_memories
       SET source_kind = 'knowledge_canonical', tags = $2
     WHERE id = $1`,
    [row.id, tags],
  );
}

(async () => {
  const day = today();
  const candidates = await findCandidates(args);
  const promoted = [];
  if (args.apply) {
    for (const c of candidates) {
      try { await promote(c, day); promoted.push(c.id); }
      catch (e) { /* fila a fila; un fallo no aborta el resto */ }
    }
  }

  const summary = {
    mode: args.apply ? 'APPLY' : 'DRY-RUN',
    windowDays: args.window,
    minReferenced: args.minReferenced,
    candidates: candidates.length,
    promoted: promoted.length,
  };

  if (args.json) {
    console.log(JSON.stringify({ summary, candidates: candidates.map((c) => ({ id: c.id, times_referenced: c.times_referenced, times_injected: c.times_injected, distinct_agents: c.distinct_agents, tier: c.tier, importance: c.importance, preview: c.preview })) }, null, 2));
  } else {
    console.log('═══ BrainX Method-Error Promoter (durabilidad por uso) ═══');
    console.log(JSON.stringify(summary, null, 2));
    if (candidates.length) {
      console.log('\n─── Gotchas que demostraron utilidad (ref≥' + args.minReferenced + ') ───\n');
      for (const c of candidates) {
        console.log(`• ${c.id}  ref=${c.times_referenced} inj=${c.times_injected} agentes=${c.distinct_agents} tier=${c.tier}  ${args.apply ? '→ promovido a knowledge_canonical' : '(dry-run)'}`);
        console.log(`  ${c.preview}\n`);
      }
    } else {
      console.log('\n(sin candidatos: ningún gotcha method-error fue referenciado aún en la ventana — esperado al inicio)');
    }
    if (!args.apply) console.log('Para promover: --apply');
  }
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
