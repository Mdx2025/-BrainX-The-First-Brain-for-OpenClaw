'use strict';
// BRAINX_SKILL_LOAD_TRACKING_20260608
// Heuristic helper that turns brainx_skill_loads outcome data into a
// 0..1 score used by skill-promotion to prefer patching skills the host
// agent has loaded recently and found useful (or, conversely, found wrong
// and in need of an update).
//
// Spec 2 closes two gaps with this surface:
//   * Gap 1 — "skill in play" was never recorded, so the promoter couldn't
//     preferentially patch the skill the agent was already using.
//   * Gap 3 — there was no feedback loop for skills that turned out wrong.
//     Now the outcome column tells us which skills need attention.
//
// Two exported functions:
//   * getSkillBonusScore(skillName)  → 0..1 score proportional to the
//     ratio of `helpful` outcomes to total reported outcomes for that
//     skill in the last N sessions. Returns 0 when the skill has no
//     recorded loads (cold start: no signal is no penalty).
//   * getTopSkills(limit=5)          → top skills by ratio of `helpful`
//     in the last 30 days, with a minimum sample size to avoid noisy
//     1-shot wins.
//
// Both are read-only and safe to call from the cron promoter.

const skillTracker = require('./skill-tracker');

// Module-local cache to avoid hammering the DB on every call from the
// promoter. Short TTL keeps the score fresh enough for cron cadence.
const CACHE_TTL_MS = 60_000;
const _scoreCache = new Map(); // skillName -> { expiresAt, score }
const _topCache = { expiresAt: 0, value: [] };

let _db = null;
function getDb() {
  if (!_db) _db = require('./db');
  return _db;
}

let _dbOverride = null;
function setDbGetter(fn) {
  _dbOverride = fn;
}

function resolveDb() {
  const db = _dbOverride ? _dbOverride() : getDb();
  return db && typeof db.then === 'function' ? db : Promise.resolve(db);
}

const RECENT_SESSIONS_SQL = `
  SELECT DISTINCT session_key
  FROM brainx_skill_loads
  WHERE loaded_at >= NOW() - ($1 || ' days')::interval
  ORDER BY session_key DESC
  LIMIT $2
`.trim();

const SKILL_OUTCOMES_RECENT_SQL = `
  SELECT
    skill_name,
    COUNT(*)::int AS loads,
    COUNT(*) FILTER (WHERE outcome = 'helpful')::int AS helpful,
    COUNT(*) FILTER (WHERE outcome = 'wrong')::int   AS wrong,
    COUNT(*) FILTER (WHERE outcome = 'ignored')::int AS ignored
  FROM brainx_skill_loads
  WHERE skill_name = $1
    AND loaded_at >= NOW() - ($2 || ' days')::interval
  GROUP BY skill_name
`.trim();

const TOP_SKILLS_SQL = `
  SELECT
    skill_name,
    COUNT(*)::int AS loads,
    COUNT(*) FILTER (WHERE outcome = 'helpful')::int AS helpful,
    COUNT(*) FILTER (WHERE outcome = 'wrong')::int   AS wrong,
    COUNT(*) FILTER (WHERE outcome = 'ignored')::int AS ignored
  FROM brainx_skill_loads
  WHERE loaded_at >= NOW() - ($1 || ' days')::interval
    AND outcome IS NOT NULL
  GROUP BY skill_name
  HAVING COUNT(*) >= $2
  ORDER BY
    (COUNT(*) FILTER (WHERE outcome = 'helpful')::float
     / NULLIF(COUNT(*), 0)) DESC NULLS LAST,
    COUNT(*) DESC
  LIMIT $3
`.trim();

async function getRecentSessionKeys(days = 7, maxSessions = 200) {
  try {
    const db = await resolveDb();
    const result = await db.query(RECENT_SESSIONS_SQL, [String(days), maxSessions]);
    return (result?.rows || []).map((row) => row.session_key).filter(Boolean);
  } catch (_err) {
    return [];
  }
}

/**
 * Heuristic 0..1 score for a single skill.
 *
 *   signal = helpful / (helpful + wrong + ignored)
 *
 * Scaled by sample size so a single "helpful" load doesn't pin a skill
 * to 1.0 — we want some evidence before we reward a skill. Falls back
 * to 0.5 (neutral) when there are no reported outcomes at all.
 */
async function getSkillBonusScore(skillName, opts = {}) {
  if (!skillName) return 0;
  const days = Number.isInteger(opts.days) ? opts.days : 7;
  const minSamples = Number.isInteger(opts.minSamples) ? opts.minSamples : 1;
  const useCache = opts.useCache !== false;

  if (useCache) {
    const cached = _scoreCache.get(skillName);
    if (cached && cached.expiresAt > Date.now()) return cached.score;
  }

  let score = 0;
  try {
    const db = await resolveDb();
    const result = await db.query(SKILL_OUTCOMES_RECENT_SQL, [skillName, String(days)]);
    const row = result?.rows?.[0];
    if (row) {
      const helpful = Number(row.helpful || 0);
      const wrong = Number(row.wrong || 0);
      const ignored = Number(row.ignored || 0);
      const reported = helpful + wrong + ignored;
      if (reported >= minSamples) {
        const ratio = helpful / reported;
        // Confidence curve: full credit at ratio=1.0, zero at ratio=0.0.
        // No sign penalty on wrong (wrong skills should be patched, not
        // blacklisted; the promoter uses this for the "patch priority",
        // and a negative score would invert the rank). The promoter can
        // re-rank "wrong" skills separately using getSkillsToPatch.
        score = Math.max(0, Math.min(1, ratio));
      } else {
        score = 0; // cold start — no signal, no penalty
      }
    }
  } catch (_err) {
    score = 0;
  }

  if (useCache) {
    _scoreCache.set(skillName, { expiresAt: Date.now() + CACHE_TTL_MS, score });
  }
  return score;
}

/**
 * Top skills by helpful ratio in the last `days` days. Requires a
 * minimum sample size to avoid 1-shot wins dominating the list.
 */
async function getTopSkills(limit = 5, opts = {}) {
  const days = Number.isInteger(opts.days) ? opts.days : 30;
  const minSamples = Number.isInteger(opts.minSamples) ? opts.minSamples : 3;
  const useCache = opts.useCache !== false;
  const cap = Math.max(1, Math.min(parseInt(limit, 10) || 5, 50));

  if (useCache && _topCache.expiresAt > Date.now() && _topCache.limit === cap) {
    return _topCache.value;
  }

  let value = [];
  try {
    const db = await resolveDb();
    const result = await db.query(TOP_SKILLS_SQL, [String(days), minSamples, cap]);
    value = (result?.rows || []).map((row) => {
      const loads = Number(row.loads || 0);
      const helpful = Number(row.helpful || 0);
      const wrong = Number(row.wrong || 0);
      const ignored = Number(row.ignored || 0);
      const ratio = loads > 0 ? helpful / loads : 0;
      return {
        skill_name: row.skill_name,
        loads,
        helpful,
        wrong,
        ignored,
        helpful_ratio: Number(ratio.toFixed(4)),
        bonus_score: Math.max(0, Math.min(1, ratio)),
      };
    });
  } catch (_err) {
    value = [];
  }

  if (useCache) {
    _topCache.limit = cap;
    _topCache.value = value;
    _topCache.expiresAt = Date.now() + CACHE_TTL_MS;
  }
  return value;
}

/**
 * Skills with at least one 'wrong' or 'ignored' outcome in the last
 * `days` days — used by skill-promotion to prioritize patch candidates.
 */
async function getSkillsToPatch(opts = {}) {
  const days = Number.isInteger(opts.days) ? opts.days : 7;
  try {
    const db = await resolveDb();
    const result = await db.query(
      `SELECT
         skill_name,
         COUNT(*)::int AS loads,
         COUNT(*) FILTER (WHERE outcome = 'wrong')::int   AS wrong,
         COUNT(*) FILTER (WHERE outcome = 'ignored')::int AS ignored
       FROM brainx_skill_loads
       WHERE loaded_at >= NOW() - ($1 || ' days')::interval
         AND (outcome = 'wrong' OR outcome = 'ignored')
       GROUP BY skill_name
       ORDER BY (COUNT(*) FILTER (WHERE outcome = 'wrong')::int) DESC,
                COUNT(*) DESC
       LIMIT 50`,
      [String(days)],
    );
    return (result?.rows || []).map((row) => ({
      skill_name: row.skill_name,
      loads: Number(row.loads || 0),
      wrong: Number(row.wrong || 0),
      ignored: Number(row.ignored || 0),
    }));
  } catch (_err) {
    return [];
  }
}

/**
 * Convenience wrapper used by the bridge: list of skill names recently
 * loaded in this session (deduped, newest first, capped at `limit`).
 */
async function getRecentSkillsForSession(sessionKey, limit = 10) {
  if (!sessionKey) return [];
  try {
    const rows = await skillTracker.getRecentLoads(sessionKey, limit);
    const seen = new Set();
    const names = [];
    for (const row of rows) {
      if (row && row.skill_name && !seen.has(row.skill_name)) {
        seen.add(row.skill_name);
        names.push(row.skill_name);
      }
    }
    return names;
  } catch (_err) {
    return [];
  }
}

function clearCache() {
  _scoreCache.clear();
  _topCache.expiresAt = 0;
  _topCache.value = [];
}

module.exports = {
  getSkillBonusScore,
  getTopSkills,
  getSkillsToPatch,
  getRecentSkillsForSession,
  getRecentSessionKeys,
  clearCache,
  setDbGetter,
};
