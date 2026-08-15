const db = require('./db');
const { embed } = require('./embedding-client');
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
  const embedding = await embed(`${memory.type}: ${storedContent} [context: ${storedContext || ''}]`);

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
      // BRAINX_DEDUP_NULL_EMBED_GUARD_20260702: rows with a NULL active-column embedding
      // yield similarity NULL, and ORDER BY similarity DESC puts NULLS FIRST in Postgres —
      // so ONE such row (handoff_* writers) poisoned the LIMIT 1 candidate and dedup
      // silently never merged. Active since the 06-29 provider switch (embedding_v2).
      const semantic = await client.query(
        `SELECT id, recurrence_count, first_seen, last_seen,
                1 - (embedding <=> $1::vector) AS similarity
         FROM brainx_memories
         WHERE superseded_by IS NULL
           AND ${recallCalibration.activeColumn()} IS NOT NULL
           AND created_at >= NOW() - make_interval(days => $2)
           AND (($3::text IS NULL AND context IS NULL) OR context = $3)
           AND (($4::text IS NULL AND category IS NULL) OR category = $4)
         ORDER BY similarity DESC, last_seen DESC NULLS LAST, created_at DESC
         LIMIT 1`,
        [JSON.stringify(embedding), cfg.dedupeRecentDays, storedContext, lifecycle.category]
      );
      let candidate = semantic.rows[0];
      let candidateOk = candidate && Number(candidate.similarity || 0) >= cfg.dedupeSimThreshold;
      let crossScopeMerge = false;
      // BRAINX_DEDUP_CROSS_SCOPE_20260701: anti-regeneration second probe — ignores context/category
      // and widens the window, but requires a STRICTER similarity so only near-identical regenerations
      // merge. Only runs when the same-scope probe found no merge, so it can't override tighter matches.
      if (!candidateOk && cfg.dedupeCrossScope) {
        const cross = await client.query(
          `SELECT id, recurrence_count, first_seen, last_seen,
                  1 - (${recallCalibration.activeColumn()} <=> $1::vector) AS similarity
           FROM brainx_memories
           WHERE superseded_by IS NULL
             AND ${recallCalibration.activeColumn()} IS NOT NULL
             AND created_at >= NOW() - make_interval(days => $2)
           ORDER BY similarity DESC, last_seen DESC NULLS LAST, created_at DESC
           LIMIT 1`,
          [JSON.stringify(embedding), cfg.dedupeCrossScopeDays]
        );
        const crossCandidate = cross.rows[0];
        if (crossCandidate && Number(crossCandidate.similarity || 0) >= cfg.dedupeCrossScopeThreshold) {
          candidate = crossCandidate;
          candidateOk = true;
          crossScopeMerge = true;
        }
      }
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
       source_kind, source_path, confidence_score, expires_at, sensitivity, verification_state,
       error_fingerprint
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
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
       verification_state=COALESCE(EXCLUDED.verification_state, brainx_memories.verification_state),
       error_fingerprint=COALESCE(EXCLUDED.error_fingerprint, brainx_memories.error_fingerprint)`,
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
      verificationState,
      // BRAINX_REACTIVE_ERROR_RECALL_FINGERPRINT_20260719: clean error signature
      // for exact-match reactive recall; null for non-failure memories.
      memory.errorFingerprint || null
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

  // BRAINX_SEARCH_RANK_FUSION_20260702: the SQL composite dilutes the semantic signal —
  // Gemini cosine sims live in a narrow band (~0.49-0.58 per query), so a decisive
  // relevance edge contributes ~0.04 while static priors (importance/recency/provenance)
  // stack ~0.5. Measured: eval targets with the HIGHEST raw similarity ranked #8-15.
  // Fix: over-fetch candidates, then re-rank in JS by 50/50 min-max-normalized
  // (composite ‖ similarity) + typed entity-signal bonus, return top `limit`.
  // Fail-open; kill switch BRAINX_SEARCH_RANK_FUSION=0 restores SQL order exactly.
  const rankFusionEnabled = String(process.env.BRAINX_SEARCH_RANK_FUSION || '1') !== '0';
  // Pool size: 4x measured optimal on the eval (hit@5 45.5%); an 8x/40-row pool
  // DEGRADED it to 36.4% — a wider pool lets more generic high-prior rows in and
  // compresses the target's normalized relevance edge. Don't "just fetch more".
  const fetchLimit = rankFusionEnabled ? Math.min(limit * 4, limit + 40) : limit;

  // BRAINX_COST_AGENT_ATTRIBUTION_20260702: callers that know the agent/surface
  // (runtime injection paths, CLI) pass options.agentId/sessionId/surface.
  const queryEmbedding = await withCostContext(
    {
      operation_type: 'embedding_search',
      call_site: 'openai-rag.js:search',
      agent_id: options.agentId || null,
      session_id: options.sessionId || null,
      surface: options.surface || null,
    },
    () => embed(query)
  );

  const params = [JSON.stringify(queryEmbedding), minImportance];
  let sql;
  let i = 3;
  const filterOptions = { tierFilter, excludeTiers, contextFilter, maxSensitivity };
  let hnswEfSearch = 0;

  if (useTwoStageSearch(options)) {
    const candidateLimit = twoStageCandidateLimit(fetchLimit, options);
    hnswEfSearch = twoStageEfSearch(candidateLimit, options);
    let whereSql = baseSearchWhere('m');
    ({ sql: whereSql, nextIndex: i } = appendSearchFilters(whereSql, params, i, filterOptions, 'm'));

    const limitParam = i;
    // The final LIMIT must never evict FTS-sourced candidates: they have low SQL
    // composite (low sim) BY DESIGN and the JS rank fusion is what positions them.
    // So the SQL page is fetchLimit vector rows + room for all 15 lex rows.
    params.push(fetchLimit + 15);
    i++;
    const candidateLimitParam = i;
    params.push(candidateLimit);
    i++;

    // BRAINX_SEARCH_HYBRID_FTS_20260702: second candidate source — lexical FTS over
    // rare query tokens (prefix-matched, OR semantics). Dense multi-topic memories
    // embed poorly: 5/11 eval targets were ABSENT from the top-60 vector candidates
    // while containing exact query tokens. FTS-sourced rows are flagged via_fts and
    // exempt from the minSimilarity cut (they earned entry lexically; the rank
    // fusion decides their final position). Kill switch BRAINX_SEARCH_HYBRID_FTS=0.
    const ftsEnabled = rankFusionEnabled && String(process.env.BRAINX_SEARCH_HYBRID_FTS || '1') !== '0';
    // Tokens WITHOUT underscores: the 'simple' ts parser splits compound_words into
    // separate lexemes, so 'agent_inference:*' would never match ('agent'+'inference' do).
    const ftsTokens = ftsEnabled
      ? Array.from(new Set(String(query).toLowerCase().match(/[a-z0-9áéíóúñü]{4,}/g) || [])).slice(0, 12)
      : [];
    const embCol = recallCalibration.activeColumn();
    let lexCte = '';
    let lexUnion = '';
    if (ftsTokens.length) {
      const tsqueryParam = i;
      params.push(ftsTokens.map((t) => `${t}:*`).join(' | '));
      i++;
      // content_tsv is a STORED generated column (migration 023) — @@ and ts_rank
      // read it directly instead of recomputing to_tsvector per matched row.
      lexCte = `,
      lex_candidates AS MATERIALIZED (
        SELECT id
        FROM brainx_memories
        WHERE content_tsv @@ to_tsquery('simple', $${tsqueryParam})
        ORDER BY ts_rank(content_tsv, to_tsquery('simple', $${tsqueryParam})) DESC
        LIMIT 15
      )`;
      lexUnion = `
        UNION ALL
        SELECT id, true AS via_fts FROM lex_candidates`;
    }
    sql = `
      WITH vector_candidates AS MATERIALIZED (
        SELECT id
        FROM brainx_memories
        WHERE ${embCol} IS NOT NULL
        ORDER BY ${embCol} <=> $1::vector
        LIMIT $${candidateLimitParam}
      )${lexCte},
      cands AS (
        SELECT id, bool_or(via_fts) AS via_fts FROM (
          SELECT id, false AS via_fts FROM vector_candidates${lexUnion}
        ) u GROUP BY id
      )
      SELECT ${memorySelectColumns('m')}, vc.via_fts, ${weightedScoreSql(w, 'm')}
      FROM cands vc
      JOIN LATERAL (
        SELECT *
        FROM brainx_memories m
        ${whereSql}
          AND m.id = vc.id
      ) m ON true
      ORDER BY vc.via_fts DESC, score DESC, similarity DESC
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
    params.push(fetchLimit);
  }

  if (process.env.BRAINX_DEBUG_SEARCH_SQL === '1') {
    console.error('[debug-sql]', sql.replace(/\s+/g, ' ').slice(0, 2000));
    console.error('[debug-params]', JSON.stringify(params.slice(1)));
  }
  const results = await queryWithOptionalHnswEfSearch(sql, params, hnswEfSearch);

  // FTS-sourced rows bypass the similarity cut — they earned entry lexically and
  // the rank fusion (not a hard cut) decides where they land.
  let filtered = results.rows.filter(r => (r.similarity ?? 0) >= minSimilarity || r.via_fts === true);

  // BRAINX_SEARCH_RANK_FUSION_20260702: re-rank the over-fetched pool, then trim.
  if (rankFusionEnabled && filtered.length > 1) {
    try {
      const sims = filtered.map((r) => Number(r.similarity ?? 0));
      const scores = filtered.map((r) => Number(r.score ?? 0));
      const sMin = Math.min(...sims); const sMax = Math.max(...sims);
      const cMin = Math.min(...scores); const cMax = Math.max(...scores);
      const norm = (v, lo, hi) => (hi - lo > 1e-9 ? (v - lo) / (hi - lo) : 0.5);
      const simW = Math.min(0.9, Math.max(0.1, parseFloat(process.env.BRAINX_RANK_FUSION_SIM_WEIGHT || '0.7')));
      for (const r of filtered) {
        r._blended = (1 - simW) * norm(Number(r.score ?? 0), cMin, cMax) + simW * norm(Number(r.similarity ?? 0), sMin, sMax);
      }
      // Pool-local rare-token lexical bonus: complements the TYPED entity signal for
      // natural-language queries. A query token present in few pool docs is
      // discriminating (IDF within the candidate pool — no global stats needed);
      // one present in most docs contributes ~0. Capped so it re-orders, never dominates.
      const qTokens = Array.from(new Set(String(query).toLowerCase().match(/[a-z0-9áéíóúñü_-]{5,}/g) || []));
      if (qTokens.length) {
        const docs = filtered.map((r) => `${r.content || ''} ${r.context || ''}`.toLowerCase());
        const N = docs.length;
        const df = new Map(qTokens.map((t) => [t, docs.reduce((s, d) => s + (d.includes(t) ? 1 : 0), 0)]));
        for (let di = 0; di < filtered.length; di++) {
          let lex = 0;
          for (const t of qTokens) {
            const n = df.get(t) || 0;
            if (n > 0 && docs[di].includes(t)) lex += Math.log(1 + N / n) / Math.log(1 + N);
          }
          filtered[di]._lexBonus = Math.min(0.25, 0.12 * lex);
          filtered[di]._blended += filtered[di]._lexBonus;
        }
      }
      // Entering via FTS is itself a strong GLOBAL lexical signal (ts_rank top-15 of
      // the whole corpus for this query) that the pool-local blend can't see — those
      // rows arrive with low cosine sim by design and need the entry acknowledged.
      const ftsBonus = Math.min(0.5, Math.max(0, parseFloat(process.env.BRAINX_RANK_FUSION_FTS_BONUS || '0.3')));
      if (ftsBonus > 0) {
        for (const r of filtered) {
          if (r.via_fts === true) r._blended += ftsBonus;
        }
      }
      try {
        const entitySignal = require('./entity-signal');
        entitySignal.fuse(filtered, query, (r) => `${r.content || ''} ${r.context || ''} ${Array.isArray(r.tags) ? r.tags.join(' ') : ''}`);
      } catch (_) { /* entity signal unavailable → plain blend */ }
      filtered.sort((a, b) => Number(b._blended ?? 0) - Number(a._blended ?? 0));
    } catch (_) { /* fail-open: keep SQL order */ }
  }
  filtered = filtered.slice(0, limit);

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
    topSimilarity = null
  } = event || {};
  if (!queryHash) return;

  try {
    await db.query(
      `INSERT INTO brainx_query_log (query_hash, query_kind, duration_ms, results_count, avg_similarity, top_similarity)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [queryHash, kind, durationMs, resultsCount, avgSimilarity, topSimilarity]
    );
  } catch (_) {
    // Logging must never break search/inject CLI flows.
  }
}

module.exports = { embed, storeMemory, storeMemoryWithClient, search, logQueryEvent, DEFAULT_WEIGHTS };
