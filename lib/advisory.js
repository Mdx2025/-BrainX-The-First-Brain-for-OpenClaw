/**
 * BrainX Advisory System
 * Pre-action advisory that queries relevant memories before an agent executes a tool.
 */

const crypto = require('crypto');
const fs = require('fs/promises');
const db = require('./db');
const rag = require('./openai-rag');

// ─── High-risk tool registry ──────────────────────────────────

const HIGH_RISK_TOOLS = new Set([
  'exec', 'deploy', 'railway', 'delete', 'rm', 'drop',
  'git push', 'git force-push', 'migration', 'cron',
  'message send', 'email send'
]);

/**
 * Check if a tool name is considered high-risk.
 * Matches exact tool names and also checks the first word (e.g. "git push" matches "git").
 * @param {string} tool
 * @returns {boolean}
 */
function isHighRisk(tool) {
  if (!tool) return false;
  return HIGH_RISK_TOOLS.has(tool) ||
    HIGH_RISK_TOOLS.has(tool.split(' ')[0]);
}

// Cooldown: don't spam same advice within this window (ms)
const ADVISORY_COOLDOWN_MS = parseInt(process.env.BRAINX_ADVISORY_COOLDOWN_MS || '300000', 10); // 5 min default
const SOURCE_FRESHNESS_CACHE_TTL_MS = 2 * 60 * 1000;
const PRIMARY_ALLOWED_SOURCE_KINDS = new Set(['knowledge_canonical', 'tool_verified', 'user_explicit']);
const SECONDARY_ALLOWED_SOURCE_KINDS = new Set(['agent_inference']);
const SOURCE_FRESHNESS_KINDS = new Set(['knowledge_canonical', 'knowledge_staging', 'knowledge_generated', 'tool_verified', 'user_explicit']);
const GENERAL_EMIT_CONFIDENCE_FLOOR = 0.52;
const EXEC_EMIT_CONFIDENCE_FLOOR = 0.68;
const DIRECT_MATCH_STOP_TERMS = new Set([
  'a', 'about', 'agent', 'all', 'and', 'args', 'auth', 'command', 'con', 'context', 'de', 'del', 'deploy',
  'el', 'en', 'error', 'exec', 'for', 'from', 'git', 'how', 'https', 'in', 'is', 'it', 'la', 'las', 'los',
  'message', 'null', 'of', 'on', 'or', 'para', 'path', 'project', 'run', 'session', 'the', 'to', 'tool',
  'unknown', 'url', 'with', 'workdir', 'y',
]);
const sourceFreshnessCache = new Map();

function makeAdvisoryId() {
  return `adv_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Build a search query string from action context for embedding similarity.
 */
function buildSearchQuery(actionContext) {
  const parts = [];
  if (actionContext.tool) parts.push(`tool:${actionContext.tool}`);
  if (actionContext.args) {
    try {
      const argsObj = typeof actionContext.args === 'string' ? JSON.parse(actionContext.args) : actionContext.args;
      // Include key arg values for better semantic match
      for (const [k, v] of Object.entries(argsObj)) {
        if (typeof v === 'string' && v.length < 200) parts.push(`${k}:${v}`);
      }
    } catch (_) {
      parts.push(String(actionContext.args));
    }
  }
  if (actionContext.project) parts.push(`project:${actionContext.project}`);
  return parts.join(' ');
}

function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function isRecentRow(row, maxAgeDays) {
  const candidate = row?.last_seen || row?.resolved_at || row?.created_at || row?.first_seen;
  const parsed = candidate ? Date.parse(String(candidate)) : NaN;
  return Number.isFinite(parsed) && (Date.now() - parsed <= maxAgeDays * 24 * 60 * 60 * 1000);
}

function isCurrentIssueMemory(row) {
  const status = String(row?.status || '').toLowerCase();
  const category = String(row?.category || '').toLowerCase();
  const tags = Array.isArray(row?.tags) ? row.tags.map((tag) => String(tag).toLowerCase()) : [];
  const verification = String(row?.verification_state || '').toLowerCase();
  if (!['pending', 'in_progress'].includes(status)) return false;
  if (verification !== 'changelog' && !tags.some((tag) => tag.includes('tool-failure'))) return false;
  if (['error', 'correction', 'infrastructure'].includes(category)) return true;
  return tags.some((tag) => tag.includes('tool-failure') || tag.startsWith('tool:'));
}

function tokenizeContextValue(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9._/-]+/i)
    .filter(Boolean)
    .filter((token) => token.length >= 3 && !DIRECT_MATCH_STOP_TERMS.has(token));
}

function extractContextTerms(actionContext = {}) {
  const values = [];
  const commandTokens = [];

  if (actionContext.tool) values.push(String(actionContext.tool));
  if (actionContext.project) values.push(String(actionContext.project));

  if (actionContext.args) {
    try {
      const argsObj = typeof actionContext.args === 'string' ? JSON.parse(actionContext.args) : actionContext.args;
      if (typeof argsObj?.command === 'string') {
        commandTokens.push(...String(argsObj.command).toLowerCase().split(/[^a-z0-9._/-]+/i).filter(Boolean));
      }
      for (const value of Object.values(argsObj || {})) {
        if (typeof value === 'string') values.push(value);
      }
    } catch (_) {
      values.push(String(actionContext.args));
    }
  }

  const terms = new Set();
  for (const token of commandTokens) {
    if (token.length < 2 || DIRECT_MATCH_STOP_TERMS.has(token)) continue;
    terms.add(token);
  }
  for (const value of values) {
    for (const token of tokenizeContextValue(value)) {
      if (token.length < 4) continue;
      terms.add(token);
    }
  }
  return [...terms];
}

function countActionTermHits(row, terms) {
  if (!terms.length) return { matches: 0, strongMatches: 0 };
  const haystack = [
    row.content,
    row.context,
    Array.isArray(row.tags) ? row.tags.join(' ') : '',
    row.problem,
    row.solution,
    row.pattern_key,
    row.representative_content
  ].filter(Boolean).join(' ').toLowerCase();
  let matches = 0;
  let strongMatches = 0;
  for (const term of terms) {
    if (!haystack.includes(term)) continue;
    matches += 1;
    if (term.length >= 6 || /[./:_-]/.test(term)) strongMatches += 1;
  }
  return { matches, strongMatches };
}

function rowMatchesActionContext(row, terms) {
  const similarity = Number(row?.similarity ?? 0);
  if (!terms.length) return similarity >= 0.62;
  const { matches, strongMatches } = countActionTermHits(row, terms);
  if (matches <= 0) return false;
  const required = terms.length >= 4 ? 2 : 1;
  return matches >= required && (strongMatches >= 1 || similarity >= 0.68);
}

function extractSourceFilePath(sourcePath) {
  const raw = normalizeWhitespace(sourcePath);
  if (!raw || !raw.startsWith('/')) return null;
  const first = raw.split('|')[0]?.trim() || raw;
  return first.startsWith('/') ? first : null;
}

function getRowTimestampMs(row) {
  const candidate = row?.last_seen || row?.created_at || row?.first_seen || row?.resolved_at;
  const parsed = candidate ? Date.parse(String(candidate)) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

async function isRowFreshAgainstSource(row) {
  const sourceKind = String(row?.source_kind || '');
  if (!SOURCE_FRESHNESS_KINDS.has(sourceKind)) return true;

  const sourceFile = extractSourceFilePath(row?.source_path);
  const rowTs = getRowTimestampMs(row);
  if (!sourceFile || rowTs == null) return true;

  const cacheKey = `${sourceFile}:${rowTs}`;
  const cached = sourceFreshnessCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.fresh;

  let fresh = true;
  try {
    const stat = await fs.stat(sourceFile);
    fresh = stat.mtimeMs <= rowTs + SOURCE_FRESHNESS_CACHE_TTL_MS;
  } catch (_) {
    fresh = true;
  }

  sourceFreshnessCache.set(cacheKey, { expiresAt: Date.now() + SOURCE_FRESHNESS_CACHE_TTL_MS, fresh });
  return fresh;
}

function isVerifiedInferenceEligible(row) {
  const confidence = Number(row?.confidence_score ?? 0);
  const tags = Array.isArray(row?.tags) ? row.tags.map((tag) => String(tag)) : [];
  const category = String(row?.category || '');
  const calibrated = tags.includes('calibrated_verified') || confidence >= 0.82;
  return isRecentRow(row, 21) && (calibrated || ['infrastructure', 'project_registry', 'best_practice', 'correction', 'error'].includes(category));
}

async function isAdvisoryMemoryApplicable(row, terms) {
  if (!(row.tier === 'hot' || row.tier === 'warm')) return false;
  if (!['fact', 'decision', 'gotcha'].includes(row.type)) return false;
  if (!rowMatchesActionContext(row, terms)) return false;
  if (!(await isRowFreshAgainstSource(row))) return false;

  if (row.verification_state === 'verified') {
    if (PRIMARY_ALLOWED_SOURCE_KINDS.has(row.source_kind)) return true;
    if (SECONDARY_ALLOWED_SOURCE_KINDS.has(row.source_kind)) return isVerifiedInferenceEligible(row);
    return false;
  }

  if (row.verification_state === 'changelog') {
    return isCurrentIssueMemory(row) && isRecentRow(row, 7);
  }

  return false;
}

/**
 * Check cooldown: was there a recent advisory for this agent+tool?
 */
async function isOnCooldown(agent, tool) {
  const cutoff = new Date(Date.now() - ADVISORY_COOLDOWN_MS);
  const res = await db.query(
    `SELECT id FROM brainx_advisories
     WHERE agent = $1 AND tool = $2 AND created_at > $3
     ORDER BY created_at DESC LIMIT 1`,
    [agent || 'unknown', tool, cutoff]
  );
  return res.rows.length > 0;
}

/**
 * Query memories relevant to the action context.
 */
async function queryRelevantMemories(searchQuery, actionContext, limit = 5) {
  const rows = await rag.search(searchQuery, {
    limit: Math.max(limit * 3, 8),
    minSimilarity: 0.35,
    minImportance: 5,
    tierFilter: null, // we'll filter hot/warm in SQL
    contextFilter: null
  });

  const terms = extractContextTerms(actionContext);
  const verdicts = await Promise.all(rows.map(async (row) => ({
    row,
    ok: await isAdvisoryMemoryApplicable(row, terms)
  })));
  return verdicts.filter((entry) => entry.ok).map((entry) => entry.row).slice(0, limit);
}

/**
 * Query trajectories for similar problem→solution paths.
 */
async function queryTrajectories(searchQuery, actionContext, limit = 3) {
  try {
    const embedding = await rag.embed(searchQuery);
    const res = await db.query(
      `SELECT id, context, problem, solution, outcome,
              1 - (embedding <=> $1::vector) AS similarity
       FROM brainx_trajectories
       WHERE outcome IN ('success', 'partial')
         AND created_at > NOW() - INTERVAL '180 days'
       ORDER BY similarity DESC
       LIMIT $2`,
      [JSON.stringify(embedding), limit]
    );
    const terms = extractContextTerms(actionContext);
    return res.rows.filter(r => (r.similarity ?? 0) >= 0.45 && rowMatchesActionContext(r, terms));
  } catch (_) {
    return [];
  }
}

/**
 * Query patterns for recurring issues related to the action.
 */
async function queryPatterns(actionContext, limit = 3) {
  try {
    const terms = [actionContext.tool, actionContext.project, actionContext.agent]
      .filter(Boolean)
      .map(v => `%${String(v).toLowerCase()}%`);

    const res = await db.query(
      `SELECT p.pattern_key, p.recurrence_count, p.impact_score, p.last_status,
              m.content AS representative_content, m.type AS memory_type,
              m.context AS memory_context
       FROM brainx_patterns p
       LEFT JOIN brainx_memories m ON m.id = p.representative_memory_id
       WHERE p.recurrence_count >= 3
         AND COALESCE(p.last_status, 'pending') NOT IN ('resolved', 'wont_fix')
         AND m.type IN ('fact', 'decision', 'gotcha')
         AND COALESCE(m.verification_state, 'hypothesis') NOT IN ('obsolete')
         AND m.superseded_by IS NULL
         AND COALESCE(m.status, 'pending') NOT IN ('resolved', 'wont_fix')
         AND (m.expires_at IS NULL OR m.expires_at > NOW())
       ORDER BY p.recurrence_count DESC, p.impact_score DESC
       LIMIT $1`,
      [limit]
    );
    if (terms.length === 0) return [];
    return res.rows.filter((row) => {
      const haystack = [
        row.pattern_key,
        row.representative_content,
        row.memory_context,
      ].filter(Boolean).join(' ').toLowerCase();
      return terms.some((term) => haystack.includes(term.replace(/%/g, '')));
    });
  } catch (_) {
    return [];
  }
}

/**
 * Format advisory results into readable text.
 */
function formatAdvisory(memories, trajectories, patterns) {
  const sections = [];
  let weightedConfidence = 0;
  let weightedCount = 0;

  if (memories.length > 0) {
    const lines = memories.map(m => {
      const sim = (m.similarity ?? 0).toFixed(2);
      const recurrence = Number(m.recurrence_count || 0) > 1 ? `|x${m.recurrence_count}` : '';
      const status = m.status ? `|${m.status}` : '';
      return `  • [${m.type}|sim:${sim}|imp:${m.importance}${recurrence}${status}] ${m.content.slice(0, 200)}`;
    });
    sections.push(`📝 Relevant Memories (${memories.length}):\n${lines.join('\n')}`);
    weightedConfidence += memories.reduce((s, m) => s + (m.similarity ?? 0), 0);
    weightedCount += memories.length;
  }

  if (trajectories.length > 0) {
    const lines = trajectories.map(t => {
      const sim = (t.similarity ?? 0).toFixed(2);
      return `  • [${t.outcome}|sim:${sim}] ${t.problem?.slice(0, 100) || 'N/A'} → ${t.solution?.slice(0, 100) || 'N/A'}`;
    });
    sections.push(`🔄 Similar Past Paths (${trajectories.length}):\n${lines.join('\n')}`);
    weightedConfidence += trajectories.reduce((s, t) => s + ((t.similarity ?? 0) * 0.45), 0);
    weightedCount += trajectories.length * 0.45;
  }

  if (patterns.length > 0) {
    const lines = patterns.map(p =>
      `  • [×${p.recurrence_count}|impact:${(p.impact_score ?? 0).toFixed(1)}] ${p.representative_content?.slice(0, 150) || p.pattern_key}`
    );
    sections.push(`🔁 Recurring Patterns (${patterns.length}):\n${lines.join('\n')}`);
    weightedConfidence += patterns.length * 0.18;
    weightedCount += patterns.length * 0.35;
  }

  const avgConfidence = weightedCount > 0 ? Math.min(weightedConfidence / weightedCount, 1.0) : 0;
  // A direct, high-similarity memory is stronger evidence than auxiliary
  // trajectories/patterns. Do not let broad pattern matches dilute a concrete
  // safety memory below the emission floor for high-risk tools.
  const strongestMemory = memories.reduce((top, row) => Math.max(top, Number(row?.similarity ?? 0)), 0);
  const effectiveConfidence = memories.length > 0 ? Math.max(avgConfidence, strongestMemory) : avgConfidence;
  const sourceIds = memories.map(m => m.id);

  return {
    text: sections.length > 0 ? sections.join('\n\n') : null,
    confidence: Number(effectiveConfidence.toFixed(3)),
    sourceIds,
    totalSources: memories.length + trajectories.length + patterns.length
  };
}

function shouldEmitAdvisory({ tool, memories, trajectories, patterns, confidence }) {
  const normalizedTool = String(tool || '').trim().toLowerCase();
  if (!memories.length && !trajectories.length && !patterns.length) return false;

  const strongestMemory = memories.reduce((top, row) => Math.max(top, Number(row?.similarity ?? 0)), 0);

  if (normalizedTool === 'exec') {
    if (memories.length === 0) return false;
    if (strongestMemory < 0.58) return false;
    return Number(confidence || 0) >= EXEC_EMIT_CONFIDENCE_FLOOR;
  }

  if (!memories.length && trajectories.length < 2) return false;
  return Number(confidence || 0) >= GENERAL_EMIT_CONFIDENCE_FLOOR;
}

/**
 * Main advisory function.
 * @param {Object} actionContext - { tool, args, agent, project }
 * @returns {Object} { advisory_text, confidence, source_memory_ids, id, on_cooldown }
 */
async function getAdvisory(actionContext) {
  const { tool, args, agent, project } = actionContext;

  // Check cooldown
  if (await isOnCooldown(agent, tool)) {
    return {
      id: null,
      advisory_text: null,
      confidence: 0,
      source_memory_ids: [],
      on_cooldown: true
    };
  }

  const searchQuery = buildSearchQuery(actionContext);

  // Query all sources in parallel
  const [memories, trajectories, patterns] = await Promise.all([
    queryRelevantMemories(searchQuery, actionContext),
    queryTrajectories(searchQuery, actionContext),
    queryPatterns(actionContext)
  ]);

  const { text, confidence, sourceIds, totalSources } = formatAdvisory(memories, trajectories, patterns);

  if (!text || !shouldEmitAdvisory({ tool, memories, trajectories, patterns, confidence })) {
    return {
      id: null,
      advisory_text: null,
      confidence: 0,
      source_memory_ids: [],
      on_cooldown: false
    };
  }

  // Store the advisory
  const id = makeAdvisoryId();
  const actionContextJson = {
    tool,
    args: typeof args === 'string' ? (() => { try { return JSON.parse(args); } catch (_) { return args; } })() : args,
    agent,
    project
  };

  await db.query(
    `INSERT INTO brainx_advisories (id, agent, tool, action_context, advisory_text, source_memory_ids, confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, agent || 'unknown', tool, JSON.stringify(actionContextJson), text, sourceIds, confidence]
  );

  return {
    id,
    advisory_text: text,
    confidence,
    source_memory_ids: sourceIds,
    on_cooldown: false
  };
}

/**
 * Record feedback on an advisory.
 */
async function advisoryFeedback(advisoryId, wasFollowed, outcome) {
  const res = await db.query(
    `UPDATE brainx_advisories
     SET was_followed = $2, outcome = $3
     WHERE id = $1
     RETURNING id, agent, tool, was_followed, outcome`,
    [advisoryId, wasFollowed, outcome || null]
  );
  if (res.rowCount === 0) throw new Error(`Advisory not found: ${advisoryId}`);
  return res.rows[0];
}

module.exports = { getAdvisory, advisoryFeedback, buildSearchQuery, formatAdvisory, isHighRisk, HIGH_RISK_TOOLS };
