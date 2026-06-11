#!/usr/bin/env node
// Degrade memories that BrainX injected repeatedly without any agent referencing
// them back — "signal without uptake".
//
// Why this exists (non-obvious invariants):
// - BrainX tracks every injection in brainx_runtime_injections: which memories
//   were selected (memory_ids[]) and which the agent response actually picked
//   up (referenced_ids[]). This is ground truth for "did the injection help".
// - Memories that match many prompts but never get referenced are generic
//   enough to leak across queries without adding signal. Left untouched they
//   dominate recall and drown out specific memories.
// - We do not delete or mark obsolete — a generic memory may still be
//   correct, just too broad. We move it down one tier and tag it so future
//   runs can follow the trajectory. Reversible by design.
//
// Usage:
//   node scripts/degrade-over-injected.js                 # dry-run, default thresholds
//   node scripts/degrade-over-injected.js --apply         # write changes
//   node scripts/degrade-over-injected.js --window 14     # 14d window
//   node scripts/degrade-over-injected.js --min 10 --apply
//   node scripts/degrade-over-injected.js --json
//
// Emits on stdout:
//   - Human summary (unless --json)
//   - BRAINX_LOG: and BRAINX_CLOSEOUT_EVIDENCE: lines for the daily core
//     wrapper's harvester.

'use strict';

const { query } = require('../lib/db.js');

function parseArgs(argv) {
  const out = {
    apply: false,
    json: false,
    mode: 'over-injected',
    // over-injected window
    windowDays: 7,
    minInjections: 20,
    maxReferenced: 0,
    // never-injected window/age gates
    neverWindowDays: 60,
    neverMinAgeDays: 30,
    neverStaleDays: 30,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--json') out.json = true;
    else if (a === '--mode') out.mode = String(argv[++i] || '').toLowerCase();
    else if (a === '--window') out.windowDays = parseInt(argv[++i], 10);
    else if (a === '--min') out.minInjections = parseInt(argv[++i], 10);
    else if (a === '--max-ref') out.maxReferenced = parseInt(argv[++i], 10);
    else if (a === '--never-window') out.neverWindowDays = parseInt(argv[++i], 10);
    else if (a === '--never-min-age') out.neverMinAgeDays = parseInt(argv[++i], 10);
    else if (a === '--never-stale') out.neverStaleDays = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/degrade-over-injected.js [--apply] [--mode over-injected|never-injected|both] [--window N] [--min N] [--max-ref N] [--never-window N] [--never-min-age N] [--never-stale N] [--json]');
      process.exit(0);
    }
  }
  if (!Number.isFinite(out.windowDays) || out.windowDays <= 0) out.windowDays = 7;
  if (!Number.isFinite(out.minInjections) || out.minInjections <= 0) out.minInjections = 20;
  if (!Number.isFinite(out.maxReferenced) || out.maxReferenced < 0) out.maxReferenced = 0;
  if (!Number.isFinite(out.neverWindowDays) || out.neverWindowDays <= 0) out.neverWindowDays = 60;
  if (!Number.isFinite(out.neverMinAgeDays) || out.neverMinAgeDays <= 0) out.neverMinAgeDays = 30;
  if (!Number.isFinite(out.neverStaleDays) || out.neverStaleDays <= 0) out.neverStaleDays = 30;
  if (!['over-injected', 'never-injected', 'both'].includes(out.mode)) out.mode = 'over-injected';
  return out;
}

// Tier descent ladder. Stops at `archive` — never removes the row.
const TIER_STEP = { hot: 'warm', warm: 'cold', cold: 'archive', archive: 'archive' };

async function findCandidates(cfg) {
  const r = await query(
    `
    WITH per_mem AS (
      SELECT mid,
        COUNT(*)::int AS times_injected,
        SUM(CASE WHEN mid = ANY(ri.referenced_ids) THEN 1 ELSE 0 END)::int AS times_referenced,
        COUNT(DISTINCT ri.agent)::int AS distinct_agents,
        MAX(ri.injected_at) AS last_injected
      FROM brainx_runtime_injections ri,
           LATERAL unnest(ri.memory_ids) mid
      WHERE ri.injected_at > NOW() - ($1::int || ' days')::interval
      GROUP BY mid
    )
    SELECT p.mid AS id, p.times_injected, p.times_referenced, p.distinct_agents, p.last_injected,
           m.type, m.tier, m.importance, m.verification_state, m.tags,
           LEFT(m.content, 200) AS preview,
           'over-injected'::text AS reason
    FROM per_mem p
    JOIN brainx_memories m ON m.id = p.mid
    WHERE p.times_injected >= $2::int
      AND p.times_referenced <= $3::int
    ORDER BY p.times_injected DESC
    `,
    [cfg.windowDays, cfg.minInjections, cfg.maxReferenced],
  );
  return r.rows;
}

// Never-injected variant: hot/warm rows that have NOT been selected by recall
// in the last `neverWindowDays`, are old enough (`neverMinAgeDays`), and have
// not been touched in `neverStaleDays`. Mirrors doctor's stale check + adds
// the injection-history filter so over-injected and never-injected stay
// disjoint.
async function findNeverInjectedCandidates(cfg) {
  const r = await query(
    `
    WITH inj AS (
      SELECT DISTINCT mid FROM brainx_runtime_injections ri,
        LATERAL unnest(ri.memory_ids) mid
      WHERE ri.injected_at > NOW() - ($1::int || ' days')::interval
    )
    SELECT m.id, m.type, m.tier, m.importance, m.verification_state, m.tags,
           LEFT(m.content, 200) AS preview,
           0::int AS times_injected,
           0::int AS times_referenced,
           0::int AS distinct_agents,
           NULL::timestamptz AS last_injected,
           m.created_at,
           m.last_accessed,
           EXTRACT(EPOCH FROM (NOW() - m.created_at))::bigint / 86400 AS age_days,
           'never-injected'::text AS reason
    FROM brainx_memories m
    WHERE m.tier IN ('hot','warm')
      AND m.superseded_by IS NULL
      AND m.created_at < NOW() - ($2::int || ' days')::interval
      AND (m.last_accessed IS NULL OR m.last_accessed < NOW() - ($3::int || ' days')::interval)
      AND NOT EXISTS (SELECT 1 FROM inj WHERE inj.mid = m.id)
    ORDER BY m.created_at ASC
    `,
    [cfg.neverWindowDays, cfg.neverMinAgeDays, cfg.neverStaleDays],
  );
  return r.rows;
}

function nextTier(current) {
  const normalized = String(current || '').toLowerCase();
  return TIER_STEP[normalized] || null;
}

function buildNoiseTag(candidate, today) {
  if (candidate.reason === 'never-injected') {
    return `noise:never-injected:${today}:age${candidate.age_days || 0}d`;
  }
  return `noise:over-injected:${today}:w${candidate.times_injected}`;
}

async function applyDegrade(candidate, today) {
  const nextT = nextTier(candidate.tier);
  if (!nextT) return { skipped: 'no_next_tier' };
  const tag = buildNoiseTag(candidate, today);
  const existingTags = Array.isArray(candidate.tags) ? candidate.tags : [];
  const nextTags = existingTags.includes(tag) ? existingTags : [...existingTags, tag];
  await query(
    `UPDATE brainx_memories SET tier = $1, tags = $2 WHERE id = $3`,
    [nextT, nextTags, candidate.id],
  );
  return { fromTier: candidate.tier, toTier: nextT, addedTag: tag };
}

function summarizeCandidate(c, action) {
  return {
    id: c.id,
    type: c.type,
    importance: c.importance,
    verification_state: c.verification_state,
    distinct_agents: c.distinct_agents,
    times_injected: c.times_injected,
    times_referenced: c.times_referenced,
    preview: c.preview,
    action,
  };
}

async function runOne(cfg, finder, label, today) {
  const candidates = await finder(cfg);
  const applied = [];
  const skipped = [];
  if (cfg.apply) {
    for (const c of candidates) {
      try {
        const result = await applyDegrade(c, today);
        if (result.skipped) skipped.push(summarizeCandidate(c, result));
        else applied.push(summarizeCandidate(c, result));
      } catch (err) {
        skipped.push(summarizeCandidate(c, { error: String(err?.message || err) }));
      }
    }
  }
  return { label, candidates, applied, skipped };
}

async function main() {
  const cfg = parseArgs(process.argv);
  const today = new Date().toISOString().slice(0, 10);
  const runMode = cfg.apply ? 'apply' : 'dry-run';

  const passes = [];
  if (cfg.mode === 'over-injected' || cfg.mode === 'both') {
    passes.push(await runOne(cfg, findCandidates, 'over-injected', today));
  }
  if (cfg.mode === 'never-injected' || cfg.mode === 'both') {
    passes.push(await runOne(cfg, findNeverInjectedCandidates, 'never-injected', today));
  }

  const totals = passes.reduce(
    (acc, p) => ({
      candidates: acc.candidates + p.candidates.length,
      applied: acc.applied + p.applied.length,
      skipped: acc.skipped + p.skipped.length,
    }),
    { candidates: 0, applied: 0, skipped: 0 },
  );

  const report = {
    ok: true,
    mode: runMode,
    selection: cfg.mode,
    window_days: cfg.windowDays,
    min_injections: cfg.minInjections,
    max_referenced: cfg.maxReferenced,
    never_window_days: cfg.neverWindowDays,
    never_min_age_days: cfg.neverMinAgeDays,
    never_stale_days: cfg.neverStaleDays,
    today,
    candidates_found: totals.candidates,
    applied_count: totals.applied,
    skipped_count: totals.skipped,
    passes: passes.map((p) => ({
      label: p.label,
      candidates_found: p.candidates.length,
      applied_count: p.applied.length,
      skipped_count: p.skipped.length,
      candidates: cfg.apply ? null : p.candidates.map((c) => summarizeCandidate(c, null)),
      applied: p.applied,
      skipped: p.skipped,
    })),
  };

  if (cfg.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[degrade] mode=${runMode} selection=${cfg.mode} candidates=${totals.candidates} applied=${totals.applied} skipped=${totals.skipped}`);
    for (const p of passes) {
      console.log(`  pass=${p.label} candidates=${p.candidates.length} applied=${p.applied.length} skipped=${p.skipped.length}`);
      for (const c of p.candidates) {
        const note = cfg.apply
          ? (p.applied.find((x) => x.id === c.id)?.action
              ? `→ ${p.applied.find((x) => x.id === c.id).action.fromTier}→${p.applied.find((x) => x.id === c.id).action.toTier}`
              : 'SKIPPED')
          : 'DRY-RUN';
        console.log(`    ${c.id} inj=${c.times_injected} ref=${c.times_referenced} tier=${c.tier} imp=${c.importance} reason=${c.reason} ${note}`);
      }
    }
  }

  // Daily-core wrapper harvester lines
  for (const p of passes) {
    console.log(`BRAINX_LOG: degrade_${p.label.replace('-', '_')} mode=${runMode} candidates=${p.candidates.length} applied=${p.applied.length}`);
    console.log(`BRAINX_CLOSEOUT_EVIDENCE: degrade_${p.label.replace('-', '_')} candidates=${p.candidates.length} applied=${p.applied.length}`);
  }
  // Backwards-compat aggregate line (preserves old harvester signature)
  console.log(`BRAINX_LOG: degrade_over_injected mode=${runMode} candidates=${totals.candidates} applied=${totals.applied}`);
  console.log(`BRAINX_CLOSEOUT_EVIDENCE: degrade_over_injected candidates=${totals.candidates} applied=${totals.applied} window=${cfg.windowDays}d`);

  process.exit(0);
}

main().catch((err) => {
  console.error('[degrade-over-injected] error:', err?.message || err);
  console.log(`BRAINX_LOG: degrade_over_injected error=${String(err?.message || err).slice(0, 200)}`);
  process.exit(1);
});
