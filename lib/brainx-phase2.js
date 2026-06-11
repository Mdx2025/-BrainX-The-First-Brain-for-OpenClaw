function parseBoolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function parseIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getPhase2Config() {
  const allowlistContexts = (process.env.BRAINX_PII_SCRUB_ALLOWLIST_CONTEXTS || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return {
    piiScrubEnabled: parseBoolEnv('BRAINX_PII_SCRUB_ENABLED', true),
    piiScrubReplacement: process.env.BRAINX_PII_SCRUB_REPLACEMENT || '[REDACTED]',
    piiScrubAllowlistContexts: allowlistContexts,
    dedupeSimThreshold: Number.parseFloat(process.env.BRAINX_DEDUPE_SIM_THRESHOLD || '0.92') || 0.92,
    dedupeRecentDays: Number.parseInt(process.env.BRAINX_DEDUPE_RECENT_DAYS || '30', 10) || 30
  };
}

function getQualityGateConfig() {
  return {
    minChars: parseIntEnv('BRAINX_QUALITY_MIN_CHARS', 20),
    minWords: parseIntEnv('BRAINX_QUALITY_MIN_WORDS', 4),
    borderlineChars: parseIntEnv('BRAINX_QUALITY_BORDERLINE_CHARS', 40),
    minScore: parseIntEnv('BRAINX_QUALITY_MIN_SCORE', 0),
    maxAckChars: parseIntEnv('BRAINX_QUALITY_MAX_ACK_CHARS', 72),
    shortSignalFloor: parseIntEnv('BRAINX_QUALITY_SHORT_SIGNAL_FLOOR', 12),
    strict: parseBoolEnv('BRAINX_STRICT_QUALITY', false)
  };
}

const PII_PATTERNS = [
  { reason: 'email', regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { reason: 'phone', regex: /(?<!\w)(?:\+?1[\s.\-]?)?(?:\(?\d{3}\)?[\s.\-]?)?\d{3}[\s.\-]?\d{4}(?!\w)/g },
  { reason: 'openai_key', regex: /\bsk-[A-Za-z0-9]{16,}\b/g },
  { reason: 'github_token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { reason: 'github_pat', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { reason: 'aws_access_key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { reason: 'slack_token', regex: /\bxox(?:b|p|a|r|s)-[A-Za-z0-9-]{10,}\b/g },
  { reason: 'bearer_token', regex: /\bBearer\s+[A-Za-z0-9._\-]{16,}\b/gi },
  { reason: 'api_key_assignment', regex: /\b(?:api|access|secret)[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9._\-]{12,}['"]?/gi },
  { reason: 'jwt_token', regex: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g },
  { reason: 'private_key_block', regex: /-----BEGIN(?: RSA| EC| OPENSSH)? PRIVATE KEY-----[\s\S]*?-----END(?: RSA| EC| OPENSSH)? PRIVATE KEY-----/g },
  { reason: 'iban', regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g },
  { reason: 'credit_card', regex: /\b(?:\d[ -]*?){13,19}\b/g },
  { reason: 'ipv4', regex: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  { reason: 'password_inline', regex: /(?:contraseña|password|passwd|pass|clave|secret)\s*(?:(?:es|is|actual|nueva|new|=|:)\s*){1,2}['"`]?[^\s'"`,]{4,}['"`]?/gi },
  { reason: 'password_quoted', regex: /(?:contraseña|password|passwd|clave)\s*[:=]\s*['"][^'"]{4,}['"]/gi },
];

const SENSITIVITY_LEVELS = Object.freeze({
  normal: 0,
  sensitive: 1,
  restricted: 2
});

const RESTRICTED_REASONS = new Set([
  'openai_key',
  'github_token',
  'github_pat',
  'aws_access_key',
  'slack_token',
  'bearer_token',
  'api_key_assignment',
  'jwt_token',
  'private_key_block',
  'iban',
  'credit_card',
  'password_inline',
  'password_quoted'
]);

const SENSITIVE_REASONS = new Set([
  'email',
  'phone',
  'ipv4'
]);

const REDACTED_OR_VALUE = String.raw`(?:\`?\[REDACTED\]\`?|\`?[^\s\`\/]+\`?)`;
const PASSWORD_VALUE_PATTERN = String.raw`(?:\s*(?:[:=]|es|son)?\s*)(?:\`?\[REDACTED\]\`?|[A-Za-z0-9._!@#$%^&*?-]{4,})`;
const CREDENTIAL_PAIR_PATTERNS = [
  new RegExp(
    String.raw`\b(?:credenciales?|credentials?)\b(?![.-])[\s\S]{0,80}?(?:son|are|:|=)\s*${REDACTED_OR_VALUE}\s*(?:\/|y|and)\s*${REDACTED_OR_VALUE}`,
    'i'
  ),
  new RegExp(
    String.raw`\b(?:usuario|username|email|login)\b[\s\S]{0,120}(?:password|passwd|contraseñ(?:a)?|clave\s+de\s+acceso)\b${PASSWORD_VALUE_PATTERN}`,
    'i'
  ),
  new RegExp(
    String.raw`\b(?:test user|demo user|usuario de prueba)\b[\s\S]{0,80}(?:[:=]\s*)?${REDACTED_OR_VALUE}\s*(?:\/|y|and)\s*${REDACTED_OR_VALUE}`,
    'i'
  ),
];

const QUALITY_NOISE_PATTERNS = [
  /^HEARTBEAT_OK$/i,
  /^NO_REPLY$/i,
  /^(?:ok(?:ay)?|yes|no|sure|done|listo|si|sí|thanks|gracias|perfecto|dale|vale|noted|copiado|recibido)[.!?]*$/i,
  /^[\s!?.,;:\/\\-]+$/i
];

const QUALITY_ACKNOWLEDGEMENT_PATTERNS = [
  /^(?:ok(?:ay)?|sure|dale|vale|perfecto|entendido|anotado|copiado|recibido|noted|thanks|gracias)[, ]+(?:lo\s+)?(?:reviso|veo|hago|miro|atiendo|resuelvo|check(?:eo)?|review|look into|handle|fix|do)\b.*$/i,
  /^(?:i(?:'| a)?ll|i will|voy a|lo voy a|ya lo|te)\s+(?:check|review|look into|handle|fix|do|revisar|ver|mirar|resolver|hacer|checar|investigar)\b.*$/i,
  /^(?:working on it|on it|en eso|voy en eso|ya voy|lo tengo|me encargo|me ocupo)\b.*$/i
];

const QUALITY_PLACEHOLDER_PATTERNS = [
  /^(?:hay que|toca|need(?:s)? to|have to|should|debemos?)\s+(?:revisar|ver|mirar|hacer|arreglar|fix|check|review|look into|handle)\s+(?:esto|eso|this|that|it)\b.*$/i,
  /^(?:revisar|ver|mirar|fix|check|review)\s+(?:esto|eso|this|that|it)\b.*$/i
];

const QUALITY_SIGNAL_PATTERNS = [
  /`[^`]+`/,
  /(?:^|\s)\/[\w./-]+/,
  /\b[A-Z][A-Z0-9_]{2,}\b/,
  /\B--[a-z0-9][\w-]*/i,
  /\b[a-z0-9_.-]+\.[a-z0-9_./-]+\b/i,
  /\b(?:error|bug|fix|issue|fail(?:ed|ure)?|warning|doctor|hook|cron|deploy|auth|token|memory|context|search|query|embedding|pattern|vector|dedupe|config|retr(?:y|ies)|rate limit|railway|github|postgres|pgvector|workspace|session|archivo|ruta|comando|usar|use|prefer|evitar|must|debe|run|set|sync|merge|scrub|inject|promotion|lifecycle)\b/i
];

const QUALITY_ACTION_PATTERNS = [
  /\b(?:use|prefer|avoid|set|run|store|skip|mark|sync|review|fix|resolve|promote|degrade|reclassify|inject|scrub|merge|update|retr(?:y|ies)|need(?:s)?|usar|preferir|evitar|ejecutar|guardar|omitir|marcar|sincronizar|revisar|corregir|resolver|promover|degradar|reclasificar|inyectar|actualizar)\b/i,
  /\b(?:if|when|because|since|cuando|porque|si)\b/i
];

function normalizeMemoryText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function tokenizeMemoryText(text) {
  return String(text || '').match(/[\p{L}\p{N}_./:-]+/gu) || [];
}

function hasRepetitiveVocabulary(tokens) {
  if (!Array.isArray(tokens) || tokens.length < 4) return false;
  const normalized = tokens.map((token) => token.toLowerCase());
  const uniqueRatio = new Set(normalized).size / normalized.length;
  if (uniqueRatio <= 0.34) return true;

  let sameAsPrev = 0;
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i] === normalized[i - 1]) sameAsPrev++;
  }
  return sameAsPrev >= Math.ceil(normalized.length / 3);
}

function assessMemoryQuality(memory = {}, overrides = {}) {
  const cfg = { ...getQualityGateConfig(), ...(overrides || {}) };
  const original = String(memory.content == null ? '' : memory.content);
  const normalized = normalizeMemoryText(original);

  if (!normalized) {
    return {
      action: 'skip',
      reason: 'empty',
      score: -10,
      reasons: ['empty'],
      tags: ['quality:rejected'],
      metrics: { chars: 0, words: 0, signalHits: 0, uniqueRatio: 0 }
    };
  }

  if (QUALITY_NOISE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      action: 'skip',
      reason: 'noise_pattern',
      score: -10,
      reasons: ['noise_pattern'],
      tags: ['quality:rejected'],
      metrics: { chars: normalized.length, words: 0, signalHits: 0, uniqueRatio: 0 }
    };
  }

  if (
    normalized.length <= cfg.maxAckChars &&
    QUALITY_ACKNOWLEDGEMENT_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return {
      action: 'skip',
      reason: 'acknowledgement',
      score: -8,
      reasons: ['acknowledgement'],
      tags: ['quality:rejected'],
      metrics: { chars: normalized.length, words: tokenizeMemoryText(normalized).length, signalHits: 0, uniqueRatio: 0 }
    };
  }

  if (QUALITY_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      action: 'skip',
      reason: 'placeholder',
      score: -7,
      reasons: ['placeholder'],
      tags: ['quality:rejected'],
      metrics: { chars: normalized.length, words: tokenizeMemoryText(normalized).length, signalHits: 0, uniqueRatio: 0 }
    };
  }

  const tokens = tokenizeMemoryText(normalized);
  const wordCount = tokens.length;
  const uniqueRatio = wordCount ? new Set(tokens.map((token) => token.toLowerCase())).size / wordCount : 0;
  if (hasRepetitiveVocabulary(tokens)) {
    return {
      action: 'skip',
      reason: 'repetitive',
      score: -6,
      reasons: ['repetitive'],
      tags: ['quality:rejected'],
      metrics: { chars: normalized.length, words: wordCount, signalHits: 0, uniqueRatio }
    };
  }

  const alphaNumericCount = (normalized.match(/[\p{L}\p{N}]/gu) || []).length;
  if (!alphaNumericCount) {
    return {
      action: 'skip',
      reason: 'symbol_only',
      score: -6,
      reasons: ['symbol_only'],
      tags: ['quality:rejected'],
      metrics: { chars: normalized.length, words: wordCount, signalHits: 0, uniqueRatio }
    };
  }

  const lineCount = original.split(/\r?\n/).filter((line) => line.trim()).length || 1;
  const hasTechnicalMarkers =
    /`[^`]+`/.test(normalized) ||
    /(?:^|\s)\/[\w./-]+/.test(normalized) ||
    /\b[A-Z][A-Z0-9_]{2,}\b/.test(normalized) ||
    /\B--[a-z0-9][\w-]*/i.test(normalized) ||
    /\b[a-z0-9_.-]+\.[a-z0-9_./-]+\b/i.test(normalized) ||
    /\b[a-z0-9_]+\(\)/i.test(normalized);
  const signalHits = QUALITY_SIGNAL_PATTERNS.filter((pattern) => pattern.test(normalized)).length;
  const hasActionLanguage = QUALITY_ACTION_PATTERNS.some((pattern) => pattern.test(normalized));
  const hasStructuredSentence = /[:.;]/.test(normalized) || (lineCount > 1 && normalized.length >= cfg.minChars);
  const symbolHeavy = ((normalized.match(/[^\p{L}\p{N}\s]/gu) || []).length > alphaNumericCount * 0.8) && !hasTechnicalMarkers;
  const preservePriority =
    Number(memory.importance ?? 5) >= 7 ||
    ['decision', 'fact', 'gotcha'].includes(String(memory.type || '').toLowerCase());

  let score = 0;
  const reasons = [];
  const tags = [];

  if (normalized.length >= cfg.borderlineChars) {
    score += 2;
    reasons.push('enough_chars');
  } else if (normalized.length >= cfg.minChars) {
    score += 1;
    reasons.push('brief_but_acceptable');
    tags.push('quality:brief');
  } else if (normalized.length >= cfg.shortSignalFloor) {
    reasons.push('short_signal_window');
    tags.push('quality:brief');
  } else {
    score -= 2;
    reasons.push('too_short');
    tags.push('quality:brief');
  }

  if (wordCount >= cfg.minWords + 2) {
    score += 2;
    reasons.push('enough_words');
  } else if (wordCount >= cfg.minWords) {
    score += 1;
    reasons.push('minimum_words');
  } else if (wordCount >= 2 && (hasTechnicalMarkers || hasActionLanguage || signalHits > 0)) {
    reasons.push('compressed_but_signalful');
    tags.push('quality:compressed');
  } else {
    score -= 2;
    reasons.push('low_word_count');
    tags.push('quality:compressed');
  }

  if (signalHits >= 2) {
    score += 2;
    reasons.push('multi_signal_markers');
  } else if (signalHits === 1) {
    score += 1;
    reasons.push('signal_marker');
  }

  if (hasStructuredSentence) {
    score += 1;
    reasons.push('structured');
  }

  if (uniqueRatio < 0.45 && wordCount >= 5) {
    score -= 2;
    reasons.push('low_vocab_diversity');
  }

  if (symbolHeavy) {
    score -= 1;
    reasons.push('symbol_heavy');
  }

  const weakByForm =
    normalized.length < cfg.minChars &&
    wordCount < cfg.minWords &&
    signalHits === 0 &&
    !hasTechnicalMarkers &&
    !hasStructuredSentence;

  if (weakByForm || score < cfg.minScore) {
    if (preservePriority && (signalHits > 0 || hasTechnicalMarkers || hasStructuredSentence || wordCount >= cfg.minWords)) {
      return {
        action: 'downgrade',
        reason: 'priority_preserved',
        score,
        reasons,
        tags: Array.from(new Set([...tags, 'quality:borderline'])),
        metrics: { chars: normalized.length, words: wordCount, signalHits, uniqueRatio, lineCount }
      };
    }

    return {
      action: 'skip',
      reason: 'low_signal',
      score,
      reasons,
      tags: Array.from(new Set([...tags, 'quality:rejected'])),
      metrics: { chars: normalized.length, words: wordCount, signalHits, uniqueRatio, lineCount }
    };
  }

  if (score <= 1 && !preservePriority) {
    return {
      action: 'downgrade',
      reason: 'borderline',
      score,
      reasons,
      tags: Array.from(new Set([...tags, 'quality:borderline'])),
      metrics: { chars: normalized.length, words: wordCount, signalHits, uniqueRatio, lineCount }
    };
  }

  return {
    action: 'store',
    reason: preservePriority && score <= 1 ? 'priority_preserved' : 'ok',
    score,
    reasons,
    tags: Array.from(new Set(tags)),
    metrics: { chars: normalized.length, words: wordCount, signalHits, uniqueRatio, lineCount }
  };
}

function passesLuhnCheck(digits) {
  let sum = 0;
  let doubleDigit = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (!Number.isFinite(digit)) return false;
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function replaceCreditCardMatches(text, replacement) {
  let replaced = false;
  const output = String(text).replace(/\b(?:\d[ -]*?){13,19}\b/g, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return match;
    if (!passesLuhnCheck(digits)) return match;
    replaced = true;
    return replacement;
  });
  return { text: output, replaced };
}

function shouldScrubForContext(context, cfg = {}) {
  const enabled = cfg.piiScrubEnabled !== undefined ? !!cfg.piiScrubEnabled : true;
  if (!enabled) return false;
  const ctx = context == null ? '' : String(context).trim();
  if (!ctx) return true;
  const allow = new Set((cfg.piiScrubAllowlistContexts || []).map((v) => String(v).trim()).filter(Boolean));
  return !allow.has(ctx);
}

function normalizeSensitivity(value) {
  const normalized = String(value || 'normal').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(SENSITIVITY_LEVELS, normalized)
    ? normalized
    : 'normal';
}

function maxSensitivity(a, b) {
  const left = normalizeSensitivity(a);
  const right = normalizeSensitivity(b);
  return SENSITIVITY_LEVELS[left] >= SENSITIVITY_LEVELS[right] ? left : right;
}

function getAllowedSensitivities(maxValue = 'normal') {
  const normalizedMax = normalizeSensitivity(maxValue);
  return Object.keys(SENSITIVITY_LEVELS).filter(
    (key) => SENSITIVITY_LEVELS[key] <= SENSITIVITY_LEVELS[normalizedMax]
  );
}

function scrubTextPII(text, opts = {}) {
  const input = text == null ? text : String(text);
  const enabled = opts.enabled !== undefined ? !!opts.enabled : true;
  const replacement = opts.replacement || '[REDACTED]';
  if (input == null || !enabled) {
    return { text: input, redacted: false, reasons: [] };
  }

  let out = input;
  const reasons = [];
  for (const { reason, regex } of PII_PATTERNS) {
    if (reason === 'credit_card') {
      const result = replaceCreditCardMatches(out, replacement);
      if (!result.replaced) continue;
      reasons.push(reason);
      out = result.text;
      continue;
    }
    regex.lastIndex = 0;
    if (!regex.test(out)) continue;
    reasons.push(reason);
    regex.lastIndex = 0;
    out = out.replace(regex, replacement);
  }
  return { text: out, redacted: reasons.length > 0, reasons };
}

function mergeTagsWithMetadata(tags, meta = {}) {
  const input = Array.isArray(tags) ? tags.slice() : [];
  const seen = new Set(input.map(String));
  if (meta.redacted) {
    for (const tag of ['pii:redacted', ...(meta.reasons || []).map((r) => `pii:${r}`)]) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      input.push(tag);
    }
  }
  return input;
}

function deriveSensitivity(input = {}) {
  const explicit = normalizeSensitivity(input.explicit);
  const tags = Array.isArray(input.tags) ? input.tags.map(String) : [];
  const tagSet = new Set(tags);
  const tagReasons = tags
    .filter((tag) => tag.startsWith('pii:') && tag !== 'pii:redacted')
    .map((tag) => tag.slice(4));
  const redactionReasons = Array.isArray(input.redactionMeta?.reasons)
    ? input.redactionMeta.reasons.map(String)
    : [];
  const reasons = Array.from(new Set([...tagReasons, ...redactionReasons]));
  const hasRedaction = tagSet.has('pii:redacted') || reasons.length > 0 || input.redactionMeta?.redacted === true;

  let derived = 'normal';
  if (hasRedaction) {
    derived = 'sensitive';
  }
  if (reasons.some((reason) => RESTRICTED_REASONS.has(reason))) {
    derived = 'restricted';
  } else if (reasons.some((reason) => SENSITIVE_REASONS.has(reason))) {
    derived = maxSensitivity(derived, 'sensitive');
  }

  const combinedText = [
    input.content || '',
    input.context || '',
    tags.join(' ')
  ].join('\n');
  if (hasRedaction && CREDENTIAL_PAIR_PATTERNS.some((pattern) => pattern.test(combinedText))) {
    derived = 'restricted';
  }

  return maxSensitivity(explicit, derived);
}

function deriveMergePlan(existingRow, lifecycle, now) {
  const current = existingRow || null;
  const tsNow = now || new Date();
  if (!current) {
    return {
      found: false,
      finalId: null,
      finalRecurrence: Number(lifecycle.recurrence_count || 1),
      finalFirstSeen: lifecycle.first_seen || tsNow,
      finalLastSeen: lifecycle.last_seen || tsNow
    };
  }

  return {
    found: true,
    finalId: current.id,
    finalRecurrence: Math.max(
      Number(current.recurrence_count || 1) + 1,
      Number(lifecycle.recurrence_count || 0)
    ),
    finalFirstSeen: lifecycle.first_seen || current.first_seen || tsNow,
    finalLastSeen: lifecycle.last_seen || tsNow
  };
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

module.exports = {
  getPhase2Config,
  shouldScrubForContext,
  scrubTextPII,
  mergeTagsWithMetadata,
  normalizeSensitivity,
  maxSensitivity,
  getAllowedSensitivities,
  deriveSensitivity,
  deriveMergePlan,
  cosineSimilarity,
  getQualityGateConfig,
  assessMemoryQuality
};
