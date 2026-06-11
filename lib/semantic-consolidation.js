'use strict';

function parseBoolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

function parseIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(String(raw), 10);
  return Number.isFinite(value) ? value : fallback;
}

function parseFloatEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseFloat(String(raw));
  return Number.isFinite(value) ? value : fallback;
}

function normalizeList(input, fallback = []) {
  const source = input == null ? fallback : input;
  return []
    .concat(source)
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeScopeValue(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const CONSOLIDATION_NOISE_PATTERNS = [
  /\[subagent context\]/i,
  /\[subagent task\]/i,
  /you are running as a subagent/i,
  /openclaw runtime context/i,
  /runtime-generated,\s*not user-authored/i,
  /results auto-announce to your requester/i
];

function looksLikeStatusTable(content) {
  const text = String(content || '');
  const tableLines = text.match(/^\|.+\|$/gm) || [];
  return tableLines.length >= 3 && /\|\s*:?-{2,}/.test(text);
}

function looksLikeConsolidationNoise(content) {
  const text = String(content || '');
  return CONSOLIDATION_NOISE_PATTERNS.some((pattern) => pattern.test(text)) || looksLikeStatusTable(text);
}

function getMemoryAgeDays(memory = {}, now = new Date()) {
  const reference = normalizeTimestamp(
    memory.created_at || memory.createdAt || memory.first_seen || memory.firstSeen || memory.last_seen || memory.lastSeen
  );
  if (!reference) return Infinity;
  return Math.max(0, (now.getTime() - reference.getTime()) / 86400000);
}

function getMemoryScope(memory = {}, cfg = {}) {
  return {
    type: cfg.requireSameType === false ? null : normalizeScopeValue(memory.type),
    agent: cfg.requireSameAgent === false ? null : normalizeScopeValue(memory.agent),
    context: cfg.requireSameContext === false ? null : normalizeScopeValue(memory.context),
    category: cfg.requireSameCategory === false ? null : normalizeScopeValue(memory.category),
    sensitivity: cfg.requireSameSensitivity === false ? null : normalizeScopeValue(memory.sensitivity || 'normal')
  };
}

function scopesMatch(left, right) {
  const keys = ['type', 'agent', 'context', 'category', 'sensitivity'];
  return keys.every((key) => {
    const leftValue = left?.[key] == null ? null : String(left[key]).trim().toLowerCase();
    const rightValue = right?.[key] == null ? null : String(right[key]).trim().toLowerCase();
    return leftValue === rightValue;
  });
}

function getSemanticConsolidationConfig(overrides = {}) {
  const defaults = {
    minSimilarity: parseFloatEnv('BRAINX_CONSOLIDATION_MIN_SIMILARITY', 0.82),
    minCluster: parseIntEnv('BRAINX_CONSOLIDATION_MIN_CLUSTER', 2),
    maxCluster: parseIntEnv('BRAINX_CONSOLIDATION_MAX_CLUSTER', 5),
    // Default lowered from 7 to 3 (2026-04-14): waiting a full week before
    // consolidating recent duplicates left near-duplicates piling up across
    // agents during the weekday cycle. 3d still excludes same-day churn but
    // lets midweek consolidation collapse repetitions before the weekend.
    minAgeDays: parseIntEnv('BRAINX_CONSOLIDATION_MIN_AGE_DAYS', 3),
    maxSeeds: parseIntEnv('BRAINX_CONSOLIDATION_MAX_SEEDS', 600),
    maxNeighbors: parseIntEnv('BRAINX_CONSOLIDATION_MAX_NEIGHBORS', 12),
    maxAdditions: parseIntEnv('BRAINX_CONSOLIDATION_MAX_ADDITIONS', 6),
    maxContentChars: parseIntEnv('BRAINX_CONSOLIDATION_MAX_CONTENT_CHARS', 2400),
    minSnippetChars: parseIntEnv('BRAINX_CONSOLIDATION_MIN_SNIPPET_CHARS', 24),
    includeBorderline: parseBoolEnv('BRAINX_CONSOLIDATION_INCLUDE_BORDERLINE', false),
    includeChangelog: parseBoolEnv('BRAINX_CONSOLIDATION_INCLUDE_CHANGELOG', false),
    includeRuntimeNoise: parseBoolEnv('BRAINX_CONSOLIDATION_INCLUDE_RUNTIME_NOISE', false),
    includeTypes: normalizeList(
      process.env.BRAINX_CONSOLIDATION_TYPES,
      ['fact', 'decision', 'gotcha', 'learning']
    ),
    excludeSourceKinds: normalizeList(
      process.env.BRAINX_CONSOLIDATION_EXCLUDE_SOURCE_KINDS,
      ['consolidated']
    ),
    requireSameAgent: parseBoolEnv('BRAINX_CONSOLIDATION_REQUIRE_SAME_AGENT', true),
    requireSameContext: parseBoolEnv('BRAINX_CONSOLIDATION_REQUIRE_SAME_CONTEXT', true),
    requireSameCategory: parseBoolEnv('BRAINX_CONSOLIDATION_REQUIRE_SAME_CATEGORY', true),
    requireSameType: parseBoolEnv('BRAINX_CONSOLIDATION_REQUIRE_SAME_TYPE', true),
    requireSameSensitivity: parseBoolEnv('BRAINX_CONSOLIDATION_REQUIRE_SAME_SENSITIVITY', true),
    weeklyRunDayUtc: parseIntEnv('BRAINX_CONSOLIDATION_WEEKDAY_UTC', 0)
  };

  const merged = { ...defaults, ...(overrides || {}) };
  merged.includeTypes = normalizeList(merged.includeTypes, defaults.includeTypes);
  merged.excludeSourceKinds = normalizeList(merged.excludeSourceKinds, defaults.excludeSourceKinds);
  return merged;
}

function isMemoryEligibleForConsolidation(memory = {}, cfg = {}, now = new Date()) {
  const config = getSemanticConsolidationConfig(cfg);
  const reasons = [];
  const tags = Array.isArray(memory.tags) ? memory.tags.map((tag) => String(tag).toLowerCase()) : [];
  const sourceKind = normalizeScopeValue(memory.source_kind || memory.sourceKind);
  const verificationState = normalizeScopeValue(memory.verification_state || memory.verificationState || 'hypothesis');
  const type = normalizeScopeValue(memory.type);
  const ageDays = getMemoryAgeDays(memory, now);
  const content = String(memory.content || '').trim();

  if (!memory.id) reasons.push('missing_id');
  if (!content) reasons.push('empty_content');
  if (memory.superseded_by || memory.supersededBy) reasons.push('already_superseded');
  if (!Number.isFinite(ageDays) || ageDays < config.minAgeDays) reasons.push('too_fresh');
  if (config.includeTypes.length > 0 && !config.includeTypes.includes(type || '')) reasons.push('type_excluded');
  if (verificationState === 'obsolete') reasons.push('obsolete');
  if (!config.includeChangelog && verificationState === 'changelog') reasons.push('changelog');
  if (config.excludeSourceKinds.includes(sourceKind || '')) reasons.push('source_kind_excluded');
  if (tags.includes('quality:rejected')) reasons.push('quality_rejected');
  if (!config.includeBorderline && tags.includes('quality:borderline')) reasons.push('quality_borderline');
  if (!config.includeRuntimeNoise && looksLikeConsolidationNoise(content)) reasons.push('runtime_noise');

  return {
    eligible: reasons.length === 0,
    reasons,
    ageDays,
    scope: getMemoryScope(memory, config),
    verificationState,
    sourceKind
  };
}

function canConsolidatePair(left, right, cfg = {}, now = new Date()) {
  const leftCheck = isMemoryEligibleForConsolidation(left, cfg, now);
  const rightCheck = isMemoryEligibleForConsolidation(right, cfg, now);
  const reasons = [];

  if (!leftCheck.eligible) reasons.push(...leftCheck.reasons.map((reason) => `left:${reason}`));
  if (!rightCheck.eligible) reasons.push(...rightCheck.reasons.map((reason) => `right:${reason}`));
  if (!scopesMatch(leftCheck.scope, rightCheck.scope)) reasons.push('scope_mismatch');

  return {
    ok: reasons.length === 0,
    reasons,
    scope: leftCheck.scope
  };
}

function shouldRunWeeklyConsolidation(now = new Date(), cfg = {}) {
  const config = getSemanticConsolidationConfig(cfg);
  return now.getUTCDay() === config.weeklyRunDayUtc;
}

function splitSnippets(content) {
  return String(content || '')
    .split(/\r?\n+/)
    .flatMap((line) => line.split(/[.!?]+/))
    .map((piece) => piece.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function snippetTokens(snippet) {
  return String(snippet || '').toLowerCase().match(/[\p{L}\p{N}_./:-]+/gu) || [];
}

function snippetsOverlap(left, right) {
  const leftTokens = new Set(snippetTokens(left));
  const rightTokens = new Set(snippetTokens(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return false;

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap++;
  }
  return overlap / Math.max(leftTokens.size, rightTokens.size) >= 0.72;
}

function dedupeSnippets(snippets, minSnippetChars) {
  const kept = [];
  for (const snippet of snippets) {
    if (snippet.length < minSnippetChars) continue;
    if (kept.some((existing) => snippetsOverlap(existing, snippet))) continue;
    kept.push(snippet);
  }
  return kept;
}

function priorityScore(memory = {}) {
  const verificationState = normalizeScopeValue(memory.verification_state || memory.verificationState || 'hypothesis');
  const verificationBoost =
    verificationState === 'verified' ? 3 :
    verificationState === 'hypothesis' ? 1 :
    verificationState === 'changelog' ? -1 :
    0;
  return (
    Number(memory.importance || 0) * 10 +
    Number(memory.recurrence_count || memory.recurrenceCount || 1) * 4 +
    verificationBoost +
    String(memory.content || '').length / 100
  );
}

function maxSensitivity(memories) {
  const order = { normal: 0, sensitive: 1, restricted: 2 };
  return memories.reduce((current, memory) => {
    const next = normalizeScopeValue(memory.sensitivity || 'normal') || 'normal';
    return order[next] > order[current] ? next : current;
  }, 'normal');
}

function deriveVerificationState(memories, mergedType) {
  const states = memories
    .map((memory) => normalizeScopeValue(memory.verification_state || memory.verificationState || null))
    .filter(Boolean);

  if (states.length > 0 && states.every((state) => state === 'verified')) return 'verified';
  if (states.includes('hypothesis')) return 'hypothesis';
  if (states.length > 0 && states.every((state) => state === 'changelog')) return 'changelog';
  if (['fact', 'decision', 'gotcha'].includes(normalizeScopeValue(mergedType))) return 'verified';
  return 'hypothesis';
}

function mergeClusterMemories(memories, cfg = {}) {
  const config = getSemanticConsolidationConfig(cfg);
  const cluster = Array.isArray(memories) ? memories.slice() : [];
  if (cluster.length === 0) {
    throw new Error('Cannot merge an empty cluster');
  }

  const sorted = cluster.sort((left, right) => priorityScore(right) - priorityScore(left));
  const base = sorted[0];
  const additions = [];
  const seen = dedupeSnippets(splitSnippets(base.content), config.minSnippetChars);

  outer:
  for (const memory of sorted.slice(1)) {
    const snippets = dedupeSnippets(splitSnippets(memory.content), config.minSnippetChars);
    for (const snippet of snippets) {
      if (seen.some((existing) => snippetsOverlap(existing, snippet))) continue;
      seen.push(snippet);
      additions.push(snippet);
      if (additions.length >= config.maxAdditions) break outer;
    }
  }

  let content = String(base.content || '').trim();
  if (additions.length > 0) {
    const bulletBlock = additions.map((snippet) => `- ${snippet.replace(/[.:;]+$/, '')}`).join('\n');
    content = `${content}\n${bulletBlock}`.trim();
  }
  if (content.length > config.maxContentChars) {
    content = `${content.slice(0, Math.max(0, config.maxContentChars - 1)).trim()}…`;
  }

  const tags = Array.from(new Set(
    cluster
      .flatMap((memory) => Array.isArray(memory.tags) ? memory.tags : [])
      .concat(['consolidated', 'consolidated:weekly'])
      .filter(Boolean)
  ));

  const firstSeen = cluster
    .map((memory) => normalizeTimestamp(memory.first_seen || memory.firstSeen || memory.created_at || memory.createdAt))
    .filter(Boolean)
    .sort((left, right) => left - right)[0] || null;

  const lastSeen = cluster
    .map((memory) => normalizeTimestamp(memory.last_seen || memory.lastSeen || memory.created_at || memory.createdAt))
    .filter(Boolean)
    .sort((left, right) => right - left)[0] || null;

  const lastAccessed = cluster
    .map((memory) => normalizeTimestamp(memory.last_accessed || memory.lastAccessed || memory.created_at || memory.createdAt))
    .filter(Boolean)
    .sort((left, right) => right - left)[0] || null;

  const latestCreated = cluster
    .map((memory) => normalizeTimestamp(memory.created_at || memory.createdAt))
    .filter(Boolean)
    .sort((left, right) => right - left)[0] || null;

  const referenceNow = normalizeTimestamp(config.now) || new Date();
  const inheritedStaleAccess = Boolean(
    lastAccessed
      && latestCreated
      && lastAccessed < latestCreated
      && ((referenceNow - lastAccessed) / 86400000) > 30
      && cluster.every((memory) => Number(memory.access_count || memory.accessCount || 0) === 0)
  );

  let mergedTier = cluster.some((memory) => memory.tier === 'hot') ? 'hot' : (base.tier || 'warm');
  if (inheritedStaleAccess) mergedTier = 'cold';

  if (inheritedStaleAccess && !tags.includes('carried_stale_demoted')) {
    tags.push('carried_stale_demoted');
  }

  const categoryValues = Array.from(new Set(cluster.map((memory) => memory.category).filter(Boolean)));

  return {
    content,
    type: base.type,
    context: base.context || null,
    tier: mergedTier,
    agent: base.agent || null,
    importance: Math.min(10, Math.max(...cluster.map((memory) => Number(memory.importance || 5)))),
    tags,
    category: categoryValues.length === 1 ? categoryValues[0] : (base.category || null),
    recurrence_count: cluster.reduce((sum, memory) => sum + Math.max(1, Number(memory.recurrence_count || memory.recurrenceCount || 1)), 0),
    first_seen: firstSeen,
    last_seen: lastSeen,
    last_accessed: lastAccessed,
    source_kind: 'consolidated',
    source_path: 'cron/weekly-semantic-consolidation.sh',
    confidence_score: Math.max(...cluster.map((memory) => Number(memory.confidence_score ?? memory.confidenceScore ?? 0.7))),
    verification_state: deriveVerificationState(cluster, base.type),
    sensitivity: maxSensitivity(cluster),
    status: base.status || 'pending',
    source_ids: cluster.map((memory) => memory.id)
  };
}

module.exports = {
  getSemanticConsolidationConfig,
  getMemoryAgeDays,
  getMemoryScope,
  isMemoryEligibleForConsolidation,
  canConsolidatePair,
  shouldRunWeeklyConsolidation,
  mergeClusterMemories
};
