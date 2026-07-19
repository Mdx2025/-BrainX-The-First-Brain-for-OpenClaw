/**
 * BrainX Reactive Error-Recall
 * BRAINX_REACTIVE_ERROR_RECALL_FINGERPRINT_20260719
 *
 * When an agent HITS a tool/runtime error, surface the fix that already resolved
 * the SAME error before (by this agent or any other — the corpus is fleet-shared).
 *
 * Why this exists (measured): the pre-call advisory (lib/advisory.js) is PREVENTIVE
 * (fires before a high-risk tool, queried by tool+args) and there is NO reactive
 * post-failure path. Free-text symptom→fix vector match was measured weak (~0.53,
 * below the 0.55 recall gate) once an agent rephrases the error. The industry answer
 * (Sentry-style error grouping) is a deterministic fingerprint with exact-match FIRST
 * and a vector fallback SECOND — that is what this module implements.
 *
 * Rollout safety: every behavior here is gated behind BRAINX_REACTIVE_ERROR_RECALL,
 * OFF by default. The plugin write path is untouched; fingerprints are DERIVED by an
 * idempotent backfill, not inserted inline. Fail-open everywhere (never throws into
 * the runtime error path — an error in error-recall must not mask the original error).
 */

const db = require('./db');
const rag = require('./openai-rag');

// ─── Flags (house convention: env kill-switch, off-by-default for new behavior) ──
function isEnabled() {
  return String(process.env.BRAINX_REACTIVE_ERROR_RECALL || '0') === '1';
}
function exactFirstEnabled() {
  return String(process.env.BRAINX_ERROR_FINGERPRINT_EXACT_FIRST || '1') !== '0';
}
function errorSurfaceGate() {
  const v = parseFloat(process.env.BRAINX_ERROR_SURFACE_GATE || '0.48');
  return Number.isFinite(v) ? v : 0.48;
}

const FINGERPRINT_MAX_LEN = 200;
const MESSAGE_MAX_LEN = 160;

// POSIX errno codes — a token that IS one of these is the strongest class signal.
// Kept as an explicit set so generic words like "error"/"exec"/"email" never get
// mistaken for an error class (they are not errno codes).
const ERRNO_CODES = new Set([
  'enoent', 'eacces', 'econnrefused', 'econnreset', 'etimedout', 'epipe',
  'eaddrinuse', 'enotfound', 'eexist', 'eperm', 'eisdir', 'enotdir',
  'emfile', 'ehostunreach', 'enetunreach', 'eagain', 'einval',
]);

// Semantic error-class patterns, checked in order after errno. First hit wins;
// else exitN; else 'generic'. Deliberately no loose /e[a-z]+/ catch-all.
const ERROR_CLASS_PATTERNS = [
  [/\bsyntaxerror\b/, () => 'syntaxerror'],
  [/\btypeerror\b/, () => 'typeerror'],
  [/\breferenceerror\b/, () => 'referenceerror'],
  [/\btimed?\s?out\b|\btimeout\b/, () => 'timeout'],
  [/\bpermission denied\b|\bnot allowed\b|\bforbidden\b/, () => 'permission'],
  [/\b(401|403)\b/, (m) => `http${m[1]}`],
  [/\b(404)\b/, () => 'http404'],
  [/\b(5\d{2})\b/, (m) => `http${m[1]}`],
  [/\bconnection refused\b|\bconnrefused\b/, () => 'connrefused'],
  [/\bno such file\b|\bnot found\b/, () => 'notfound'],
  [/\bunauthorized\b/, () => 'unauthorized'],
  [/\bconflict\b/, () => 'conflict'],
  [/\bassert(ion)?\b/, () => 'assert'],
  [/\bkilled\b|\boom\b|\bout of memory\b/, () => 'oom'],
];

/**
 * Normalize a raw error message into a stable, comparable form.
 * Strips the volatile parts (paths, ids, numbers, hashes, timestamps, quotes) so
 * two runs of the SAME failure collapse to one signature.
 */
function normalizeErrorMessage(raw) {
  let s = String(raw ?? '').toLowerCase();
  s = s.replace(/\r/g, ' ').replace(/\n+/g, ' ');
  // ISO timestamps / dates
  s = s.replace(/\d{4}-\d{2}-\d{2}[t ]?[\d:.]*z?/g, '<ts>');
  // absolute unix paths and windows paths
  s = s.replace(/[a-z]:\\[^\s"']+/g, '<path>');
  s = s.replace(/\/[^\s"':]+/g, '<path>');
  // uuids
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>');
  // long hex (sha, tokens)
  s = s.replace(/\b[0-9a-f]{12,}\b/g, '<hex>');
  // urls
  s = s.replace(/https?:\/\/[^\s"']+/g, '<url>');
  // number glued to a common unit (3000ms, 512mb, 30s) — collapse before the
  // standalone-number rule so timeouts/sizes with different magnitudes match.
  s = s.replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|m|h|kb|mb|gb|tb|k|b)\b/g, '<n>');
  // ports / pids / any standalone number
  s = s.replace(/\b\d+\b/g, '<n>');
  // quotes and backticks
  s = s.replace(/[`'"]/g, '');
  // collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, MESSAGE_MAX_LEN);
}

/**
 * Derive a coarse error class from the message and optional exit code.
 */
function classifyError(rawMessage, exitCode) {
  const s = String(rawMessage ?? '').toLowerCase();
  // 1. errno codes win (explicit set — no false matches on "error"/"exec").
  for (const tok of s.split(/[^a-z0-9]+/)) {
    if (ERRNO_CODES.has(tok)) return tok;
  }
  // 2. semantic patterns.
  for (const [re, pick] of ERROR_CLASS_PATTERNS) {
    const m = s.match(re);
    if (m) return pick(m);
  }
  if (exitCode != null && String(exitCode) !== '' && String(exitCode) !== '0') {
    return `exit${exitCode}`;
  }
  return 'generic';
}

/**
 * Normalize the tool name (first token, lowercased) — "git push" → "git".
 */
function normalizeTool(tool) {
  return String(tool || 'unknown').trim().toLowerCase().split(/\s+/)[0] || 'unknown';
}

/**
 * Compute the deterministic error fingerprint.
 * Canonical string form (debuggable, exact-match on a btree text index):
 *   <tool>|<errorClass>|<normalizedMessage>
 * @returns {string|null} fingerprint, or null when there is no usable error signal.
 */
function computeFingerprint({ tool, errorMessage, exitCode } = {}) {
  const msg = normalizeErrorMessage(errorMessage);
  const cls = classifyError(errorMessage, exitCode);
  if (!msg && cls === 'generic' && (exitCode == null || String(exitCode) === '0')) {
    return null; // nothing to key on
  }
  const fp = `${normalizeTool(tool)}|${cls}|${msg}`;
  return fp.slice(0, FINGERPRINT_MAX_LEN);
}

// ─── Backfill: derive fingerprints for existing tool-failure gotchas ─────────────

/**
 * Best-effort extraction of a tool name from a failure gotcha's tags/content.
 */
function toolFromRow(row) {
  const tags = Array.isArray(row.tags) ? row.tags.map((t) => String(t)) : [];
  const toolTag = tags.find((t) => t.toLowerCase().startsWith('tool:'));
  if (toolTag) return toolTag.slice(5);
  const m = String(row.content || '').match(/\btool[:\s]+([a-z0-9_.-]+)/i);
  return m ? m[1] : 'unknown';
}

/**
 * Populate error_fingerprint for tool-failure gotchas that lack one. Idempotent:
 * only touches rows where error_fingerprint IS NULL. Safe to run repeatedly (e.g.
 * from the nightly memory loop) so NEW failures get fingerprinted without a plugin
 * write-path change.
 * @returns {Promise<{scanned:number, updated:number}>}
 */
async function backfillFingerprints({ limit = 2000 } = {}) {
  const res = await db.query(
    `SELECT id, content, tags, category, metadata
       FROM brainx_memories
      WHERE error_fingerprint IS NULL
        AND type IN ('fact','decision','gotcha')
        AND (
          category IN ('error','correction','infrastructure')
          OR EXISTS (SELECT 1 FROM unnest(coalesce(tags,'{}'::text[])) tg
                     WHERE tg ILIKE 'tool-failure%' OR tg ILIKE 'tool:%')
        )
      ORDER BY last_seen DESC NULLS LAST, created_at DESC
      LIMIT $1`,
    [limit]
  );

  let updated = 0;
  for (const row of res.rows) {
    const tool = toolFromRow(row);
    // exit code, if present in the content
    const exitMatch = String(row.content || '').match(/\bexit(?:\s?code)?[:\s=]+(\d+)/i);
    const exitCode = exitMatch ? exitMatch[1] : null;
    const fp = computeFingerprint({ tool, errorMessage: row.content, exitCode });
    if (!fp) continue;
    await db.query(`UPDATE brainx_memories SET error_fingerprint = $2 WHERE id = $1 AND error_fingerprint IS NULL`, [row.id, fp]);
    updated += 1;
  }
  return { scanned: res.rows.length, updated };
}

// ─── Reactive lookup: exact-first, vector fallback ───────────────────────────────

function isFixRow(row) {
  if (!['fact', 'decision', 'gotcha'].includes(row.type)) return false;
  const vs = String(row.verification_state || '').toLowerCase();
  if (['obsolete'].includes(vs)) return false;
  if (row.superseded_by) return false;
  return true;
}

async function exactMatch(fingerprint, limit) {
  if (!fingerprint) return [];
  const res = await db.query(
    `SELECT id, type, content, importance, confidence_score, verification_state,
            source_kind, status, tags, superseded_by, feedback_score
       FROM brainx_memories
      WHERE error_fingerprint = $1
        AND superseded_by IS NULL
        AND coalesce(verification_state,'') <> 'obsolete'
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY (coalesce(status,'') = 'resolved') DESC,
               coalesce(feedback_score,0) DESC,
               importance DESC,
               last_seen DESC NULLS LAST
      LIMIT $2`,
    [fingerprint, limit]
  );
  return res.rows.map((r) => ({ ...r, similarity: 1.0, match_kind: 'exact' }));
}

async function vectorFallback({ tool, errorMessage, exitCode, limit }) {
  const gate = errorSurfaceGate();
  const query = `tool:${normalizeTool(tool)} error ${normalizeErrorMessage(errorMessage)}`;
  let rows = [];
  try {
    rows = await rag.search(query, {
      limit: Math.max(limit * 3, 6),
      minSimilarity: gate,
      minImportance: 4,
      surface: 'error_recall',
    });
  } catch (_) {
    return [];
  }
  return rows
    .filter(isFixRow)
    .filter((r) => Number(r.similarity ?? 0) >= gate)
    .slice(0, limit)
    .map((r) => ({ ...r, match_kind: 'vector' }));
}

function formatHits(hits) {
  if (!hits.length) return null;
  const lines = hits.map((h) => {
    const sim = Number(h.similarity ?? 0).toFixed(2);
    const st = h.status ? `|${h.status}` : '';
    return `  • [${h.match_kind}|${h.type}|sim:${sim}|imp:${h.importance ?? '?'}${st}] ${String(h.content || '').slice(0, 240)}`;
  });
  return `🧯 Prior fix for this error (${hits.length}):\n${lines.join('\n')}`;
}

/**
 * Reactive lookup. Call this when a tool has FAILED.
 * @returns {Promise<{text:string|null, hits:Array, fingerprint:string|null, match_kind:string|null, id:string|null}>}
 */
async function lookup({ tool, errorMessage, exitCode = null, agent = null, project = null, limit = 2 } = {}) {
  const empty = { text: null, hits: [], fingerprint: null, match_kind: null, id: null };
  if (!isEnabled()) return empty;
  try {
    const fingerprint = computeFingerprint({ tool, errorMessage, exitCode });

    let hits = [];
    let matchKind = null;
    if (exactFirstEnabled() && fingerprint) {
      hits = await exactMatch(fingerprint, limit);
      if (hits.length) matchKind = 'exact';
    }
    if (!hits.length) {
      hits = await vectorFallback({ tool, errorMessage, exitCode, limit });
      if (hits.length) matchKind = 'vector';
    }
    if (!hits.length) return { ...empty, fingerprint };

    const text = formatHits(hits);
    const id = await recordLookup({ agent, tool, project, fingerprint, hits, matchKind });
    return { text, hits, fingerprint, match_kind: matchKind, id };
  } catch (_) {
    // Fail-open: never let error-recall throw into the runtime failure path.
    return empty;
  }
}

// ─── Telemetry + feedback (reuses brainx_advisories; surface tagged in action_context) ──

function makeId() {
  return `errrec_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

async function recordLookup({ agent, tool, project, fingerprint, hits, matchKind }) {
  const id = makeId();
  try {
    await db.query(
      `INSERT INTO brainx_advisories (id, agent, tool, action_context, advisory_text, source_memory_ids, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        agent || 'unknown',
        tool || 'unknown',
        JSON.stringify({ surface: 'error_recall', fingerprint, match_kind: matchKind, project: project || null }),
        formatHits(hits),
        hits.map((h) => h.id),
        matchKind === 'exact' ? 1.0 : Number(hits[0]?.similarity ?? 0),
      ]
    );
  } catch (_) { /* fail-open */ }
  return id;
}

/**
 * Feedback re-weighting (Cognee-style "improve"): after the agent retried, tell us
 * whether the surfaced fix actually resolved the error. Boost fixes that worked;
 * demote fixes that did not. Closes the loop so ranking self-heals.
 * @param {Object} p
 * @param {string[]} p.memoryIds  the fix memory ids that were surfaced
 * @param {boolean}  p.resolved   did the retry succeed after seeing the fix?
 * @param {string=}  p.lookupId   the recordLookup id (to store outcome)
 */
async function recordOutcome({ memoryIds = [], resolved, lookupId = null } = {}) {
  const delta = resolved ? 1 : -1;
  const out = { updated: 0 };
  for (const mid of memoryIds) {
    try {
      await db.query(
        `UPDATE brainx_memories
            SET feedback_score = coalesce(feedback_score,0) + $2,
                importance = GREATEST(1, LEAST(10, importance + $3))
          WHERE id = $1`,
        [mid, delta, resolved ? 1 : 0]
      );
      out.updated += 1;
    } catch (_) { /* fail-open */ }
  }
  if (lookupId) {
    try {
      await db.query(
        `UPDATE brainx_advisories SET was_followed = true, outcome = $2 WHERE id = $1`,
        [lookupId, resolved ? 'resolved' : 'unresolved']
      );
    } catch (_) { /* fail-open */ }
  }
  return out;
}

// ─── Observability: error_recall surface stats ──────────────────────────────────

/**
 * Surface stats for the reactive error-recall path over the last N days.
 * (The pre-call advisory surface was invisible in runtime-report; this makes the
 * reactive surface measurable so a rollout can be judged on real hard/soft signal.)
 */
async function surfaceStats({ days = 7 } = {}) {
  const res = await db.query(
    `SELECT
        count(*)                                                        AS lookups,
        count(*) FILTER (WHERE action_context->>'match_kind' = 'exact')  AS exact_hits,
        count(*) FILTER (WHERE action_context->>'match_kind' = 'vector') AS vector_hits,
        count(*) FILTER (WHERE was_followed IS TRUE)                     AS with_feedback,
        count(*) FILTER (WHERE outcome = 'resolved')                     AS resolved,
        count(*) FILTER (WHERE outcome = 'unresolved')                   AS unresolved
       FROM brainx_advisories
      WHERE action_context->>'surface' = 'error_recall'
        AND created_at > NOW() - ($1 || ' days')::interval`,
    [String(days)]
  );
  const r = res.rows[0] || {};
  const lookups = Number(r.lookups || 0);
  const resolved = Number(r.resolved || 0);
  const withFeedback = Number(r.with_feedback || 0);
  return {
    days,
    lookups,
    exact_hits: Number(r.exact_hits || 0),
    vector_hits: Number(r.vector_hits || 0),
    with_feedback: withFeedback,
    resolved,
    unresolved: Number(r.unresolved || 0),
    resolved_ratio: withFeedback > 0 ? Number((resolved / withFeedback).toFixed(3)) : null,
  };
}

module.exports = {
  normalizeErrorMessage,
  classifyError,
  normalizeTool,
  computeFingerprint,
  backfillFingerprints,
  lookup,
  recordOutcome,
  surfaceStats,
  isEnabled,
  errorSurfaceGate,
};
