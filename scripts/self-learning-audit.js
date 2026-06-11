#!/usr/bin/env node
/**
 * BrainX self-learning audit.
 *
 * Read-only autonomy layer: combines memory lifecycle, runtime injection
 * usefulness, repeated failures, and knowledge-gap signals into one prioritized
 * recommendation payload. It deliberately does not mutate production memory.
 */

'use strict';

const path = require('path');

try {
  const dotenv = require('dotenv');
  const envPath = process.env.BRAINX_ENV || path.join(__dirname, '..', '.env');
  dotenv.configDotenv({ path: envPath, quiet: true });
} catch (_) {}

let defaultDb;

function getDefaultDb() {
  if (!defaultDb) defaultDb = require('../lib/db');
  return defaultDb;
}

const DEFAULTS = {
  days: 14,
  limit: 25,
  minInjections: 12,
  maxReferences: 0,
  minReferences: 2,
  minPositiveFeedback: 2,
  staleAgeDays: 45,
  staleTouchDays: 30,
  lowAccessMax: 1,
  maxFeedbackForStale: 0,
  minFailureRecurrence: 2,
  queryZeroResultWarnPct: 35,
};

function parseInteger(value, fallback, min = 0) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}

function parseArgs(argv) {
  const out = {
    ...DEFAULTS,
    json: false,
    markdown: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--markdown') out.markdown = true;
    else if (a === '--days') out.days = parseInteger(argv[++i], DEFAULTS.days, 1);
    else if (a === '--limit') out.limit = parseInteger(argv[++i], DEFAULTS.limit, 1);
    else if (a === '--min-injections') out.minInjections = parseInteger(argv[++i], DEFAULTS.minInjections, 1);
    else if (a === '--max-references') out.maxReferences = parseInteger(argv[++i], DEFAULTS.maxReferences, 0);
    else if (a === '--min-references') out.minReferences = parseInteger(argv[++i], DEFAULTS.minReferences, 1);
    else if (a === '--min-positive-feedback') out.minPositiveFeedback = parseInteger(argv[++i], DEFAULTS.minPositiveFeedback, 1);
    else if (a === '--stale-age-days') out.staleAgeDays = parseInteger(argv[++i], DEFAULTS.staleAgeDays, 1);
    else if (a === '--stale-touch-days') out.staleTouchDays = parseInteger(argv[++i], DEFAULTS.staleTouchDays, 1);
    else if (a === '--low-access-max') out.lowAccessMax = parseInteger(argv[++i], DEFAULTS.lowAccessMax, 0);
    else if (a === '--max-feedback-for-stale') out.maxFeedbackForStale = parseInteger(argv[++i], DEFAULTS.maxFeedbackForStale, -999);
    else if (a === '--min-failure-recurrence') out.minFailureRecurrence = parseInteger(argv[++i], DEFAULTS.minFailureRecurrence, 2);
    else if (a === '--query-zero-result-warn-pct') out.queryZeroResultWarnPct = parseInteger(argv[++i], DEFAULTS.queryZeroResultWarnPct, 1);
    else if (a === '--help' || a === '-h') out.help = true;
  }

  return out;
}

function usage() {
  return `brainx self-learning-audit [--json] [--markdown]

Read-only self-learning report for BrainX memory autonomy.

Options:
  --days <n>                       Runtime/query/failure window (default 14)
  --limit <n>                      Max rows per recommendation bucket (default 25)
  --min-injections <n>             Weak-memory injection threshold (default 12)
  --max-references <n>             Weak-memory reference ceiling (default 0)
  --min-references <n>             Useful-memory reference threshold (default 2)
  --min-positive-feedback <n>      Useful-memory feedback threshold (default 2)
  --stale-age-days <n>             Memory age gate for stale review (default 45)
  --stale-touch-days <n>           Last-access gate for stale review (default 30)
  --low-access-max <n>             Stale memory access ceiling (default 1)
  --min-failure-recurrence <n>     Repeated-failure gate (default 2)
`;
}

function pct(num, den) {
  const n = Number(num || 0);
  const d = Number(den || 0);
  if (!d) return 0;
  return Math.round((n / d) * 1000) / 10;
}

function compactPreview(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 3).trim() + '...';
}

function compactRows(rows, max = 8) {
  return (rows || []).slice(0, max).map((row) => ({
    id: row.id || row.ids?.[0] || null,
    ids: row.ids || undefined,
    type: row.type || undefined,
    category: row.category || undefined,
    tier: row.tier || undefined,
    importance: row.importance == null ? undefined : Number(row.importance),
    access_count: row.access_count == null ? undefined : Number(row.access_count),
    feedback_score: row.feedback_score == null ? undefined : Number(row.feedback_score),
    times_injected: row.times_injected == null ? undefined : Number(row.times_injected),
    times_referenced: row.times_referenced == null ? undefined : Number(row.times_referenced),
    occurrences: row.occurrences == null ? undefined : Number(row.occurrences),
    agents: row.agents || undefined,
    preview: compactPreview(row.preview || row.content || row.fingerprint || ''),
  }));
}

async function safeQuery(db, warnings, label, sql, params = [], optional = false) {
  try {
    const result = await db.query(sql, params);
    return result.rows || [];
  } catch (err) {
    const message = String(err?.message || err);
    warnings.push({ label, optional, message });
    if (!optional) throw err;
    return [];
  }
}

async function getMemorySummary(db, warnings) {
  const rows = await safeQuery(db, warnings, 'memory_summary', `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE superseded_by IS NULL)::int AS active,
      COUNT(*) FILTER (WHERE superseded_by IS NOT NULL)::int AS superseded,
      COUNT(*) FILTER (WHERE COALESCE(verification_state, 'hypothesis') = 'obsolete')::int AS obsolete,
      COUNT(*) FILTER (WHERE tier = 'hot' AND superseded_by IS NULL)::int AS hot,
      COUNT(*) FILTER (WHERE tier = 'warm' AND superseded_by IS NULL)::int AS warm,
      COUNT(*) FILTER (WHERE tier = 'cold' AND superseded_by IS NULL)::int AS cold,
      COUNT(*) FILTER (WHERE tier = 'archive' AND superseded_by IS NULL)::int AS archive,
      ROUND(AVG(COALESCE(importance, 5))::numeric, 2) AS avg_importance,
      ROUND(AVG(COALESCE(feedback_score, 0))::numeric, 2) AS avg_feedback
    FROM brainx_memories
  `);
  return rows[0] || {};
}

async function getRuntimeSummary(db, warnings, cfg) {
  const rows = await safeQuery(db, warnings, 'runtime_summary', `
    SELECT
      COUNT(*)::int AS injections,
      COALESCE(SUM(selected_count), 0)::int AS selected,
      COALESCE(SUM(referenced_count), 0)::int AS hard_referenced,
      COALESCE(SUM(soft_referenced_count), 0)::int AS soft_referenced,
      COUNT(*) FILTER (
        WHERE COALESCE(selected_count, 0) > 0
          AND scored_at IS NULL
          AND injected_at < NOW() - interval '6 hours'
      )::int AS stale_unscored,
      ROUND(AVG(latency_ms)::numeric, 1) AS avg_latency_ms
    FROM brainx_runtime_injections
    WHERE injected_at >= NOW() - ($1::int || ' days')::interval
  `, [cfg.days], true);
  const row = rows[0] || {};
  return {
    ...row,
    hard_signal_ratio_pct: pct(row.hard_referenced, row.selected),
    soft_signal_ratio_pct: pct(row.soft_referenced, row.selected),
  };
}

async function getWeakMemoryCandidates(db, warnings, cfg) {
  return safeQuery(db, warnings, 'weak_memory_candidates', `
    WITH per_mem AS (
      SELECT mid,
             COUNT(*)::int AS times_injected,
             SUM(CASE WHEN mid = ANY(COALESCE(ri.referenced_ids, '{}'::text[])) THEN 1 ELSE 0 END)::int AS times_referenced,
             COUNT(DISTINCT ri.agent)::int AS distinct_agents,
             MAX(ri.injected_at) AS last_injected
      FROM brainx_runtime_injections ri,
           LATERAL unnest(COALESCE(ri.memory_ids, '{}'::text[])) mid
      WHERE ri.injected_at >= NOW() - ($1::int || ' days')::interval
      GROUP BY mid
    )
    SELECT p.mid AS id, p.times_injected, p.times_referenced, p.distinct_agents, p.last_injected,
           m.type, m.category, m.tier, m.importance, m.feedback_score, m.verification_state,
           LEFT(m.content, 220) AS preview
    FROM per_mem p
    JOIN brainx_memories m ON m.id = p.mid
    WHERE p.times_injected >= $2::int
      AND p.times_referenced <= $3::int
      AND m.superseded_by IS NULL
      AND m.tier IN ('hot', 'warm')
      AND COALESCE(m.verification_state, 'hypothesis') <> 'obsolete'
    ORDER BY p.times_injected DESC, m.importance DESC
    LIMIT $4::int
  `, [cfg.days, cfg.minInjections, cfg.maxReferences, cfg.limit], true);
}

async function getUsefulMemoryCandidates(db, warnings, cfg) {
  return safeQuery(db, warnings, 'useful_memory_candidates', `
    WITH per_mem AS (
      SELECT mid,
             COUNT(*)::int AS times_injected,
             SUM(CASE WHEN mid = ANY(COALESCE(ri.referenced_ids, '{}'::text[])) THEN 1 ELSE 0 END)::int AS times_referenced,
             MAX(ri.injected_at) AS last_injected
      FROM brainx_runtime_injections ri,
           LATERAL unnest(COALESCE(ri.memory_ids, '{}'::text[])) mid
      WHERE ri.injected_at >= NOW() - ($1::int || ' days')::interval
      GROUP BY mid
    )
    SELECT p.mid AS id, p.times_injected, p.times_referenced, p.last_injected,
           m.type, m.category, m.tier, m.importance, m.feedback_score, m.verification_state,
           LEFT(m.content, 220) AS preview
    FROM per_mem p
    JOIN brainx_memories m ON m.id = p.mid
    WHERE m.superseded_by IS NULL
      AND COALESCE(m.verification_state, 'hypothesis') <> 'obsolete'
      AND (
        p.times_referenced >= $2::int
        OR COALESCE(m.feedback_score, 0) >= $3::int
      )
      AND (m.tier <> 'hot' OR COALESCE(m.importance, 5) < 8)
    ORDER BY p.times_referenced DESC, COALESCE(m.feedback_score, 0) DESC, m.importance DESC
    LIMIT $4::int
  `, [cfg.days, cfg.minReferences, cfg.minPositiveFeedback, cfg.limit], true);
}

async function getStaleMemoryCandidates(db, warnings, cfg) {
  return safeQuery(db, warnings, 'stale_memory_candidates', `
    SELECT id, type, category, tier, importance, access_count, feedback_score,
           verification_state, created_at, last_accessed,
           LEFT(content, 220) AS preview
    FROM brainx_memories
    WHERE superseded_by IS NULL
      AND tier IN ('hot', 'warm')
      AND COALESCE(verification_state, 'hypothesis') <> 'obsolete'
      AND created_at < NOW() - ($1::int || ' days')::interval
      AND (last_accessed IS NULL OR last_accessed < NOW() - ($2::int || ' days')::interval)
      AND COALESCE(access_count, 0) <= $3::int
      AND COALESCE(feedback_score, 0) <= $4::int
    ORDER BY tier ASC, importance DESC, created_at ASC
    LIMIT $5::int
  `, [cfg.staleAgeDays, cfg.staleTouchDays, cfg.lowAccessMax, cfg.maxFeedbackForStale, cfg.limit], true);
}

async function getRepeatedFailures(db, warnings, cfg) {
  return safeQuery(db, warnings, 'repeated_failures', `
    SELECT
      regexp_replace(lower(LEFT(content, 220)), '\\s+', ' ', 'g') AS fingerprint,
      COUNT(*)::int AS occurrences,
      ARRAY_AGG(id ORDER BY created_at DESC) AS ids,
      STRING_AGG(DISTINCT COALESCE(agent, 'unknown'), ', ' ORDER BY COALESCE(agent, 'unknown')) AS agents,
      MAX(created_at) AS last_seen,
      MAX(importance)::int AS importance,
      LEFT((ARRAY_AGG(content ORDER BY created_at DESC))[1], 220) AS preview
    FROM brainx_memories
    WHERE superseded_by IS NULL
      AND created_at >= NOW() - ($1::int || ' days')::interval
      AND (
        COALESCE(source_kind, '') = 'tool_verified'
        OR COALESCE(tags, '{}'::text[]) && ARRAY['error', 'severity:high', 'severity:critical']
        OR content ~* '(command failed|exit [1-9][0-9]*|error:|typeerror|referenceerror|syntaxerror|enoent|eacces|eperm|permission denied|failed)'
      )
    GROUP BY 1
    HAVING COUNT(*) >= $2::int
    ORDER BY occurrences DESC, MAX(created_at) DESC
    LIMIT $3::int
  `, [cfg.days, cfg.minFailureRecurrence, cfg.limit], true);
}

async function getKnowledgeGaps(db, warnings, cfg) {
  return safeQuery(db, warnings, 'knowledge_gaps', `
    SELECT id, type, category, status, tier, importance, access_count, feedback_score,
           COALESCE(last_seen, created_at) AS last_seen,
           LEFT(content, 220) AS preview
    FROM brainx_memories
    WHERE superseded_by IS NULL
      AND category = 'knowledge_gap'
      AND COALESCE(status, 'pending') NOT IN ('resolved', 'promoted', 'wont_fix')
      AND COALESCE(verification_state, 'hypothesis') <> 'obsolete'
    ORDER BY importance DESC, COALESCE(last_seen, created_at) DESC
    LIMIT $1::int
  `, [cfg.limit], true);
}

async function getQueryGapSummary(db, warnings, cfg) {
  return safeQuery(db, warnings, 'query_gap_summary', `
    SELECT query_kind,
           COUNT(*)::int AS calls,
           COUNT(*) FILTER (WHERE COALESCE(results_count, 0) = 0)::int AS zero_result_calls,
           ROUND(AVG(COALESCE(results_count, 0))::numeric, 2) AS avg_results,
           ROUND(AVG(top_similarity)::numeric, 4) AS avg_top_similarity
    FROM brainx_query_log
    WHERE created_at >= NOW() - ($1::int || ' days')::interval
    GROUP BY query_kind
    ORDER BY query_kind
  `, [cfg.days], true);
}

function makeRecommendation(key, severity, confidence, reason, rows, command, nextStep) {
  return {
    key,
    severity,
    confidence,
    reason,
    evidence_count: rows.length,
    evidence: compactRows(rows),
    command,
    next_step: nextStep,
  };
}

function buildRecommendations(data, cfg) {
  const recommendations = [];

  if (data.weakMemoryCandidates.length) {
    recommendations.push(makeRecommendation(
      'degrade_noisy_memories',
      data.weakMemoryCandidates.length >= 10 ? 'high' : 'medium',
      0.88,
      `Memories injected >=${cfg.minInjections} times in ${cfg.days}d with <=${cfg.maxReferences} hard references.`,
      data.weakMemoryCandidates,
      `node scripts/degrade-over-injected.js --mode both --window ${cfg.days} --min ${cfg.minInjections} --max-ref ${cfg.maxReferences} --json`,
      'Run the command first as dry-run; use --apply only after review because it changes tiers.',
    ));
  }

  if (data.usefulMemoryCandidates.length) {
    recommendations.push(makeRecommendation(
      'promote_useful_memories',
      'medium',
      0.82,
      'Some memories are repeatedly referenced or positively scored but are not yet clearly hot/high-priority.',
      data.usefulMemoryCandidates,
      './brainx feedback --id <memory_id> --useful',
      'Review the top rows and boost only those that are specific, current, and verified.',
    ));
  }

  if (data.staleMemoryCandidates.length) {
    recommendations.push(makeRecommendation(
      'curate_stale_hot_warm_memories',
      data.staleMemoryCandidates.length >= 10 ? 'high' : 'medium',
      0.8,
      'Hot/warm memories are old, barely accessed, and have no positive feedback.',
      data.staleMemoryCandidates,
      `node scripts/quality-scorer.js --dry-run --limit ${Math.max(cfg.limit, 50)}`,
      'Use quality-scorer/lifecycle review before demotion; do not delete without supersede trail.',
    ));
  }

  if (data.repeatedFailures.length) {
    recommendations.push(makeRecommendation(
      'promote_repeated_failures_to_gotchas',
      'medium',
      0.78,
      `Repeated error/gotcha fingerprints appeared >=${cfg.minFailureRecurrence} times in ${cfg.days}d.`,
      data.repeatedFailures,
      './brainx add --type gotcha --category error --sourceKind tool_verified --content "<validated repeated failure + fix>"',
      'Validate the recurring failure has a reusable fix before writing a durable gotcha.',
    ));
  }

  if (data.knowledgeGaps.length) {
    recommendations.push(makeRecommendation(
      'fill_open_knowledge_gaps',
      'medium',
      0.76,
      'Open knowledge_gap memories exist and should either be answered, linked to canonical docs, or closed.',
      data.knowledgeGaps,
      './brainx search --query "<gap>" --limit 5',
      'Resolve gaps into verified fact/decision/gotcha memories or mark them wont_fix when stale.',
    ));
  }

  const zeroResultRows = (data.queryGapSummary || []).filter((row) => pct(row.zero_result_calls, row.calls) >= cfg.queryZeroResultWarnPct);
  if (zeroResultRows.length) {
    recommendations.push(makeRecommendation(
      'investigate_low_recall_queries',
      'low',
      0.68,
      `Some query kinds have >=${cfg.queryZeroResultWarnPct}% zero-result calls. Query text is intentionally not stored, so this is a privacy-preserving gap signal only.`,
      zeroResultRows.map((row) => ({
        id: row.query_kind,
        preview: `${row.query_kind}: ${row.zero_result_calls}/${row.calls} zero-result calls, avg_results=${row.avg_results}`,
        occurrences: row.zero_result_calls,
      })),
      './brainx metrics --days ' + cfg.days + ' --json',
      'Use live task context to decide whether a canonical knowledge item is missing; do not log raw query text by default.',
    ));
  }

  if (Number(data.runtimeSummary.stale_unscored || 0) > 0) {
    recommendations.push({
      key: 'close_runtime_scoring_backlog',
      severity: Number(data.runtimeSummary.stale_unscored) >= 25 ? 'high' : 'medium',
      confidence: 0.84,
      reason: 'Selected runtime injections are older than 6h and still unscored, weakening the feedback loop.',
      evidence_count: Number(data.runtimeSummary.stale_unscored),
      evidence: [],
      command: './brainx runtime-report --days ' + cfg.days + ' --json',
      next_step: 'Inspect why selected rows were not scored/finalized before tuning retrieval policy.',
    });
  }

  return recommendations.sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 };
    if ((rank[a.severity] ?? 9) !== (rank[b.severity] ?? 9)) return (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9);
    return b.evidence_count - a.evidence_count;
  });
}

function autonomyScore(data, recommendations) {
  let score = 100;
  score -= Math.min(data.weakMemoryCandidates.length * 3, 24);
  score -= Math.min(data.staleMemoryCandidates.length * 2, 20);
  score -= Math.min(data.knowledgeGaps.length * 2, 16);
  score -= Math.min(data.repeatedFailures.length * 2, 16);
  score -= Math.min(Number(data.runtimeSummary.stale_unscored || 0), 20);
  score -= recommendations.filter((r) => r.severity === 'high').length * 5;
  return Math.max(0, Math.min(100, score));
}

async function run(argv = [], deps = {}) {
  const cfg = parseArgs(argv);
  if (cfg.help) {
    return { ok: true, help: usage() };
  }

  const db = deps.db || getDefaultDb();
  const warnings = [];

  const [
    memorySummary,
    runtimeSummary,
    weakMemoryCandidates,
    usefulMemoryCandidates,
    staleMemoryCandidates,
    repeatedFailures,
    knowledgeGaps,
    queryGapSummary,
  ] = await Promise.all([
    getMemorySummary(db, warnings),
    getRuntimeSummary(db, warnings, cfg),
    getWeakMemoryCandidates(db, warnings, cfg),
    getUsefulMemoryCandidates(db, warnings, cfg),
    getStaleMemoryCandidates(db, warnings, cfg),
    getRepeatedFailures(db, warnings, cfg),
    getKnowledgeGaps(db, warnings, cfg),
    getQueryGapSummary(db, warnings, cfg),
  ]);

  const data = {
    memorySummary,
    runtimeSummary,
    weakMemoryCandidates,
    usefulMemoryCandidates,
    staleMemoryCandidates,
    repeatedFailures,
    knowledgeGaps,
    queryGapSummary,
  };
  const recommendations = buildRecommendations(data, cfg);

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    mode: 'read_only',
    window_days: cfg.days,
    thresholds: {
      min_injections: cfg.minInjections,
      max_references: cfg.maxReferences,
      min_references: cfg.minReferences,
      min_positive_feedback: cfg.minPositiveFeedback,
      stale_age_days: cfg.staleAgeDays,
      stale_touch_days: cfg.staleTouchDays,
      low_access_max: cfg.lowAccessMax,
      min_failure_recurrence: cfg.minFailureRecurrence,
    },
    summary: {
      autonomy_score: autonomyScore(data, recommendations),
      active_memories: Number(memorySummary.active || 0),
      hot: Number(memorySummary.hot || 0),
      warm: Number(memorySummary.warm || 0),
      runtime_injections: Number(runtimeSummary.injections || 0),
      selected_memories: Number(runtimeSummary.selected || 0),
      hard_signal_ratio_pct: runtimeSummary.hard_signal_ratio_pct,
      soft_signal_ratio_pct: runtimeSummary.soft_signal_ratio_pct,
      stale_unscored: Number(runtimeSummary.stale_unscored || 0),
      recommendation_count: recommendations.length,
    },
    buckets: {
      weak_memory_candidates: { count: weakMemoryCandidates.length, sample: compactRows(weakMemoryCandidates) },
      useful_memory_candidates: { count: usefulMemoryCandidates.length, sample: compactRows(usefulMemoryCandidates) },
      stale_memory_candidates: { count: staleMemoryCandidates.length, sample: compactRows(staleMemoryCandidates) },
      repeated_failures: { count: repeatedFailures.length, sample: compactRows(repeatedFailures) },
      knowledge_gaps: { count: knowledgeGaps.length, sample: compactRows(knowledgeGaps) },
      query_gap_summary: queryGapSummary,
    },
    recommendations,
    warnings,
  };
}

function printHuman(payload) {
  if (payload.help) {
    console.log(payload.help);
    return;
  }
  const s = payload.summary || {};
  console.log(`BrainX Self-Learning Audit — ${payload.window_days}d`);
  console.log(`mode=${payload.mode} autonomy_score=${s.autonomy_score} recommendations=${s.recommendation_count}`);
  console.log(`memories active=${s.active_memories} hot=${s.hot} warm=${s.warm}`);
  console.log(`runtime injections=${s.runtime_injections} selected=${s.selected_memories} hard=${s.hard_signal_ratio_pct}% soft=${s.soft_signal_ratio_pct}% stale_unscored=${s.stale_unscored}`);
  if (payload.warnings?.length) {
    console.log('');
    console.log('Warnings:');
    for (const w of payload.warnings) console.log(`- ${w.label}: ${w.message}`);
  }
  console.log('');
  console.log('Recommendations:');
  if (!payload.recommendations.length) {
    console.log('- none');
    return;
  }
  for (const rec of payload.recommendations) {
    console.log(`- [${rec.severity}] ${rec.key}: ${rec.reason} evidence=${rec.evidence_count}`);
    console.log(`  command: ${rec.command}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cfg = parseArgs(args);
  const payload = await run(args);
  if (cfg.json) console.log(JSON.stringify(payload, null, 2));
  else printHuman(payload);
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err.stack || err.message || err);
      process.exit(1);
    })
    .finally(async () => {
      if (defaultDb?.pool?.end) {
        try { await defaultDb.pool.end(); } catch (_) {}
      }
    });
}

module.exports = {
  DEFAULTS,
  parseArgs,
  pct,
  compactPreview,
  buildRecommendations,
  autonomyScore,
  run,
};
