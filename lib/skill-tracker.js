'use strict';
// BRAINX_SKILL_LOAD_TRACKING_20260608
// Per-turn audit trail of which skills were loaded/consulted and whether
// they turned out to be helpful, wrong, or ignored. Mirrors the pattern
// in lib/cost-tracker.js: fire-and-forget inserts via setImmediate, lazy
// db require, and an optional override hook for tests / plugin runtime.

let _db = null;
function getDb() {
  if (!_db) _db = require('./db');
  return _db;
}

let _dbOverride = null;
function setDbGetter(fn) {
  _dbOverride = fn;
}

const INSERT_SQL = `
  INSERT INTO brainx_skill_loads (session_key, skill_name, turn_index, source)
  VALUES ($1, $2, $3, $4)
  RETURNING id
`.trim();

const UPDATE_OUTCOME_SQL = `
  UPDATE brainx_skill_loads
  SET outcome = $2
  WHERE id = $1
  RETURNING id, session_key, skill_name, outcome
`.trim();

const RECENT_LOADS_SQL = `
  SELECT id, session_key, skill_name, loaded_at, turn_index, source, outcome
  FROM brainx_skill_loads
  WHERE session_key = $1
  ORDER BY loaded_at DESC
  LIMIT $2
`.trim();

const STATS_BY_SKILL_SQL = `
  SELECT
    COUNT(*)::int AS total_loads,
    COUNT(*) FILTER (WHERE outcome = 'helpful')::int AS helpful,
    COUNT(*) FILTER (WHERE outcome = 'wrong')::int   AS wrong,
    COUNT(*) FILTER (WHERE outcome = 'ignored')::int AS ignored,
    COUNT(*) FILTER (WHERE outcome IS NOT NULL)::int AS reported
  FROM brainx_skill_loads
  WHERE skill_name = $1
`.trim();

function resolveDb() {
  const db = _dbOverride ? _dbOverride() : getDb();
  return db && typeof db.then === 'function' ? db : Promise.resolve(db);
}

/**
 * Record a skill load. Fire-and-forget — never throws, never blocks.
 * Resolves the insert synchronously to the caller via the optional
 * onInserted(id) callback; if not provided, the insert is fully silent.
 */
function trackSkillLoad(sessionKey, skillName, turnIndex, source, opts = {}) {
  if (!sessionKey || !skillName) return null;
  const onInserted = typeof opts.onInserted === 'function' ? opts.onInserted : null;

  setImmediate(async () => {
    try {
      const db = await resolveDb();
      const result = await db.query(INSERT_SQL, [
        String(sessionKey),
        String(skillName),
        Number.isInteger(turnIndex) ? turnIndex : null,
        source ? String(source) : null,
      ]);
      const id = result?.rows?.[0]?.id ?? null;
      if (onInserted && id != null) {
        try { onInserted(id); } catch (_) {}
      }
    } catch (_err) {
      // Tracking must never break the caller.
    }
  });
  return null;
}

/**
 * Async variant — returns the inserted id (or null on failure).
 * Used by the CLI to verify the row was written before responding.
 */
async function trackSkillLoadAsync(sessionKey, skillName, turnIndex, source) {
  if (!sessionKey || !skillName) return null;
  try {
    const db = await resolveDb();
    const result = await db.query(INSERT_SQL, [
      String(sessionKey),
      String(skillName),
      Number.isInteger(turnIndex) ? turnIndex : null,
      source ? String(source) : null,
    ]);
    return result?.rows?.[0]?.id ?? null;
  } catch (_err) {
    return null;
  }
}

/**
 * Record the outcome of a previous skill load. Returns the updated row
 * or null if the id does not exist / the update failed.
 */
async function recordOutcome(loadId, outcome) {
  if (!loadId) return null;
  const allowed = ['helpful', 'wrong', 'ignored'];
  if (!allowed.includes(outcome)) {
    throw new Error(`outcome must be one of: ${allowed.join(', ')}`);
  }
  try {
    const db = await resolveDb();
    const result = await db.query(UPDATE_OUTCOME_SQL, [loadId, outcome]);
    return result?.rows?.[0] ?? null;
  } catch (_err) {
    return null;
  }
}

/**
 * Return the most recent skill loads for a session, newest first.
 */
async function getRecentLoads(sessionKey, limit = 10) {
  if (!sessionKey) return [];
  const cap = Math.max(1, Math.min(parseInt(limit, 10) || 10, 200));
  try {
    const db = await resolveDb();
    const result = await db.query(RECENT_LOADS_SQL, [sessionKey, cap]);
    return result?.rows ?? [];
  } catch (_err) {
    return [];
  }
}

/**
 * Return outcome stats for a single skill. Returns
 *   { skill_name, total_loads, helpful, wrong, ignored, reported }
 * with all counts zeroed if the skill has no recorded loads.
 */
async function getSkillStats(skillName) {
  if (!skillName) {
    return { skill_name: null, total_loads: 0, helpful: 0, wrong: 0, ignored: 0, reported: 0 };
  }
  try {
    const db = await resolveDb();
    const result = await db.query(STATS_BY_SKILL_SQL, [skillName]);
    const row = result?.rows?.[0] || {};
    return {
      skill_name: skillName,
      total_loads: Number(row.total_loads || 0),
      helpful: Number(row.helpful || 0),
      wrong: Number(row.wrong || 0),
      ignored: Number(row.ignored || 0),
      reported: Number(row.reported || 0),
    };
  } catch (_err) {
    return { skill_name: skillName, total_loads: 0, helpful: 0, wrong: 0, ignored: 0, reported: 0 };
  }
}

/**
 * Wait briefly for any pending setImmediate inserts to land. Use in cron
 * scripts or tests before exiting so we don't drop the last few rows.
 */
async function flushPending(timeoutMs = 3000) {
  await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 5000)));
}

module.exports = {
  trackSkillLoad,
  trackSkillLoadAsync,
  recordOutcome,
  getRecentLoads,
  getSkillStats,
  flushPending,
  setDbGetter,
};
