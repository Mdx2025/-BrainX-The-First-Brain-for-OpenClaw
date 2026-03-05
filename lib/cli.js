// Load env silently (dotenv prints tips sometimes)
try {
  const dotenv = require('dotenv');
  const path = process.env.BRAINX_ENV || require('path').join(__dirname, '..', '.env');
  dotenv.configDotenv({ path });
} catch (_) {}

const crypto = require('crypto');

let rag;
let db;

function usage() {
  console.log(`brainx-v4

Commands:
  health
  add --type <type> --content <text> [--context <ctx>] [--tier <hot|warm|cold|archive>] [--importance <1-10>] [--tags a,b,c] [--agent <name>] [--id <id>]
      [--status <pending|in_progress|resolved|promoted|wont_fix>] [--category <learning|error|feature_request|correction|knowledge_gap|best_practice|infrastructure|project_registry>]
      [--patternKey <key>] [--recurrenceCount <n>] [--firstSeen <iso>] [--lastSeen <iso>] [--resolvedAt <iso>] [--promotedTo <target>] [--resolutionNotes <text>]
  fact --content <text> [--context <project:name>] [--importance <1-10>] [--tags a,b,c]
      Shortcut for: add --type fact --tier hot --category infrastructure
  facts [--context <ctx>] [--limit <n>]
      List all stored facts (infrastructure, URLs, services)
  search --query <text> [--limit <n>] [--minSimilarity <0-1>] [--context <ctx>] [--tier <tier>] [--minImportance <n>]
  inject --query <text> [--limit <n>] [--context <ctx>] [--tier <tier>] [--minImportance <n>] [--minScore <n>] [--maxTotalChars <n>] [--maxCharsPerItem <n>] [--maxLinesPerItem <n>]
  resolve (--id <id> | --patternKey <key>) --status <pending|in_progress|resolved|promoted|wont_fix> [--resolvedAt <iso>] [--promotedTo <target>] [--resolutionNotes <text>]
  promote-candidates [--minRecurrence <n>] [--days <n>] [--limit <n>] [--json]
  lifecycle-run [--promoteMinRecurrence <n>] [--promoteDays <n>] [--degradeDays <n>] [--lowImportanceMax <n>] [--lowAccessMax <n>] [--dryRun] [--json]
  metrics [--days <n>] [--topPatterns <n>] [--json]
  feedback --id <memory_id> (--useful | --useless | --incorrect)
      --useful    Boost importance +1 (max 10), increment access_count, feedback_score +1
      --useless   Lower importance -1 (min 1), feedback_score -1
      --incorrect Mark memory as superseded (soft delete)

Types: decision, action, learning, gotcha, note, feature_request, fact
Categories: learning, error, feature_request, correction, knowledge_gap, best_practice, infrastructure, project_registry

Environment:
  DATABASE_URL, OPENAI_API_KEY
  BRAINX_INJECT_MAX_CHARS_PER_ITEM (default 2000)
  BRAINX_INJECT_MAX_LINES_PER_ITEM (default 80)
  BRAINX_INJECT_MAX_TOTAL_CHARS (default 12000)
  BRAINX_INJECT_MIN_SCORE (default 0.25)
  BRAINX_PII_SCRUB_ENABLED (default true)
  BRAINX_PII_SCRUB_REPLACEMENT (default [REDACTED])
  BRAINX_DEDUPE_SIM_THRESHOLD (default 0.92)
`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) out[k] = true;
      else {
        out[k] = v;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function getArg(args, ...keys) {
  for (const key of keys) {
    if (args[key] !== undefined) return args[key];
  }
  return undefined;
}

function parseIntArg(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Invalid integer: ${v}`);
  return n;
}

function parseFloatArg(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = parseFloat(v);
  if (Number.isNaN(n)) throw new Error(`Invalid number: ${v}`);
  return n;
}

function nowMs() {
  return Date.now();
}

function makeId() {
  return `m_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function hashQuery(query) {
  return crypto.createHash('sha256').update(String(query)).digest('hex').slice(0, 32);
}

function summarizeSimilarities(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { avgSimilarity: null, topSimilarity: null };
  }
  const sims = rows.map(r => Number(r.similarity)).filter(n => Number.isFinite(n));
  if (!sims.length) return { avgSimilarity: null, topSimilarity: null };
  const avg = sims.reduce((a, b) => a + b, 0) / sims.length;
  const top = Math.max(...sims);
  return { avgSimilarity: Number(avg.toFixed(6)), topSimilarity: Number(top.toFixed(6)) };
}

function getRag(deps = {}) {
  if (deps.rag) return deps.rag;
  if (!rag) rag = require('./openai-rag');
  return rag;
}

function getDb(deps = {}) {
  if (deps.db) return deps.db;
  if (!db) db = require('./db');
  return db;
}

function getIo(deps = {}) {
  return {
    log: deps.log || console.log,
    err: deps.err || console.error,
    stdout: deps.stdout || process.stdout
  };
}

async function maybeLogQuery(ragApi, payload) {
  if (!ragApi || typeof ragApi.logQueryEvent !== 'function') return;
  await ragApi.logQueryEvent(payload);
}

async function cmdHealth(_args, deps = {}) {
  const io = getIo(deps);
  const dbApi = getDb(deps);
  const ok = await dbApi.health();
  const ext = await dbApi.query(
    "select exists(select 1 from pg_extension where extname='vector') as has_vector"
  );
  const tables = await dbApi.query(
    "select count(*)::int as n from information_schema.tables where table_schema='public' and table_name like 'brainx_%'"
  );
  const hasVector = ext.rows?.[0]?.has_vector;
  const nTables = tables.rows?.[0]?.n ?? 0;
  io.log(`BrainX V4 health: ${ok ? 'OK' : 'FAIL'}`);
  io.log(`- pgvector: ${hasVector ? 'yes' : 'no'}`);
  io.log(`- brainx tables: ${nTables}`);
}

async function cmdAdd(args, deps = {}) {
  const type = args.type || 'note';
  const content = args.content;
  if (!content) throw new Error('--content is required');

  const memory = {
    id: args.id || makeId(),
    type,
    content,
    context: args.context || null,
    tier: args.tier || 'warm',
    importance: args.importance ? parseInt(args.importance, 10) : 5,
    agent: (args.agent && args.agent !== true) ? args.agent : (process.env.OPENCLAW_AGENT || null),
    tags: args.tags ? String(args.tags).split(',').map(s => s.trim()).filter(Boolean) : [],
    status: getArg(args, 'status') || 'pending',
    category: getArg(args, 'category') || null,
    pattern_key: getArg(args, 'patternKey', 'pattern-key') || null,
    recurrence_count: getArg(args, 'recurrenceCount', 'recurrence-count') ? parseInt(getArg(args, 'recurrenceCount', 'recurrence-count'), 10) : undefined,
    first_seen: getArg(args, 'firstSeen', 'first-seen') || null,
    last_seen: getArg(args, 'lastSeen', 'last-seen') || null,
    resolved_at: getArg(args, 'resolvedAt', 'resolved-at') || null,
    promoted_to: getArg(args, 'promotedTo', 'promoted-to') || null,
    resolution_notes: getArg(args, 'resolutionNotes', 'resolution-notes') || null
  };

  const ragApi = getRag(deps);
  const stored = await ragApi.storeMemory(memory);
  const io = getIo(deps);
  io.log(JSON.stringify({ ok: true, id: stored?.id || memory.id, pattern_key: stored?.pattern_key || memory.pattern_key || null }));
}

async function cmdSearch(args, deps = {}) {
  const query = args.query;
  if (!query) throw new Error('--query is required');

  const limit = parseIntArg(args.limit, 10);
  const minSimilarity = parseFloatArg(args.minSimilarity, 0.3);
  const minImportance = parseIntArg(args.minImportance, 0);

  const ragApi = getRag(deps);
  const started = nowMs();
  const rows = await ragApi.search(query, {
    limit,
    minSimilarity,
    minImportance,
    tierFilter: args.tier || null,
    contextFilter: args.context || null
  });
  const durationMs = nowMs() - started;
  const simStats = summarizeSimilarities(rows);
  await maybeLogQuery(ragApi, {
    queryHash: hashQuery(query),
    kind: 'search',
    durationMs,
    resultsCount: rows.length,
    ...simStats
  });

  const io = getIo(deps);
  io.log(JSON.stringify({ ok: true, results: rows }, null, 2));
}

function truncateByChars(text, maxChars) {
  const s = String(text);
  if (!maxChars || s.length <= maxChars) return s;
  return s.slice(0, Math.max(0, maxChars - 1)) + '…';
}

function truncateByLines(text, maxLines) {
  const s = String(text);
  if (!maxLines) return s;
  const lines = s.split(/\r?\n/);
  if (lines.length <= maxLines) return s;
  return lines.slice(0, maxLines).join('\n') + '\n…';
}

function formatInject(rows, opts = {}) {
  const {
    maxCharsPerItem = 2000,
    maxLinesPerItem = 80,
    maxTotalChars = 12000
  } = opts;

  const blocks = [];
  let total = 0;
  for (const r of rows) {
    const meta = `[sim:${(r.similarity ?? 0).toFixed(2)} score:${(r.score ?? 0).toFixed(2)} imp:${r.importance} tier:${r.tier} type:${r.type} agent:${r.agent || ''} ctx:${r.context || ''}]`;

    let content = String(r.content).trim();
    content = truncateByLines(content, maxLinesPerItem);
    content = truncateByChars(content, maxCharsPerItem);
    const block = `${meta}\n${content}`;
    const sep = blocks.length ? '\n\n---\n\n' : '';

    if (maxTotalChars && total + sep.length >= maxTotalChars) break;
    if (maxTotalChars && total + sep.length + block.length > maxTotalChars) {
      const remaining = maxTotalChars - total - sep.length;
      if (remaining <= 0) break;
      blocks.push(sep + truncateByChars(block, remaining));
      total += sep.length + Math.min(block.length, remaining);
      break;
    }

    blocks.push(sep + block);
    total += sep.length + block.length;
  }
  return blocks.join('');
}

async function cmdInject(args, deps = {}) {
  const query = args.query;
  if (!query) throw new Error('--query is required');

  const limit = parseIntArg(args.limit, 10);
  const minImportance = parseIntArg(args.minImportance, 0);
  const minSimilarity = parseFloatArg(getArg(args, 'minSimilarity'), 0.15);
  const minScore = parseFloatArg(getArg(args, 'minScore', 'min-score'), parseFloat(process.env.BRAINX_INJECT_MIN_SCORE || '0.25'));

  const defaultTier = process.env.BRAINX_INJECT_DEFAULT_TIER || 'warm_or_hot';

  let tierFilter = args.tier || null;
  let rows;
  const ragApi = getRag(deps);
  const started = nowMs();

  if (tierFilter) {
    rows = await ragApi.search(query, {
      limit,
      minSimilarity,
      minImportance,
      tierFilter,
      contextFilter: args.context || null
    });
  } else if (defaultTier === 'warm_or_hot') {
    const hot = await ragApi.search(query, {
      limit,
      minSimilarity,
      minImportance,
      tierFilter: 'hot',
      contextFilter: args.context || null
    });
    const warm = await ragApi.search(query, {
      limit,
      minSimilarity,
      minImportance,
      tierFilter: 'warm',
      contextFilter: args.context || null
    });
    const seen = new Set();
    rows = [];
    for (const r of [...hot, ...warm]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      rows.push(r);
      if (rows.length >= limit) break;
    }
  } else {
    rows = await ragApi.search(query, {
      limit,
      minSimilarity,
      minImportance,
      tierFilter: null,
      contextFilter: args.context || null
    });
  }

  rows = rows.filter(r => Number(r.score ?? -Infinity) >= minScore);

  const durationMs = nowMs() - started;
  const simStats = summarizeSimilarities(rows);
  await maybeLogQuery(ragApi, {
    queryHash: hashQuery(query),
    kind: 'inject',
    durationMs,
    resultsCount: rows.length,
    ...simStats
  });

  const maxCharsPerItem = parseIntArg(getArg(args, 'maxCharsPerItem', 'max-chars-per-item'), parseInt(process.env.BRAINX_INJECT_MAX_CHARS_PER_ITEM || '2000', 10));
  const maxLinesPerItem = parseIntArg(getArg(args, 'maxLinesPerItem', 'max-lines-per-item'), parseInt(process.env.BRAINX_INJECT_MAX_LINES_PER_ITEM || '80', 10));
  const maxTotalChars = parseIntArg(getArg(args, 'maxTotalChars', 'max-total-chars'), parseInt(process.env.BRAINX_INJECT_MAX_TOTAL_CHARS || '12000', 10));

  const io = getIo(deps);
  io.stdout.write(formatInject(rows, { maxCharsPerItem, maxLinesPerItem, maxTotalChars }));
}

async function cmdResolve(args, deps = {}) {
  const id = args.id || null;
  const patternKey = getArg(args, 'patternKey', 'pattern-key') || null;
  const status = getArg(args, 'status');
  if (!id && !patternKey) throw new Error('--id or --patternKey is required');
  if (!status) throw new Error('--status is required');

  const resolvedAtArg = getArg(args, 'resolvedAt', 'resolved-at');
  const promotedTo = getArg(args, 'promotedTo', 'promoted-to') || null;
  const resolutionNotes = getArg(args, 'resolutionNotes', 'resolution-notes') || null;
  const autoResolvedStatuses = new Set(['resolved', 'promoted', 'wont_fix']);
  const resolvedAt = resolvedAtArg || (autoResolvedStatuses.has(status) ? new Date().toISOString() : null);

  const dbApi = getDb(deps);
  let result;
  if (id) {
    result = await dbApi.query(
      `UPDATE brainx_memories
       SET status = $2,
           resolved_at = COALESCE($3::timestamptz, resolved_at),
           promoted_to = COALESCE($4, promoted_to),
           resolution_notes = COALESCE($5, resolution_notes)
       WHERE id = $1
       RETURNING id, pattern_key, status, resolved_at, promoted_to, resolution_notes`,
      [id, status, resolvedAt, promotedTo, resolutionNotes]
    );
  } else {
    result = await dbApi.query(
      `UPDATE brainx_memories
       SET status = $2,
           resolved_at = COALESCE($3::timestamptz, resolved_at),
           promoted_to = COALESCE($4, promoted_to),
           resolution_notes = COALESCE($5, resolution_notes)
       WHERE pattern_key = $1
       RETURNING id, pattern_key, status, resolved_at, promoted_to, resolution_notes`,
      [patternKey, status, resolvedAt, promotedTo, resolutionNotes]
    );
  }

  const targetPatternKey = patternKey || result.rows?.[0]?.pattern_key || null;
  if (targetPatternKey) {
    await dbApi.query(
      `UPDATE brainx_patterns
       SET last_status = $2,
           promoted_to = COALESCE($3, promoted_to),
           updated_at = NOW()
       WHERE pattern_key = $1`,
      [targetPatternKey, status, promotedTo]
    );
  }

  const io = getIo(deps);
  io.log(JSON.stringify({ ok: true, updated: result.rowCount ?? result.rows?.length ?? 0, rows: result.rows || [] }, null, 2));
}

async function cmdPromoteCandidates(args, deps = {}) {
  const minRecurrence = parseIntArg(getArg(args, 'minRecurrence', 'min-recurrence'), 3);
  const days = parseIntArg(args.days, 30);
  const limit = parseIntArg(args.limit, 50);
  const dbApi = getDb(deps);

  const res = await dbApi.query(
    `SELECT
       p.pattern_key,
       p.recurrence_count,
       p.first_seen,
       p.last_seen,
       p.impact_score,
       p.representative_memory_id,
       p.last_memory_id,
       p.last_category,
       p.last_status,
       p.promoted_to,
       m.content AS representative_content,
       m.tier,
       m.importance,
       m.context,
       m.agent
     FROM brainx_patterns p
     LEFT JOIN brainx_memories m ON m.id = p.representative_memory_id
     WHERE p.recurrence_count >= $1
       AND p.last_seen >= NOW() - make_interval(days => $2)
       AND COALESCE(p.last_status, 'pending') IN ('pending', 'in_progress')
       AND p.promoted_to IS NULL
     ORDER BY p.recurrence_count DESC, p.impact_score DESC NULLS LAST, p.last_seen DESC
     LIMIT $3`,
    [minRecurrence, days, limit]
  );

  const payload = {
    ok: true,
    thresholds: { minRecurrence, days },
    count: res.rows.length,
    results: res.rows
  };

  const io = getIo(deps);
  io.log(JSON.stringify(payload, null, 2));
}

async function cmdMetrics(args, deps = {}) {
  const days = parseIntArg(args.days, 30);
  const topPatterns = parseIntArg(getArg(args, 'topPatterns', 'top-patterns'), 10);
  const dbApi = getDb(deps);

  const [statusCounts, categoryCounts, tierCounts, topPatternRows, queryPerf] = await Promise.all([
    dbApi.query(`SELECT COALESCE(status, 'unknown') AS key, COUNT(*)::int AS count FROM brainx_memories GROUP BY 1 ORDER BY 2 DESC, 1 ASC`),
    dbApi.query(`SELECT COALESCE(category, 'uncategorized') AS key, COUNT(*)::int AS count FROM brainx_memories GROUP BY 1 ORDER BY 2 DESC, 1 ASC`),
    dbApi.query(`SELECT COALESCE(tier, 'unknown') AS key, COUNT(*)::int AS count FROM brainx_memories GROUP BY 1 ORDER BY 2 DESC, 1 ASC`),
    dbApi.query(
      `SELECT pattern_key, recurrence_count, first_seen, last_seen, impact_score, last_status, promoted_to
       FROM brainx_patterns
       ORDER BY recurrence_count DESC, impact_score DESC NULLS LAST, last_seen DESC
       LIMIT $1`,
      [topPatterns]
    ),
    dbApi.query(
      `SELECT
         query_kind,
         COUNT(*)::int AS calls,
         ROUND(AVG(duration_ms)::numeric, 2) AS avg_duration_ms,
         ROUND(AVG(results_count)::numeric, 2) AS avg_results_count,
         ROUND(AVG(avg_similarity)::numeric, 4) AS avg_similarity,
         ROUND(AVG(top_similarity)::numeric, 4) AS avg_top_similarity
       FROM brainx_query_log
       WHERE created_at >= NOW() - make_interval(days => $1)
       GROUP BY query_kind
       ORDER BY query_kind`,
      [days]
    ).catch(() => ({ rows: [] }))
  ]);

  const payload = {
    ok: true,
    window_days: days,
    counts: {
      by_status: statusCounts.rows,
      by_category: categoryCounts.rows,
      by_tier: tierCounts.rows
    },
    top_recurring_patterns: topPatternRows.rows,
    query_performance: queryPerf.rows
  };

  const io = getIo(deps);
  io.log(JSON.stringify(payload, null, 2));
}

async function cmdFact(args, deps = {}) {
  // Shortcut: brainx fact --content "..." → add --type fact --tier hot --category infrastructure
  const content = args.content;
  if (!content) throw new Error('--content is required');
  return cmdAdd({
    ...args,
    type: 'fact',
    tier: args.tier || 'hot',
    importance: args.importance || '8',
    category: args.category || 'infrastructure',
    context: args.context || 'project:global',
  }, deps);
}

async function cmdFacts(args, deps = {}) {
  const dbApi = getDb(deps);
  const limit = parseIntArg(args.limit, 30);
  const contextFilter = args.context || null;

  let sql = `
    SELECT id, content, tier, importance, context, category, tags, created_at, last_seen
    FROM brainx_memories
    WHERE type = 'fact'
      AND superseded_by IS NULL
  `;
  const params = [];
  let i = 1;

  if (contextFilter) {
    sql += ` AND context = $${i}`;
    params.push(contextFilter);
    i++;
  }

  sql += ` ORDER BY importance DESC, last_seen DESC NULLS LAST LIMIT $${i}`;
  params.push(limit);

  const res = await dbApi.query(sql, params);
  const io = getIo(deps);
  io.log(JSON.stringify({ ok: true, count: res.rows.length, facts: res.rows }, null, 2));
}

async function cmdLifecycleRun(args, deps = {}) {
  const dbApi = getDb(deps);
  const promoteMinRecurrence = parseIntArg(getArg(args, 'promoteMinRecurrence', 'promote-min-recurrence'), parseInt(process.env.BRAINX_LIFECYCLE_PROMOTE_MIN_RECURRENCE || '3', 10));
  const promoteDays = parseIntArg(getArg(args, 'promoteDays', 'promote-days'), parseInt(process.env.BRAINX_LIFECYCLE_PROMOTE_DAYS || '30', 10));
  const degradeDays = parseIntArg(getArg(args, 'degradeDays', 'degrade-days'), parseInt(process.env.BRAINX_LIFECYCLE_DEGRADE_DAYS || '45', 10));
  const lowImportanceMax = parseIntArg(getArg(args, 'lowImportanceMax', 'low-importance-max'), parseInt(process.env.BRAINX_LIFECYCLE_LOW_IMPORTANCE_MAX || '3', 10));
  const lowAccessMax = parseIntArg(getArg(args, 'lowAccessMax', 'low-access-max'), parseInt(process.env.BRAINX_LIFECYCLE_LOW_ACCESS_MAX || '1', 10));
  const dryRun = !!getArg(args, 'dryRun', 'dry-run');

  const promotedPreview = await dbApi.query(
    `SELECT id, pattern_key, status, recurrence_count, last_seen, access_count, importance
     FROM brainx_memories
     WHERE COALESCE(status, 'pending') IN ('pending', 'in_progress')
       AND recurrence_count >= $1
       AND last_seen >= NOW() - make_interval(days => $2)`,
    [promoteMinRecurrence, promoteDays]
  );

  const degradedPreview = await dbApi.query(
    `SELECT id, pattern_key, status, recurrence_count, last_seen, access_count, importance
     FROM brainx_memories
     WHERE COALESCE(status, 'pending') IN ('pending', 'in_progress')
       AND last_seen < NOW() - make_interval(days => $1)`,
    [degradeDays]
  );

  let promoted = { rowCount: 0, rows: [] };
  let degraded = { rowCount: 0, rows: [] };
  if (!dryRun) {
    promoted = await dbApi.query(
      `UPDATE brainx_memories
       SET status = 'promoted',
           resolved_at = COALESCE(resolved_at, NOW())
       WHERE id IN (
         SELECT id
         FROM brainx_memories
         WHERE COALESCE(status, 'pending') IN ('pending', 'in_progress')
           AND recurrence_count >= $1
           AND last_seen >= NOW() - make_interval(days => $2)
       )
       RETURNING id, pattern_key, status, recurrence_count, last_seen, access_count, importance`,
      [promoteMinRecurrence, promoteDays]
    );

    degraded = await dbApi.query(
      `UPDATE brainx_memories
       SET status = CASE
             WHEN COALESCE(importance, 5) <= $2 AND COALESCE(access_count, 0) <= $3 THEN 'wont_fix'
             ELSE 'pending'
           END,
           resolved_at = CASE
             WHEN COALESCE(importance, 5) <= $2 AND COALESCE(access_count, 0) <= $3 THEN COALESCE(resolved_at, NOW())
             ELSE resolved_at
           END
       WHERE id IN (
         SELECT id
         FROM brainx_memories
         WHERE COALESCE(status, 'pending') IN ('pending', 'in_progress')
           AND last_seen < NOW() - make_interval(days => $1)
       )
       RETURNING id, pattern_key, status, recurrence_count, last_seen, access_count, importance`,
      [degradeDays, lowImportanceMax, lowAccessMax]
    );

    const affectedPatternKeys = Array.from(new Set(
      [...(promoted.rows || []), ...(degraded.rows || [])]
        .map((r) => r.pattern_key)
        .filter(Boolean)
    ));
    if (affectedPatternKeys.length) {
      await dbApi.query(
        `UPDATE brainx_patterns p
         SET recurrence_count = agg.recurrence_count,
             first_seen = agg.first_seen,
             last_seen = agg.last_seen,
             last_status = agg.last_status,
             promoted_to = COALESCE(p.promoted_to, agg.promoted_to),
             updated_at = NOW()
         FROM (
           SELECT pattern_key,
                  MAX(recurrence_count) AS recurrence_count,
                  MIN(first_seen) AS first_seen,
                  MAX(last_seen) AS last_seen,
                  (ARRAY_AGG(status ORDER BY last_seen DESC NULLS LAST, created_at DESC))[1] AS last_status,
                  (ARRAY_AGG(promoted_to ORDER BY last_seen DESC NULLS LAST, created_at DESC))[1] AS promoted_to
           FROM brainx_memories
           WHERE pattern_key = ANY($1)
           GROUP BY pattern_key
         ) agg
         WHERE p.pattern_key = agg.pattern_key`,
        [affectedPatternKeys]
      );
    }
  }

  const io = getIo(deps);
  io.log(JSON.stringify({
    ok: true,
    dry_run: dryRun,
    thresholds: { promoteMinRecurrence, promoteDays, degradeDays, lowImportanceMax, lowAccessMax },
    candidates: { promote: promotedPreview.rows || [], degrade: degradedPreview.rows || [] },
    updated: dryRun ? { promoted: 0, degraded: 0 } : { promoted: promoted.rowCount || 0, degraded: degraded.rowCount || 0 },
    results: dryRun ? null : { promoted: promoted.rows || [], degraded: degraded.rows || [] }
  }, null, 2));
}

async function main(argvIn = process.argv.slice(2), deps = {}) {
  const argv = argvIn;
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!cmd || cmd === '--help' || cmd === '-h') {
    usage();
    return 0;
  }

  if (cmd === 'health') return cmdHealth(args, deps);
  if (cmd === 'add') return cmdAdd(args, deps);
  if (cmd === 'fact') return cmdFact(args, deps);
  if (cmd === 'facts') return cmdFacts(args, deps);
  if (cmd === 'search') return cmdSearch(args, deps);
  if (cmd === 'inject') return cmdInject(args, deps);
  if (cmd === 'resolve') return cmdResolve(args, deps);
  if (cmd === 'promote-candidates') return cmdPromoteCandidates(args, deps);
  if (cmd === 'lifecycle-run') return cmdLifecycleRun(args, deps);
  if (cmd === 'metrics') return cmdMetrics(args, deps);

  throw new Error(`Unknown command: ${cmd}`);
}

module.exports = {
  usage,
  parseArgs,
  formatInject,
  hashQuery,
  summarizeSimilarities,
  cmdHealth,
  cmdAdd,
  cmdSearch,
  cmdInject,
  cmdResolve,
  cmdPromoteCandidates,
  cmdLifecycleRun,
  cmdMetrics,
  main
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
