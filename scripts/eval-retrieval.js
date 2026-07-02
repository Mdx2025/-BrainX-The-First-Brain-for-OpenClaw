#!/usr/bin/env node
'use strict';
// BRAINX_RETRIEVAL_EVAL_20260702 — eval de retrieval con ground truth REAL.
//
// Por qué existe: el juez offline previo era auto-etiquetado (la query era el
// propio content de la memoria) e idealizado — media artefactos, no retrieval.
// Acá cada caso es una pregunta operativa en lenguaje natural y el ground truth
// es un anchor (marker/id/string distintivo) verificado contra el corpus: la
// fila correcta DEBE aparecer en el top-k del search real (mismo path que el
// runtime: lib/openai-rag.search, columna activa, calibración, pesos).
//
// Métricas honestas: hit@1, hit@k, MRR, leak_rate (filas sensitive/restricted
// devueltas bajo maxSensitivity=normal), latencia p50/p95. NO reporta
// "precision@k" — no hay labels de relevancia por fila y no vamos a inventarlos.
//
// Uso:  node scripts/eval-retrieval.js [--json] [--cases path.json]
// Exit: 0 ok; 1 si hay LEAK (fuga de sensibilidad) — los misses de recall no
//       fallan el proceso, son la medición.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const casesIdx = argv.indexOf('--cases');
const casesPath = casesIdx >= 0 ? argv[casesIdx + 1] : path.join(__dirname, '..', 'eval', 'retrieval-cases.json');

function pct(n, d) { return d ? Math.round((n / d) * 1000) / 10 : 0; }
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i];
}

async function main() {
  const spec = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
  const defaults = spec.defaults || {};
  const rag = require('../lib/openai-rag');
  const db = require('../lib/db');

  const results = [];
  const latencies = [];
  let leaks = 0;

  for (const c of spec.cases) {
    const k = c.k || defaults.k || 5;
    const maxSensitivity = c.maxSensitivity || defaults.maxSensitivity || 'normal';
    const t0 = Date.now();
    let rows = [];
    let error = null;
    try {
      rows = await rag.search(c.query, {
        limit: k,
        maxSensitivity,
        agentId: 'eval-harness',
        surface: 'retrieval_eval',
      });
    } catch (err) {
      error = err.message;
    }
    const latencyMs = Date.now() - t0;
    latencies.push(latencyMs);
    rows = Array.isArray(rows) ? rows : [];

    // rank del primer hit (1-indexed) contra cualquier anchor
    let rank = null;
    if ((c.expect_any_substring || []).length) {
      for (let i = 0; i < rows.length; i++) {
        const hay = `${rows[i].content || ''}\n${rows[i].context || ''}`.toLowerCase();
        if (c.expect_any_substring.some((a) => hay.includes(a.toLowerCase()))) { rank = i + 1; break; }
      }
    }

    // aislamiento multi-proyecto: filas devueltas que NO deben pertenecer a otro
    // proyecto (52 agentes multi-proyecto — traer el proyecto equivocado es el
    // drift cross-proyecto que ya causó incidentes reales).
    let forbiddenRows = [];
    if (Array.isArray(c.forbidden_any_substring) && c.forbidden_any_substring.length && rows.length) {
      forbiddenRows = rows
        .filter((r) => {
          const hay = `${r.content || ''}\n${r.context || ''}`.toLowerCase();
          return c.forbidden_any_substring.some((f) => hay.includes(f.toLowerCase()));
        })
        .map((r) => r.id);
    }

    // leak check: bajo maxSensitivity=normal ninguna fila puede ser sensitive/restricted.
    // search() puede no devolver la columna — reconsultamos por id (fuente de verdad).
    let leakRows = [];
    if (c.leak_check && rows.length) {
      const ids = rows.map((r) => r.id).filter(Boolean);
      if (ids.length) {
        const res = await db.query(
          `SELECT id, sensitivity FROM brainx_memories WHERE id = ANY($1) AND COALESCE(sensitivity,'normal') <> 'normal'`,
          [ids]
        );
        leakRows = res.rows;
        leaks += leakRows.length;
      }
    }

    results.push({
      name: c.name,
      leak_check: !!c.leak_check,
      k,
      returned: rows.length,
      rank,
      hit_at_1: rank === 1,
      hit_at_k: rank != null,
      rr: rank ? 1 / rank : 0,
      leak_rows: leakRows.map((r) => r.id),
      forbidden_rows: forbiddenRows,
      latency_ms: latencyMs,
      error,
    });
  }

  const scored = results.filter((r) => !r.leak_check);
  const leakChecked = results.filter((r) => r.leak_check);
  const sortedLat = [...latencies].sort((a, b) => a - b);
  const summary = {
    generated_at: new Date().toISOString(),
    cases: results.length,
    scored_cases: scored.length,
    hit_at_1: pct(scored.filter((r) => r.hit_at_1).length, scored.length),
    hit_at_k: pct(scored.filter((r) => r.hit_at_k).length, scored.length),
    mrr: scored.length ? Math.round((scored.reduce((s, r) => s + r.rr, 0) / scored.length) * 1000) / 1000 : 0,
    leak_cases: leakChecked.length,
    leaked_rows: leaks,
    isolation_violations: results.reduce((s, r) => s + (r.forbidden_rows?.length || 0), 0),
    latency_p50_ms: quantile(sortedLat, 0.5),
    latency_p95_ms: quantile(sortedLat, 0.95),
    misses: scored.filter((r) => !r.hit_at_k).map((r) => r.name),
  };

  if (asJson) {
    console.log(JSON.stringify({ summary, results }, null, 2));
  } else {
    console.log(`\n=== BrainX retrieval eval (${summary.cases} casos, ${casesPath}) ===`);
    for (const r of results) {
      const tag = r.leak_check
        ? (r.leak_rows.length ? `LEAK(${r.leak_rows.length})` : 'no-leak')
        : (r.rank ? `hit@${r.rank}` : 'MISS');
      const iso = r.forbidden_rows?.length ? `  ISO-VIOL(${r.forbidden_rows.length})` : '';
      console.log(`  ${tag.padEnd(9)} ${String(r.latency_ms).padStart(5)}ms  ${r.name}${iso}${r.error ? '  ERR:' + r.error : ''}`);
    }
    console.log(`\n  hit@1=${summary.hit_at_1}%  hit@k=${summary.hit_at_k}%  MRR=${summary.mrr}  leaks=${summary.leaked_rows}  iso-viol=${summary.isolation_violations}  p50=${summary.latency_p50_ms}ms p95=${summary.latency_p95_ms}ms`);
    if (summary.misses.length) console.log(`  misses: ${summary.misses.join(' | ')}`);
  }

  // Snapshot para tendencia (mismo patrón que effectiveness/)
  try {
    const outDir = path.join(__dirname, '..', 'effectiveness');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `retrieval-eval-${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify({ summary, results }, null, 2));
  } catch (_) {}

  process.exit(leaks > 0 ? 1 : 0);
}

main().catch((err) => { console.error('eval-retrieval FATAL:', err.message); process.exit(2); });
