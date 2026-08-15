#!/usr/bin/env node
// Reconcile CONTRADICTIONS between memories — the missing "veracity" axis.
//
// Why this exists (non-obvious invariants):
// - Every existing hygiene loop measures UPTAKE, not TRUTH:
//     * degrade-over-injected demotes memories injected-but-never-referenced
//       (generic noise). A confidently-WRONG fact that agents DO reference and
//       act on is `times_referenced > 0` -> exempt. The very fact that the fleet
//       believed it protected it.
//     * the never-injected sweep explicitly EXEMPTS verification_state='verified'.
//     * auto-dedup only merges near-IDENTICAL pairs; two facts that state a
//       DIFFERENT value for the same entity ("prod = A" vs "prod = B") are not
//       duplicates, so dedup never touches them.
//   Result: a `verified` + `hot` fact that silently became false when the world
//   changed keeps a near-perfect recall score forever, and — because recency is
//   measured from last_accessed — every injection refreshes it (self-reinforcing).
//   Real incident 2026-07-18: m_1783360681424 ("HorizonX prod = Hostinger box
//   srv1318115"), created 2026-07-06, tier hot, importance 9, tool_verified,
//   accessed 116x, last_accessed the day it was finally caught — 8 days AFTER
//   prod migrated to a DO droplet. It nearly caused a deploy to the wrong host.
//
// What this does (the new axis):
// - For each recent challenger fact B (created within --newer-window-days), find
//   its nearest OLDER, still-live (`superseded_by IS NULL`), `verified`, hot/warm
//   neighbors A by vector similarity. High similarity => same subject.
// - An LLM judge decides whether B factually SUPERSEDES/contradicts A on a
//   concrete verifiable attribute (host/IP/port/endpoint/ownership/config/status/
//   location) — not stylistic overlap.
// - On a high-confidence "supersedes":
//     * if B's provenance >= A's -> SUPERSEDE A: verification_state='obsolete',
//       superseded_by=B, tier='archive' (reversible; mirrors `brainx feedback
//       --incorrect --supersededBy`).
//     * if B's provenance <  A's -> DEMOTE-AND-FLAG A: verification_state
//       'verified'->'hypothesis', tier one step down, tagged conflict-flagged.
//       A stays live but LOSES its unbeatable `verified` score so the newer
//       (weaker-provenance) truth can compete, and the pair surfaces for review.
// - Never deletes. Never touches B. Dry-run by default. Exit 0 on partial (a
//   per-pair LLM failure skips that pair — it must not flap daily-core to error).
//
// Usage:
//   node scripts/reconcile-contradictions.js                # dry-run
//   node scripts/reconcile-contradictions.js --apply
//   node scripts/reconcile-contradictions.js --apply --json
//   node scripts/reconcile-contradictions.js --min-sim 0.84 --max-pairs 40
//
// Emits BRAINX_LOG: / BRAINX_CLOSEOUT_EVIDENCE: lines for the daily-core wrapper.

'use strict';

const { query } = require('../lib/db.js');
const recallCalibration = require('../lib/recall-calibration.js');

let agentLLM = null;
function loadAgentLLM() {
  if (agentLLM === null) agentLLM = require('../lib/agent-llm.js');
  return agentLLM;
}

// Provenance ranking — SAME order as the recall scorer's source_kind CASE
// (openai-rag.js weightedScoreSql). Higher = more authoritative. Used to decide
// whether a challenger is strong enough to hard-supersede, or only flag.
const PROVENANCE_RANK = {
  knowledge_canonical: 8,
  tool_verified: 7,
  user_explicit: 6,
  consolidated: 5,
  summary_derived: 4,
  llm_distilled: 4,
  knowledge_staging: 3,
  knowledge_generated: 2,
  agent_inference: 1,
  markdown_import: 1,
};
function provenanceRank(sourceKind) {
  const key = String(sourceKind || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(PROVENANCE_RANK, key) ? PROVENANCE_RANK[key] : 2;
}

// Tier descent ladder (mirrors degrade-over-injected). Stops at archive.
const TIER_STEP = { hot: 'warm', warm: 'cold', cold: 'archive', archive: 'archive' };
function nextTier(current) {
  return TIER_STEP[String(current || '').toLowerCase()] || 'warm';
}

// "Judged once" marker. Ordering candidates by similarity DESC means benign
// high-similarity duplicates would otherwise eat the per-run LLM budget every
// day and STARVE the real (mid-similarity, divergent) contradictions further
// down the list. After judging a pair (any verdict) we tag the incumbent with
// this marker for that challenger, and future runs skip the already-judged pair
// so the budget flows to unjudged ones. Bounded: DISTINCT ON gives one B per A,
// so an A accrues at most one marker per distinct nearest challenger it ever had.
function checkedTag(bId) {
  return `rcx:${String(bId || '').slice(-8)}`;
}
function pairAlreadyJudged(pair) {
  const tags = Array.isArray(pair.a_tags) ? pair.a_tags : [];
  const marker = checkedTag(pair.b_id);
  return tags.some((t) => String(t) === marker || String(t).startsWith(`${marker}:`));
}

function parseArgs(argv) {
  const out = {
    apply: false,
    json: false,
    allowSupersede: false, // OFF by default: autonomous runs FLAG only (reversible).
                           // --allow-supersede enables destructive hard-obsolete for
                           // operator-reviewed runs on the clear high-confidence cases.
    newerWindowDays: 30,   // challenger B must have ARRIVED within this window
    minAgeGapDays: 2,      // B must be meaningfully newer than A
    minSim: 0.62,          // cosine floor for "same subject" — calibrated to the
                           // live embedding distribution (2026-07-18: over the 337
                           // verified hot/warm incumbents, nearest-newer-challenger
                           // sim is avg 0.66 / max 0.97). A CLEAR contradiction can
                           // sit at ~0.70 (validated: a port 7001→9090 supersession
                           // measured 0.699), so keep the floor generous and let the
                           // LLM judge be the precision gate; judged-once bounds cost.
    neighbors: 8,          // nearest challengers pulled per incumbent (pure HNSW),
                           // then post-filtered by the age gap → best kept per incumbent
    maxChallengers: 80,    // (retained for CLI compat; unused in incumbent-driven scan)
    maxPairs: 40,          // cap LLM judgments per run (budget guard)
    minConfidence: 0.75,   // LLM confidence floor to act
    llmTimeoutMs: 60000,
    maxRuntimeSeconds: 180, // stop starting new LLM calls past this
    model: process.env.BRAINX_RECONCILE_MODEL || '',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--json') out.json = true;
    else if (a === '--allow-supersede') out.allowSupersede = true;
    else if (a === '--newer-window') out.newerWindowDays = parseInt(argv[++i], 10);
    else if (a === '--min-age-gap') out.minAgeGapDays = parseInt(argv[++i], 10);
    else if (a === '--min-sim') out.minSim = Number(argv[++i]);
    else if (a === '--neighbors') out.neighbors = parseInt(argv[++i], 10);
    else if (a === '--max-challengers') out.maxChallengers = parseInt(argv[++i], 10);
    else if (a === '--max-pairs') out.maxPairs = parseInt(argv[++i], 10);
    else if (a === '--min-confidence') out.minConfidence = Number(argv[++i]);
    else if (a === '--llm-timeout-ms') out.llmTimeoutMs = parseInt(argv[++i], 10);
    else if (a === '--max-runtime-seconds') out.maxRuntimeSeconds = parseInt(argv[++i], 10);
    else if (a === '--model') out.model = String(argv[++i] || '');
    else if (a === '--help' || a === '-h') { out.help = true; }
  }
  // Clamp to safe ranges (never throw on bad input; fall back to defaults).
  if (!Number.isFinite(out.newerWindowDays) || out.newerWindowDays <= 0) out.newerWindowDays = 30;
  if (!Number.isFinite(out.minAgeGapDays) || out.minAgeGapDays < 0) out.minAgeGapDays = 2;
  if (!Number.isFinite(out.minSim) || out.minSim <= 0 || out.minSim >= 1) out.minSim = 0.82;
  if (!Number.isFinite(out.neighbors) || out.neighbors <= 0) out.neighbors = 4;
  if (!Number.isFinite(out.maxChallengers) || out.maxChallengers <= 0) out.maxChallengers = 80;
  if (!Number.isFinite(out.maxPairs) || out.maxPairs <= 0) out.maxPairs = 24;
  if (!Number.isFinite(out.minConfidence) || out.minConfidence <= 0 || out.minConfidence > 1) out.minConfidence = 0.75;
  if (!Number.isFinite(out.maxRuntimeSeconds) || out.maxRuntimeSeconds <= 0) out.maxRuntimeSeconds = 180;
  return out;
}

// Decide the reversible action for a confirmed supersession. GRADUATED caution
// (pure — unit tested) so autonomous operation can never destroy curated
// knowledge or hard-obsolete on medium confidence:
//   * incumbent is knowledge_canonical  -> REVIEW-ONLY: never auto-degrade
//     human-curated knowledge; just tag the conflict for a human to resolve.
//   * challenger provenance >= incumbent AND confidence >= 0.9 (both non-canonical)
//     -> hard SUPERSEDE: obsolete + superseded_by + archive.
//   * everything else -> demote-and-FLAG: strip the 'verified' bonus (so the newer
//     truth can compete) and tier down, but keep the row live for review.
// Rationale: flagging alone defuses the danger (the stale fact stops OUTRANKING
// the truth) while being fully reversible; obsolete is reserved for the clear,
// high-confidence, adequately-sourced case.
function decideAction(pair, verdict = {}, allowSupersede = false) {
  const aCanonical = String(pair.a_src || '').toLowerCase() === 'knowledge_canonical';
  if (aCanonical) {
    return { kind: 'review', set: {}, tagPrefix: 'conflict-review' };
  }
  // Hard-obsolete (destroys the row from recall) is DESTRUCTIVE and, at the judge's
  // measured precision, over-fires on same-incident duplicates / same-class-different-
  // instance pairs (validated 2026-07-18). So the autonomous default is FLAG-ONLY:
  // strip the 'verified' bonus so the newer truth can compete — reversible, and it
  // fully defuses the danger (the stale fact stops OUTRANKING the truth). Hard
  // supersede is opt-in (--allow-supersede) for an operator reviewing the clear cases.
  const bRank = provenanceRank(pair.b_src);
  const aRank = provenanceRank(pair.a_src);
  const highConf = Number(verdict.confidence) >= 0.9;
  if (allowSupersede && bRank >= aRank && highConf) {
    return {
      kind: 'supersede',
      set: { verification_state: 'obsolete', superseded_by: pair.b_id, tier: 'archive' },
      tagPrefix: 'conflict-superseded',
    };
  }
  return {
    kind: 'flag',
    // Only strip the 'verified' bonus; never raise/keep it. Tier one step down.
    set: { verification_state: 'hypothesis', tier: nextTier(pair.a_tier) },
    tagPrefix: 'conflict-flagged',
  };
}

function buildJudgePrompt(pair) {
  const system = [
    'You are a memory-reconciliation judge for an agent knowledge base.',
    'You are given an OLDER entry and a NEWER entry that a vector search flagged as similar.',
    'Answer "supersedes" ONLY when ALL of these hold: (1) both describe the SAME concrete subject,',
    'and (2) the NEWER entry states a DIFFERENT, CONFLICTING value for a verifiable attribute —',
    'host, IP, port, URL/endpoint, ownership, path, config value, version, status, or location —',
    'such that believing the OLDER entry today would be WRONG (the newer CORRECTS/replaces it).',
    'If the newer entry merely restates, expands, re-documents, or adds detail to the same facts',
    'WITHOUT contradicting a value, answer "duplicate". If it is about a related-but-different',
    'subject, answer "unrelated". If they can both be true at once, answer "coexist".',
    'When unsure, do NOT answer "supersedes". Respond with STRICT JSON only, no prose, no thinking:',
    '{"relation":"supersedes|coexist|unrelated|duplicate","attribute":"<short>","confidence":0.0-1.0,"reason":"<short>"}',
  ].join(' ');
  const clip = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 1200);
  const user = [
    `OLDER [${pair.a_id}] (created ${pair.a_created}):`,
    clip(pair.a_content),
    '',
    `NEWER [${pair.b_id}] (created ${pair.b_created}):`,
    clip(pair.b_content),
  ].join('\n');
  return { system, user };
}

// Robustly pull the verdict object out of a reply that may be prefixed with
// inline "thinking" tokens (some rotation models, e.g. MiniMax, emit them even
// with thinking:off) or prose. Prefer the LAST balanced {...} that mentions
// "relation" — that is the model's final answer, after any reasoning.
function extractVerdictObject(text, extractJson) {
  const s = String(text || '');
  const objs = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}') { depth--; if (depth === 0) { objs.push(s.slice(i, j + 1)); i = j; break; } }
    }
  }
  for (let k = objs.length - 1; k >= 0; k--) {
    if (!/relation/i.test(objs[k])) continue;
    try { return JSON.parse(objs[k]); } catch { /* keep scanning */ }
  }
  return extractJson(text); // last resort (throws if truly no JSON)
}

// Parse + validate the judge reply into a normalized verdict. Pure — unit tested.
function parseJudgeVerdict(text, extractJson) {
  let obj;
  try {
    obj = extractVerdictObject(text, extractJson);
  } catch {
    return { relation: 'coexist', confidence: 0, attribute: '', reason: 'unparseable', parseError: true };
  }
  let relation = ['supersedes', 'coexist', 'unrelated', 'duplicate'].includes(String(obj?.relation || '').toLowerCase())
    ? String(obj.relation).toLowerCase() : 'coexist';
  const confidence = Number(obj?.confidence);
  const reason = String(obj?.reason || '').slice(0, 200);
  // Self-consistency guard: weak/rotating judge models sometimes output
  // "supersedes" while their OWN reason states the entries are DISTINCT or can
  // both be true (observed 2026-07-18: gemini-flash-lite said supersedes@1.0 with
  // reason "describes a DIFFERENT issue"). When the reason betrays non-contradiction,
  // downgrade to coexist so a self-contradictory verdict never triggers an action.
  if (relation === 'supersedes' && /\b(different|distinct|separate|unrelated|another|both (can )?(be|are|remain) true|do(es)? not contradict|not a contradiction|coexist|complement)\b/i.test(reason)) {
    relation = 'coexist';
  }
  return {
    relation,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    attribute: String(obj?.attribute || '').slice(0, 80),
    reason,
  };
}

function shouldAct(verdict, cfg) {
  return verdict.relation === 'supersedes' && verdict.confidence >= cfg.minConfidence;
}

async function findCandidatePairs(cfg) {
  // Incumbent-driven scan: iterate the SMALL, high-value risk set — the verified
  // hot/warm facts that dominate recall (live count ~337) — and for each find its
  // single nearest NEWER challenger that arrived within the window. This is both
  // cheaper (bounded by the incumbent count, not the ~25k challenger pool) and
  // complete over the set that actually causes wrong-answer incidents.
  const embCol = recallCalibration.activeColumn();
  // Pass the window cutoff as a CONSTANT timestamp (planner can estimate its
  // selectivity) instead of a parameterized string-concat interval (opaque →
  // seq-scan per incumbent → minutes). The correlated gap uses make_interval.
  const windowCutoffIso = new Date(Date.now() - cfg.newerWindowDays * 86400000).toISOString();
  // Keep the LATERAL a PURE vector-NN (constant window cutoff only) so HNSW stays
  // fast (~3s over 337 incumbents); apply the CORRELATED age-gap as an outer
  // post-filter, then DISTINCT ON keeps each incumbent's single best challenger.
  const r = await query(
    `
    WITH incumbents AS (
      SELECT id, content, created_at, source_kind, type, tier, verification_state,
             importance, access_count, tags, ${embCol} AS emb
      FROM brainx_memories
      WHERE verification_state = 'verified'
        AND tier IN ('hot','warm')
        AND superseded_by IS NULL
        AND ${embCol} IS NOT NULL
        AND char_length(content) BETWEEN 20 AND 4000
    ),
    pairs AS (
      SELECT b.id AS b_id, LEFT(b.content, 1400) AS b_content, b.created_at AS b_created,
             b.source_kind AS b_src, b.type AS b_type,
             a.id AS a_id, LEFT(a.content, 1400) AS a_content, a.created_at AS a_created,
             a.source_kind AS a_src, a.type AS a_type, a.tier AS a_tier,
             a.verification_state AS a_vstate, a.importance AS a_importance,
             a.access_count AS a_access, a.tags AS a_tags,
             1 - (b.emb <=> a.emb) AS similarity
      FROM incumbents a
      CROSS JOIN LATERAL (
        SELECT id, content, created_at, source_kind, type, ${embCol} AS emb
        FROM brainx_memories b
        WHERE b.id <> a.id
          AND b.superseded_by IS NULL
          AND b.type IN ('fact','decision','gotcha')
          AND b.${embCol} IS NOT NULL
          AND b.created_at > $2::timestamptz
        ORDER BY b.${embCol} <=> a.emb
        LIMIT $3::int
      ) b
      WHERE b.created_at > a.created_at + make_interval(days => $1::int)
        AND 1 - (b.emb <=> a.emb) >= $4::float
    ),
    best AS (
      SELECT DISTINCT ON (a_id) *
      FROM pairs
      ORDER BY a_id, similarity DESC
    )
    SELECT * FROM best
    ORDER BY similarity DESC
    LIMIT $5::int
    `,
    [cfg.minAgeGapDays, windowCutoffIso, cfg.neighbors, cfg.minSim, cfg.maxPairs],
  );
  // De-dupe by (a_id) — a given incumbent should only be reconciled once per run,
  // by its single best (highest-similarity) challenger.
  const seenA = new Set();
  const pairs = [];
  for (const row of r.rows) {
    if (seenA.has(row.a_id)) continue;
    seenA.add(row.a_id);
    pairs.push(row);
  }
  return pairs;
}

async function applyAction(pair, action, today) {
  // Re-check A is still live at apply time (a concurrent run may have moved it).
  const live = await query(
    `SELECT tier, tags, verification_state FROM brainx_memories WHERE id = $1 AND superseded_by IS NULL`,
    [pair.a_id],
  );
  if (!live.rows.length) return { skipped: 'already_superseded' };
  const current = live.rows[0];
  const tag = `${action.tagPrefix}:${today}:by=${pair.b_id}`;
  const existingTags = Array.isArray(current.tags) ? current.tags : [];
  // Always add the conflict tag AND the "judged once" marker.
  const nextTags = [...new Set([...existingTags, tag, checkedTag(pair.b_id)])];

  if (action.kind === 'review') {
    // Curated knowledge: tag the conflict for human review; never change state/tier.
    await query(`UPDATE brainx_memories SET tags = $2 WHERE id = $1 AND superseded_by IS NULL`,
      [pair.a_id, nextTags]);
    return { kind: 'review', fromTier: current.tier, toTier: current.tier };
  }
  if (action.kind === 'supersede') {
    await query(
      `UPDATE brainx_memories
         SET verification_state = 'obsolete',
             superseded_by = $2,
             tier = 'archive',
             tags = $3
       WHERE id = $1 AND superseded_by IS NULL`,
      [pair.a_id, pair.b_id, nextTags],
    );
    return { kind: 'supersede', fromTier: current.tier, toTier: 'archive' };
  }
  // flag: only strip a still-'verified' state; leave already-weaker states as-is.
  const nextState = current.verification_state === 'verified' ? 'hypothesis' : current.verification_state;
  await query(
    `UPDATE brainx_memories
       SET verification_state = $2,
           tier = $3,
           tags = $4
     WHERE id = $1 AND superseded_by IS NULL`,
    [pair.a_id, nextState, action.set.tier, nextTags],
  );
  return { kind: 'flag', fromTier: current.tier, toTier: action.set.tier, fromState: current.verification_state, toState: nextState };
}

// A pair judged benign (coexist/duplicate/unrelated) still gets the "judged once"
// marker so it is not re-judged next run — the ONLY mutation here is the marker
// tag; verification_state/tier/content are untouched.
async function recordBenignChecked(pair) {
  const marker = checkedTag(pair.b_id);
  await query(
    `UPDATE brainx_memories
       SET tags = (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags, '{}') || $2::text[])))
     WHERE id = $1 AND superseded_by IS NULL AND NOT (COALESCE(tags,'{}') @> $2::text[])`,
    [pair.a_id, [marker]],
  );
}

async function main() {
  const cfg = parseArgs(process.argv);
  if (cfg.help) {
    console.log('Usage: node scripts/reconcile-contradictions.js [--apply] [--allow-supersede] [--json] [--min-sim 0.62] [--max-pairs 40] [--neighbors 8] [--newer-window 30] [--min-confidence 0.75] [--max-runtime-seconds 180] [--model <id>]');
    console.log('  Default action is FLAG-ONLY (reversible: verified->hypothesis). --allow-supersede enables destructive hard-obsolete for operator-reviewed runs.');
    process.exit(0);
  }
  const today = new Date().toISOString().slice(0, 10);
  const startedAt = Date.now();
  const runMode = cfg.apply ? 'apply' : 'dry-run';

  let pairs = [];
  try {
    pairs = await findCandidatePairs(cfg);
  } catch (err) {
    // Setup/DB failure is the only hard error (exit 1) — mirrors sibling scripts.
    console.error('[reconcile-contradictions] candidate query failed:', err?.message || err);
    console.log(`BRAINX_LOG: reconcile_contradictions error=${String(err?.message || err).slice(0, 200)}`);
    console.log(`BRAINX_CLOSEOUT_EVIDENCE: reconcile_contradictions status=error candidates=0 applied=0`);
    process.exit(1);
  }

  const { callAgentLLM, extractJson } = loadAgentLLM();
  const judged = [];
  const acted = [];
  const skipped = [];
  let llmFailures = 0;
  let llmCalls = 0;
  let alreadyJudged = 0;

  for (const pair of pairs) {
    // Skip pairs already judged in a prior run so the LLM budget flows to fresh
    // ones (prevents benign high-sim duplicates starving real contradictions).
    if (pairAlreadyJudged(pair)) {
      alreadyJudged++;
      continue;
    }
    if ((Date.now() - startedAt) / 1000 > cfg.maxRuntimeSeconds) {
      skipped.push({ a_id: pair.a_id, b_id: pair.b_id, reason: 'runtime_budget' });
      continue;
    }
    const { system, user } = buildJudgePrompt(pair);
    let verdict;
    try {
      llmCalls++;
      const res = await callAgentLLM({
        system,
        user,
        label: 'reconcile-contradictions',
        timeoutMs: cfg.llmTimeoutMs,
        model: cfg.model || undefined,
        thinking: 'off',
      });
      verdict = parseJudgeVerdict(res.text, extractJson);
    } catch (err) {
      llmFailures++;
      skipped.push({ a_id: pair.a_id, b_id: pair.b_id, reason: `llm_error:${String(err?.message || err).slice(0, 80)}` });
      continue;
    }
    // A parse failure is TRANSIENT (a model emitted unparseable output) — do NOT
    // mark the pair judged; let a future run retry it rather than silently drop it.
    if (verdict.parseError) {
      llmFailures++;
      skipped.push({ a_id: pair.a_id, b_id: pair.b_id, reason: 'verdict_unparseable' });
      continue;
    }

    const record = {
      a_id: pair.a_id, b_id: pair.b_id,
      similarity: Number(pair.similarity)?.toFixed?.(3),
      a_src: pair.a_src, b_src: pair.b_src,
      a_tier: pair.a_tier, a_importance: pair.a_importance, a_access: pair.a_access,
      relation: verdict.relation, confidence: verdict.confidence, attribute: verdict.attribute,
      reason: verdict.reason,
      a_preview: String(pair.a_content).replace(/\s+/g, ' ').slice(0, 120),
      b_preview: String(pair.b_content).replace(/\s+/g, ' ').slice(0, 120),
    };
    judged.push(record);

    if (!shouldAct(verdict, cfg)) {
      // Benign verdict — mark judged so we don't re-spend budget on it next run.
      if (cfg.apply) { try { await recordBenignChecked(pair); } catch { /* best-effort */ } }
      continue;
    }
    const action = decideAction(pair, verdict, cfg.allowSupersede);
    record.action = action.kind;
    if (cfg.apply) {
      try {
        const result = await applyAction(pair, action, today);
        if (result.skipped) { record.applied = false; record.skipReason = result.skipped; skipped.push({ ...record }); }
        else { record.applied = true; record.result = result; acted.push(record); }
      } catch (err) {
        record.applied = false; record.error = String(err?.message || err).slice(0, 160);
        skipped.push({ ...record });
      }
    } else {
      acted.push(record); // dry-run: "would act"
    }
  }

  const report = {
    ok: true,
    mode: runMode,
    today,
    thresholds: { min_sim: cfg.minSim, min_confidence: cfg.minConfidence, neighbors: cfg.neighbors, newer_window_days: cfg.newerWindowDays, min_age_gap_days: cfg.minAgeGapDays, max_pairs: cfg.maxPairs, allow_supersede: cfg.allowSupersede },
    candidate_pairs: pairs.length,
    already_judged: alreadyJudged,
    judged: judged.length,
    llm_calls: llmCalls,
    llm_failures: llmFailures,
    acted_count: acted.length,
    skipped_count: skipped.length,
    acted,
    judged_detail: cfg.json ? judged : undefined,
    skipped: cfg.json ? skipped : undefined,
  };

  if (cfg.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[reconcile] mode=${runMode} pairs=${pairs.length} already_judged=${alreadyJudged} judged=${judged.length} acted=${acted.length} skipped=${skipped.length} llm_fail=${llmFailures}`);
    for (const r of acted) {
      const verb = cfg.apply ? (r.applied ? `APPLIED(${r.action})` : `SKIP(${r.skipReason || r.error || '?'})`) : `WOULD(${r.action})`;
      console.log(`  ${verb} sim=${r.similarity} conf=${r.confidence} attr="${r.attribute}"`);
      console.log(`    A[${r.a_id}] ${r.a_src}/${r.a_tier} :: ${r.a_preview}`);
      console.log(`    B[${r.b_id}] ${r.b_src} :: ${r.b_preview}`);
    }
  }

  // Daily-core wrapper harvester lines.
  console.log(`BRAINX_LOG: reconcile_contradictions mode=${runMode} pairs=${pairs.length} already_judged=${alreadyJudged} judged=${judged.length} acted=${acted.length} llm_fail=${llmFailures}`);
  console.log(`BRAINX_CLOSEOUT_EVIDENCE: reconcile_contradictions status=ok pairs=${pairs.length} acted=${acted.length} skipped=${skipped.length} mode=${runMode}`);
  process.exit(0);
}

// Export pure helpers for unit tests; only run main() when invoked directly.
module.exports = {
  provenanceRank, nextTier, parseArgs, decideAction,
  buildJudgePrompt, parseJudgeVerdict, extractVerdictObject, shouldAct, PROVENANCE_RANK, TIER_STEP,
  checkedTag, pairAlreadyJudged,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('[reconcile-contradictions] fatal:', err?.message || err);
    console.log(`BRAINX_LOG: reconcile_contradictions error=${String(err?.message || err).slice(0, 200)}`);
    process.exit(1);
  });
}
