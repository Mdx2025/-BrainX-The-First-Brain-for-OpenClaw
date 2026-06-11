const db = require('./db');
const { embed } = require('./embedding-client');
// BRAINX_COST_TRACKING_20260608
const { withCostContext } = require('./cost-tracker');
const {
  getPhase2Config,
  getQualityGateConfig,
  shouldScrubForContext,
  scrubTextPII,
  mergeTagsWithMetadata,
  deriveSensitivity,
  getAllowedSensitivities,
  deriveMergePlan,
  assessMemoryQuality
} = require('./brainx-phase2');

function normalizeLifecycle(memory = {}) {
  const now = new Date();
  const firstSeen = memory.first_seen || memory.firstSeen || null;
  const lastSeen = memory.last_seen || memory.lastSeen || null;
  const resolvedAt = memory.resolved_at || memory.resolvedAt || null;

  return {
    status: memory.status || 'pending',
    category: memory.category || null,
    pattern_key: memory.pattern_key || memory.patternKey || null,
    recurrence_count: memory.recurrence_count ?? memory.recurrenceCount ?? null,
    first_seen: firstSeen ? new Date(firstSeen) : null,
    last_seen: lastSeen ? new Date(lastSeen) : null,
    resolved_at: resolvedAt ? new Date(resolvedAt) : null,
    promoted_to: memory.promoted_to || memory.promotedTo || null,
    resolution_notes: memory.resolution_notes || memory.resolutionNotes || null,
    _now: now
  };
}

function tierImpact(tier) {
  switch (tier) {
    case 'hot': return 1.0;
    case 'warm': return 0.7;
    case 'cold': return 0.4;
    case 'archive': return 0.2;
    default: return 0.5;
  }
}

function deriveVerificationState(memory = {}) {
  const explicit = memory.verification_state || memory.verificationState || null;
  if (explicit) return explicit;

  const type = memory.type || 'note';
  const sourceKind = memory.source_kind || memory.sourceKind || null;
  const category = memory.category || null;
  const confidence = Number(memory.confidence_score ?? memory.confidenceScore ?? 0.7);

  if (memory.superseded_by || memory.status === 'wont_fix') return 'obsolete';

  if (
    ['consolidated', 'tool_verified', 'regex_extraction'].includes(sourceKind) &&
    ['fact', 'decision', 'gotcha'].includes(type)
  ) {
    return 'verified';
  }

  if (
    sourceKind === 'knowledge_canonical' &&
    ['fact', 'decision', 'gotcha'].includes(type)
  ) {
    return 'verified';
  }

  if (
    ['knowledge_staging', 'knowledge_generated'].includes(sourceKind)
  ) {
    return 'hypothesis';
  }

  if (
    sourceKind === 'llm_distilled' &&
    ['fact', 'decision', 'gotcha'].includes(type) &&
    confidence >= 0.85
  ) {
    return 'verified';
  }

  if (type === 'note') return 'changelog';
  if (sourceKind === 'markdown_import') return 'changelog';
  if (sourceKind === 'agent_inference' && ['error', 'infrastructure', 'best_practice'].includes(category || '')) {
    return 'changelog';
  }

  return 'hypothesis';
}

async function upsertPatternRecord(client, memory) {
  if (!memory.pattern_key) return;

  const impactScore = Number(memory.importance ?? 5) * tierImpact(memory.tier);
  await client.query(
    `INSERT INTO brainx_patterns (
       pattern_key, recurrence_count, first_seen, last_seen, impact_score,
       representative_memory_id, last_memory_id, last_category, last_status, promoted_to, updated_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
     ON CONFLICT (pattern_key) DO UPDATE SET
       recurrence_count = GREATEST(brainx_patterns.recurrence_count, EXCLUDED.recurrence_count),
       first_seen = LEAST(brainx_patterns.first_seen, EXCLUDED.first_seen),
       last_seen = GREATEST(brainx_patterns.last_seen, EXCLUDED.last_seen),
       impact_score = GREATEST(brainx_patterns.impact_score, EXCLUDED.impact_score),
       representative_memory_id = COALESCE(brainx_patterns.representative_memory_id, EXCLUDED.representative_memory_id),
       last_memory_id = EXCLUDED.last_memory_id,
       last_category = COALESCE(EXCLUDED.last_category, brainx_patterns.last_category),
       last_status = COALESCE(EXCLUDED.last_status, brainx_patterns.last_status),
       promoted_to = COALESCE(EXCLUDED.promoted_to, brainx_patterns.promoted_to),
       updated_at = NOW()`,
    [
      memory.pattern_key,
      memory.recurrence_count,
      memory.first_seen,
      memory.last_seen,
      impactScore,
      memory.id,
      memory.id,
      memory.category || null,
      memory.status || null,
      memory.promoted_to || null
    ]
  );
}

async function storeMemoryWithClient(client, memory, options = {}) {
  const qualityCfg = getQualityGateConfig();
  const quality = assessMemoryQuality(memory, qualityCfg);
  if (quality.action === 'skip') {
    const msg = `Quality gate: ${quality.reason} (${quality.reasons.join(', ') || 'no details'})`;
    if (qualityCfg.strict) throw new Error(msg);
    console.warn(`⚠️  ${msg} — skipping`);
    return { id: null, skipped: true, reason: quality.reason, quality };
  }

  let effectiveImportance = Number(memory.importance ?? 5);
  if (!Number.isFinite(effectiveImportance)) effectiveImportance = 5;
  let effectiveConfidenceScore = memory.confidence_score ?? memory.confidenceScore ?? 0.7;
  if (quality.action === 'downgrade') {
    const msg = `Quality gate: ${quality.reason} (${quality.reasons.join(', ') || 'borderline'})`;
    if (qualityCfg.strict) throw new Error(msg);
    console.warn(`⚠️  ${msg} — storing with reduced importance/confidence`);
    effectiveImportance = Math.min(effectiveImportance, 2);
    const numericConfidence = Number(effectiveConfidenceScore);
    effectiveConfidenceScore = Number.isFinite(numericConfidence)
      ? Math.min(numericConfidence, 0.45)
      : 0.45;
  }

  const cfg = getPhase2Config();
  const lifecycle = normalizeLifecycle(memory);
  const piiEnabledForContext = shouldScrubForContext(memory.context, cfg);
  const scrubbedContent = scrubTextPII(memory.content, {
    enabled: piiEnabledForContext,
    replacement: cfg.piiScrubReplacement
  });
  const scrubbedContext = scrubTextPII(memory.context || '', {
    enabled: piiEnabledForContext,
    replacement: cfg.piiScrubReplacement
  });
  const redactionReasons = Array.from(new Set([...(scrubbedContent.reasons || []), ...(scrubbedContext.reasons || [])]));
  const redactionMeta = { redacted: redactionReasons.length > 0, reasons: redactionReasons };
  const storedContent = scrubbedContent.text;
  const storedContext = memory.context == null ? null : scrubbedContext.text;
  const baseTags = Array.isArray(memory.tags) ? memory.tags : [];
  const qualityTags = Array.isArray(quality.tags) ? quality.tags : [];
  const storedTags = mergeTagsWithMetadata([...baseTags, ...qualityTags], redactionMeta);
  const embedding = await withCostContext(
    { operation_type: 'embedding_add', call_site: 'openai-rag.js:storeMemory' },
    () => embed(`${memory.type}: ${storedContent} [context: ${storedContext || ''}]`)
  );

  let finalId = memory.id;
  let finalRecurrence = lifecycle.recurrence_count;
  let finalFirstSeen = lifecycle.first_seen;
  let finalLastSeen = lifecycle.last_seen;
  let mergeSource = null;

  if (!options.skipDedupe) {
    if (lifecycle.pattern_key) {
      const existing = await client.query(
        `SELECT id, recurrence_count, first_seen, last_seen
         FROM brainx_memories
         WHERE pattern_key = $1
         ORDER BY last_seen DESC NULLS LAST, created_at DESC
         LIMIT 1`,
        [lifecycle.pattern_key]
      );

      const plan = deriveMergePlan(existing.rows[0], lifecycle, lifecycle._now);
      if (plan.found) {
        finalId = plan.finalId;
        finalRecurrence = plan.finalRecurrence;
        finalFirstSeen = plan.finalFirstSeen;
        finalLastSeen = plan.finalLastSeen;
        mergeSource = 'pattern_key';
      } else {
        finalRecurrence = plan.finalRecurrence;
        finalFirstSeen = plan.finalFirstSeen;
        finalLastSeen = plan.finalLastSeen;
      }
    } else {
      const semantic = await client.query(
        `SELECT id, recurrence_count, first_seen, last_seen,
                1 - (embedding <=> $1::vector) AS similarity
         FROM brainx_memories
         WHERE superseded_by IS NULL
           AND created_at >= NOW() - make_interval(days => $2)
           AND (($3::text IS NULL AND context IS NULL) OR context = $3)
           AND (($4::text IS NULL AND category IS NULL) OR category = $4)
         ORDER BY similarity DESC, last_seen DESC NULLS LAST, created_at DESC
         LIMIT 1`,
        [JSON.stringify(embedding), cfg.dedupeRecentDays, storedContext, lifecycle.category]
      );
      const candidate = semantic.rows[0];
      const candidateOk = candidate && Number(candidate.similarity || 0) >= cfg.dedupeSimThreshold;
      const plan = deriveMergePlan(candidateOk ? candidate : null, lifecycle, lifecycle._now);
      finalRecurrence = plan.finalRecurrence;
      finalFirstSeen = plan.finalFirstSeen;
      finalLastSeen = plan.finalLastSeen;
      if (plan.found) {
        finalId = plan.finalId;
        mergeSource = 'semantic';
      }
    }
  } else {
    finalRecurrence = finalRecurrence || 1;
    finalFirstSeen = finalFirstSeen || lifecycle._now;
    finalLastSeen = finalLastSeen || lifecycle._now;
  }

  const resolvedAt = lifecycle.resolved_at || null;

  // V5 provenance fields — use memory value or DB default
  const sourceKind = memory.source_kind || memory.sourceKind || 'agent_inference';
  const sourcePath = memory.source_path || memory.sourcePath || null;
  const confidenceScore = effectiveConfidenceScore;
  const expiresAt = memory.expires_at || memory.expiresAt || null;
  const sensitivity = deriveSensitivity({
    explicit: memory.sensitivity,
    content: storedContent,
    context: storedContext,
    tags: storedTags,
    redactionMeta
  });
  const verificationState = deriveVerificationState(memory);

  await client.query(
    `INSERT INTO brainx_memories (
       id, type, content, context, tier, agent, importance, embedding, tags,
       status, category, pattern_key, recurrence_count, first_seen, last_seen,
       resolved_at, promoted_to, resolution_notes,
       source_kind, source_path, confidence_score, expires_at, sensitivity, verification_state
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
     ON CONFLICT (id) DO UPDATE SET
       type=EXCLUDED.type,
       content=EXCLUDED.content,
       context=EXCLUDED.context,
       tier=EXCLUDED.tier,
       agent=EXCLUDED.agent,
       importance=EXCLUDED.importance,
       embedding=EXCLUDED.embedding,
       tags=EXCLUDED.tags,
       status=EXCLUDED.status,
       category=EXCLUDED.category,
       pattern_key=COALESCE(EXCLUDED.pattern_key, brainx_memories.pattern_key),
       recurrence_count=GREATEST(brainx_memories.recurrence_count, EXCLUDED.recurrence_count),
       first_seen=LEAST(brainx_memories.first_seen, EXCLUDED.first_seen),
       last_seen=GREATEST(brainx_memories.last_seen, EXCLUDED.last_seen),
       resolved_at=COALESCE(EXCLUDED.resolved_at, brainx_memories.resolved_at),
       promoted_to=COALESCE(EXCLUDED.promoted_to, brainx_memories.promoted_to),
       resolution_notes=COALESCE(EXCLUDED.resolution_notes, brainx_memories.resolution_notes),
       source_kind=COALESCE(EXCLUDED.source_kind, brainx_memories.source_kind),
       source_path=COALESCE(EXCLUDED.source_path, brainx_memories.source_path),
       confidence_score=COALESCE(EXCLUDED.confidence_score, brainx_memories.confidence_score),
       expires_at=COALESCE(EXCLUDED.expires_at, brainx_memories.expires_at),
       sensitivity=COALESCE(EXCLUDED.sensitivity, brainx_memories.sensitivity),
       verification_state=COALESCE(EXCLUDED.verification_state, brainx_memories.verification_state)`,
    [
      finalId,
      memory.type,
      storedContent,
      storedContext,
      memory.tier || 'warm',
      memory.agent || null,
      effectiveImportance,
      JSON.stringify(embedding),
      storedTags,
      lifecycle.status,
      lifecycle.category,
      lifecycle.pattern_key,
      finalRecurrence,
      finalFirstSeen,
      finalLastSeen,
      resolvedAt,
      lifecycle.promoted_to,
      lifecycle.resolution_notes,
      sourceKind,
      sourcePath,
      confidenceScore !== null && confidenceScore !== undefined ? confidenceScore : null,
      expiresAt ? new Date(expiresAt) : null,
      sensitivity,
      verificationState
    ]
  );

  await upsertPatternRecord(client, {
    ...memory,
    content: storedContent,
    context: storedContext,
    tags: storedTags,
    importance: effectiveImportance,
    id: finalId,
    status: lifecycle.status,
    category: lifecycle.category,
    pattern_key: lifecycle.pattern_key,
    recurrence_count: finalRecurrence,
    first_seen: finalFirstSeen,
    last_seen: finalLastSeen,
    promoted_to: lifecycle.promoted_to
  });

  return {
    id: finalId,
    pattern_key: lifecycle.pattern_key,
    recurrence_count: finalRecurrence,
    pii_scrub_applied: piiEnabledForContext,
    redacted: redactionMeta.redacted,
    redaction_reasons: redactionMeta.reasons,
    quality_action: quality.action,
    quality_reason: quality.reason,
    quality_score: quality.score,
    quality_reasons: quality.reasons,
    dedupe_merged: !!mergeSource,
    dedupe_method: mergeSource
  };
}

async function storeMemory(memory, options = {}) {
  return db.withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await storeMemoryWithClient(client, memory, options);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

// Default scoring weights — can be overridden per-agent via options.weights
const DEFAULT_WEIGHTS = {
  relevance: 0.48,   // cosine similarity
  importance: 0.14,  // normalized importance (0-1)
  recency: 0.10,     // exponential decay: exp(-days/30)
  tier: 0.04,        // tier bonus (hot=1, warm=0.7, cold=0.4, archive=0.2)
  feedback: 0.03,    // feedback_score
  confidence: 0.09,  // confidence_score
  provenance: 0.10,  // source_kind reliability
  typeSafety: 0.04,  // fact/decision/gotcha favored over learning/note
  verification: 0.14 // verified memories strongly preferred over hypothesis/changelog
};

// BRAINX_SEARCH_TWO_STAGE_HNSW_RERANK_20260606:
// Feature-flagged search path that lets pgvector/HNSW pick vector-nearest
// candidates first, then preserves the existing weighted rerank on that pool.
// Set BRAINX_SEARCH_TWO_STAGE=0 to roll back to the legacy full weighted scan.
const TWO_STAGE_SEARCH_MARKER = 'BRAINX_SEARCH_TWO_STAGE_HNSW_RERANK_20260606';
const TWO_STAGE_DEFAULT_ENABLED = true;
const TWO_STAGE_DEFAULT_MIN_CANDIDATES = 40;
const TWO_STAGE_DEFAULT_MULTIPLIER = 2;
const TWO_STAGE_DEFAULT_MAX_CANDIDATES = 400;
const TWO_STAGE_DEFAULT_SET_EF_SEARCH = true;

function envFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled', 'two_stage', 'hnsw'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled', 'legacy'].includes(normalized)) return false;
  return fallback;
}

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeWeights(weights) {
  const out = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    out[key] = finiteNumber(out[key], DEFAULT_WEIGHTS[key]);
  }
  return out;
}

function useTwoStageSearch(options = {}) {
  if (options.twoStageSearch !== undefined) return envFlag(options.twoStageSearch, TWO_STAGE_DEFAULT_ENABLED);
  if (options.searchStrategy !== undefined) {
    const strategy = String(options.searchStrategy || '').trim().toLowerCase();
    if (['legacy', 'weighted_scan', 'full_scan'].includes(strategy)) return false;
    if (['two_stage', 'hnsw', 'hnsw_rerank'].includes(strategy)) return true;
  }
  return envFlag(process.env.BRAINX_SEARCH_TWO_STAGE, TWO_STAGE_DEFAULT_ENABLED);
}

function twoStageCandidateLimit(limit, options = {}) {
  const explicit = options.twoStageCandidateLimit ?? options.candidateLimit ?? process.env.BRAINX_SEARCH_TWO_STAGE_CANDIDATES;
  const parsedExplicit = Number.parseInt(String(explicit ?? ''), 10);
  if (Number.isFinite(parsedExplicit) && parsedExplicit > 0) return parsedExplicit;

  const minCandidates = Math.max(1, Number.parseInt(process.env.BRAINX_SEARCH_TWO_STAGE_MIN_CANDIDATES || '', 10) || TWO_STAGE_DEFAULT_MIN_CANDIDATES);
  const multiplier = Math.max(1, Number.parseInt(process.env.BRAINX_SEARCH_TWO_STAGE_MULTIPLIER || '', 10) || TWO_STAGE_DEFAULT_MULTIPLIER);
  const maxCandidates = Math.max(minCandidates, Number.parseInt(process.env.BRAINX_SEARCH_TWO_STAGE_MAX_CANDIDATES || '', 10) || TWO_STAGE_DEFAULT_MAX_CANDIDATES);
  return Math.min(maxCandidates, Math.max(minCandidates, Math.max(1, limit) * multiplier));
}

function twoStageEfSearch(candidateLimit, options = {}) {
  const shouldSet = options.twoStageSetEfSearch !== undefined
    ? envFlag(options.twoStageSetEfSearch, TWO_STAGE_DEFAULT_SET_EF_SEARCH)
    : envFlag(process.env.BRAINX_SEARCH_TWO_STAGE_SET_EF_SEARCH, TWO_STAGE_DEFAULT_SET_EF_SEARCH);
  if (!shouldSet) return 0;

  const explicit = options.twoStageEfSearch ?? process.env.BRAINX_SEARCH_TWO_STAGE_EF_SEARCH;
  const parsedExplicit = Number.parseInt(String(explicit ?? ''), 10);
  const requested = Number.isFinite(parsedExplicit) && parsedExplicit > 0
    ? parsedExplicit
    : candidateLimit;
  return Math.min(1000, Math.max(40, requested));
}

async function queryWithOptionalHnswEfSearch(sql, params, efSearch) {
  if (!efSearch) return db.query(sql, params);

  let setSucceeded = false;
  return db.withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL hnsw.ef_search = ${Math.trunc(efSearch)}`);
      setSucceeded = true;
      const result = await client.query(sql, params);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (!setSucceeded && /unrecognized configuration parameter/i.test(String(err?.message || err))) {
        return db.query(sql, params);
      }
      throw err;
    }
  });
}

function col(name, alias = '') {
  return alias ? `${alias}.${name}` : name;
}

function memorySelectColumns(alias = '') {
  return [
    'id', 'type', 'content', 'context', 'tier', 'agent', 'importance', 'tags',
    'created_at', 'last_accessed', 'access_count', 'source_session', 'superseded_by',
    'status', 'category', 'pattern_key', 'recurrence_count', 'first_seen', 'last_seen',
    'resolved_at', 'promoted_to', 'resolution_notes', 'source_kind', 'source_path',
    'confidence_score', 'expires_at', 'sensitivity', 'verification_state'
  ].map((name) => col(name, alias)).join(', ');
}

function weightedScoreSql(w, alias = '') {
  return `
      1 - (${col('embedding', alias)} <=> $1::vector) AS similarity,
      (
        -- Weighted composite score (ByteRover-inspired, BrainX V5.1)
        (1 - (${col('embedding', alias)} <=> $1::vector)) * ${w.relevance}
        + (LEAST(GREATEST(${col('importance', alias)},0),10)::float / 10.0) * ${w.importance}
        + EXP(-1.0 * EXTRACT(EPOCH FROM (NOW() - COALESCE(${col('last_accessed', alias)}, ${col('created_at', alias)}))) / 86400.0 / 30.0) * ${w.recency}
        + (CASE ${col('tier', alias)}
            WHEN 'hot' THEN 1.0
            WHEN 'warm' THEN 0.7
            WHEN 'cold' THEN 0.4
            WHEN 'archive' THEN 0.2
            ELSE 0.5
          END) * ${w.tier}
        + LEAST(GREATEST(COALESCE(${col('feedback_score', alias)}, 0), -3), 3)::float / 3.0 * ${w.feedback}
        + COALESCE(${col('confidence_score', alias)}, 0.7)::float * ${w.confidence}
        + (CASE ${col('source_kind', alias)}
            WHEN 'knowledge_canonical' THEN 1.00
            WHEN 'tool_verified' THEN 0.92
            WHEN 'user_explicit' THEN 0.88
            WHEN 'consolidated' THEN 0.82
            WHEN 'llm_distilled' THEN 0.55
            WHEN 'knowledge_staging' THEN 0.35
            WHEN 'knowledge_generated' THEN 0.30
            WHEN 'agent_inference' THEN 0.10
            WHEN 'markdown_import' THEN 0.08
            ELSE 0.20
          END) * ${w.provenance}
        + (CASE ${col('type', alias)}
            WHEN 'fact' THEN 1.0
            WHEN 'decision' THEN 0.95
            WHEN 'gotcha' THEN 0.90
            WHEN 'learning' THEN 0.35
            WHEN 'note' THEN 0.10
            ELSE 0.20
          END) * ${w.typeSafety}
        + (CASE COALESCE(${col('verification_state', alias)}, 'hypothesis')
            WHEN 'verified' THEN 1.0
            WHEN 'hypothesis' THEN 0.20
            WHEN 'changelog' THEN 0.05
            WHEN 'obsolete' THEN -1.0
            ELSE 0.15
          END) * ${w.verification}
      ) AS score
  `;
}

function baseSearchWhere(alias = '') {
  return `
    WHERE ${col('importance', alias)} >= $2
      AND ${col('superseded_by', alias)} IS NULL
      AND COALESCE(${col('verification_state', alias)}, 'hypothesis') != 'obsolete'
      AND COALESCE(${col('status', alias)}, 'pending') NOT IN ('resolved', 'wont_fix')
      AND (${col('expires_at', alias)} IS NULL OR ${col('expires_at', alias)} > NOW())
      AND ${col('embedding', alias)} IS NOT NULL
  `;
}

function appendSearchFilters(sql, params, startIndex, options = {}, alias = '') {
  const { tierFilter, excludeTiers, contextFilter, maxSensitivity } = options;
  let i = startIndex;
  let nextSql = sql;

  if (tierFilter) {
    nextSql += ` AND ${col('tier', alias)} = $${i}`;
    params.push(tierFilter);
    i++;
  } else if (Array.isArray(excludeTiers) && excludeTiers.length > 0) {
    nextSql += ` AND NOT (${col('tier', alias)} = ANY($${i}::text[]))`;
    params.push(excludeTiers);
    i++;
  }
  if (contextFilter) {
    nextSql += ` AND ${col('context', alias)} = $${i}`;
    params.push(contextFilter);
    i++;
  }
  nextSql += ` AND COALESCE(${col('sensitivity', alias)}, 'normal') = ANY($${i}::text[])`;
  params.push(getAllowedSensitivities(maxSensitivity));
  i++;

  return { sql: nextSql, nextIndex: i };
}

async function search(query, options = {}) {
  const {
    limit = 10,
    minImportance = 0,
    tierFilter = null,
    excludeTiers = ['archive'],
    contextFilter = null,
    minSimilarity = 0.3,
    maxSensitivity = process.env.BRAINX_MAX_SENSITIVITY || 'normal',
    weights = null        // per-agent weight overrides: { relevance, importance, recency, ... }
  } = options;

  const w = normalizeWeights(weights);

  const queryEmbedding = await withCostContext(
    { operation_type: 'embedding_search', call_site: 'openai-rag.js:search' },
    () => embed(query)
  );

  const params = [JSON.stringify(queryEmbedding), minImportance];
  let sql;
  let i = 3;
  const filterOptions = { tierFilter, excludeTiers, contextFilter, maxSensitivity };
  let hnswEfSearch = 0;

  if (useTwoStageSearch(options)) {
    const candidateLimit = twoStageCandidateLimit(limit, options);
    hnswEfSearch = twoStageEfSearch(candidateLimit, options);
    let whereSql = baseSearchWhere('m');
    ({ sql: whereSql, nextIndex: i } = appendSearchFilters(whereSql, params, i, filterOptions, 'm'));

    const limitParam = i;
    params.push(limit);
    i++;
    const candidateLimitParam = i;
    params.push(candidateLimit);

    sql = `
      WITH vector_candidates AS MATERIALIZED (
        SELECT id
        FROM brainx_memories
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $${candidateLimitParam}
      )
      SELECT ${memorySelectColumns('m')}, ${weightedScoreSql(w, 'm')}
      FROM vector_candidates vc
      JOIN LATERAL (
        SELECT *
        FROM brainx_memories m
        ${whereSql}
          AND m.id = vc.id
      ) m ON true
      ORDER BY score DESC, similarity DESC
      LIMIT $${limitParam}
    `;
  } else {
    let whereSql = baseSearchWhere();
    ({ sql: whereSql, nextIndex: i } = appendSearchFilters(whereSql, params, i, filterOptions));
    sql = `
      SELECT ${memorySelectColumns()}, ${weightedScoreSql(w)}
      FROM brainx_memories
      ${whereSql}
      ORDER BY score DESC, similarity DESC
      LIMIT $${i}
    `;
    params.push(limit);
  }

  const results = await queryWithOptionalHnswEfSearch(sql, params, hnswEfSearch);

  const filtered = results.rows.filter(r => (r.similarity ?? 0) >= minSimilarity);

  const ids = filtered.map(r => r.id);
  if (ids.length) {
    await db.query(
      `UPDATE brainx_memories
       SET last_accessed = NOW(), access_count = access_count + 1
       WHERE id = ANY($1)`,
      [ids]
    );
  }

  // PII scrub on search results (defense-in-depth)
  const cfg = getPhase2Config();
  for (const row of filtered) {
    if (row.content) {
      const scrubbed = scrubTextPII(row.content, { enabled: true, replacement: cfg.piiScrubReplacement });
      row.content = scrubbed.text || scrubbed;
    }
    if (row.context) {
      const scrubbed = scrubTextPII(row.context, { enabled: true, replacement: cfg.piiScrubReplacement });
      row.context = scrubbed.text || scrubbed;
    }
  }

  return filtered;
}

async function logQueryEvent(event) {
  const {
    queryHash,
    kind = 'search',
    durationMs = null,
    resultsCount = null,
    avgSimilarity = null,
    topSimilarity = null,
    // AGENT_ATTRIBUTION_20260601: persist which agent issued the recall so
    // recall-health can detect per-agent regressions (e.g. one agent's inject
    // going empty) instead of only the aggregate. Null when unknown.
    agent = null
  } = event || {};
  if (!queryHash) return;

  try {
    await db.query(
      `INSERT INTO brainx_query_log (query_hash, query_kind, duration_ms, results_count, avg_similarity, top_similarity, agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [queryHash, kind, durationMs, resultsCount, avgSimilarity, topSimilarity, agent]
    );
  } catch (_) {
    // Logging must never break search/inject CLI flows.
  }
}

module.exports = {
  embed,
  storeMemory,
  storeMemoryWithClient,
  search,
  logQueryEvent,
  DEFAULT_WEIGHTS,
  TWO_STAGE_SEARCH_MARKER
};
