#!/usr/bin/env node
/**
 * Hermes-style procedural promotion for BrainX.
 *
 * Scans recurring BrainX memories/patterns for reusable workflows and emits
 * review-gated skill candidates. In apply mode it uses a Hermes-style
 * sidecar owner marker plus validation/rollback before leaving changes in
 * ~/.openclaw/skills/*.
 *
 * Optional --save stores candidate drafts as BrainX memories tagged
 * skill-candidate/brainx-skill-promoter for a later human/vetter step.
 */

try {
  const dotenv = require('dotenv');
  const path = require('path');
  dotenv.configDotenv({ path: process.env.BRAINX_ENV || path.join(__dirname, '..', '.env'), quiet: true });
} catch (_) {}

const fs = require('fs');
const path = require('path');
const {
  SKILL_CANDIDATE_TAGS,
  createCandidateFromRow,
  groupCandidates,
  loadExistingSkillNames,
  buildCandidateMemoryContent,
  formatCandidateSummary,
  hashId,
  hasKnownSkillName,
  inferSkillName,
  extractInstructionBullets,
  normalizeText,
  toSlug,
  containsSecretLike,
  isChatStatusNoise,
  isPromotionMetaNoise,
  isOneOffOperationalReport,
  isProjectSpecificInstruction,
} = require('../lib/skill-promotion');
const {
  applyCandidate,
  extractDraftFromCandidateFile,
  classifyPatchRisk,
} = require('../lib/skill-applier');
const lifecycle = require('../lib/skill-lifecycle');
const { isOpsAgent } = require('../lib/ops-agents');

const DEFAULT_SESSIONS_ROOT = path.join(process.env.HOME || '', '.openclaw', 'agents');
const RAW_SESSION_ACTIONABLE_RE = /^(siempre|nunca|cuando|antes|despues|después|usar|usa|validar|verificar|ejecutar|leer|extraer|agrupar|confirmar|emitir|crear|generar|preferir|evitar|always|never|when|before|after|use|run|check|verify|prefer|avoid|create|generate|do not)\b/i;
const RAW_SESSION_STYLE_ACTIONABLE_RE = /\b(prefiere|prefers|valora|molesta|evitar|evita|avoid|sin\s+relleno|directo|conciso|escaneable|markdown|tablas?|tables|tono|estilo|voice|vibe|formato|reports?|respuesta|responder)\b/i;
const RAW_SESSION_NOISE_RE = [
  /https?:\/\/\S+/i,
  /\b(voy a|estoy|estamos|hago|te paso|te mando|cuando me digas|espero tu|espero tu decisión)\b/i,
  /\b(commiteo|pusheo|push a|sub[ií]o a|lo sub[ií]o|cuando aterrice|cuando termine)\b/i,
  /\b(confirmame|conf[ií]rmame|cuando quieras|cuando aterricen|cuando cambie algo|refresc[aá]s)\b/i,
  /\b(despu[eé]s valido|luego valido|ahora valido)\b/i,
  /\bdeploys?\b.*\b(screenshot|captura|cross-resolution|side-by-side|pixel-perfect)\b/i,
  /\b(screenshot|captura|side-by-side|pixel-perfect)\b.*\b(te paso|te mando|cuando)\b/i,
  /\b(te paso|te mando|cuando)\b.*\b(screenshot|captura|side-by-side|pixel-perfect)\b/i,
  /\b(este debe tener|esto debe tener|scope is clear if|lead lists specific)\b/i,
  /\b(bucket|cay[oó]\s+en\s+el\s+bucket|similitud\s+sem[aá]ntica|semantic\s+similarity)\b/i,
];
const CONFIRMATION_STOP_WORDS = new Set([
  'antes', 'after', 'before', 'cuando', 'when', 'para', 'por', 'con', 'sin',
  'debe', 'deben', 'must', 'should', 'usar', 'use', 'leer', 'read', 'hacer',
  'tarea', 'task', 'scope', 'segun', 'según', 'este', 'esta', 'esto', 'that',
  'this', 'real',
]);

function parseArgs(argv) {
  const args = {
    minRecurrence: parseInt(process.env.BRAINX_SKILL_PROMOTER_MIN_RECURRENCE || '4', 10),
    days: 60,
    limit: 30,
    perAgent: false,
    agentLimit: 80,
    perAgentLimit: 20,
    hybrid: false,
    sessionLimit: 120,
    perAgentSessionLimit: 8,
    sessionsRoot: DEFAULT_SESSIONS_ROOT,
    minScore: 0.58,
    json: false,
    save: false,
    apply: false,
    autoCreate: false,
    autoPatch: false,
    autoCreateMinConfidence: parseFloat(process.env.BRAINX_SKILL_PROMOTER_AUTO_CREATE_MIN_CONFIDENCE || '0.86'),
    autoCreateMinRecurrence: parseInt(process.env.BRAINX_SKILL_PROMOTER_AUTO_CREATE_MIN_RECURRENCE || '2', 10),
    autoCreateMinSourceCount: parseInt(process.env.BRAINX_SKILL_PROMOTER_AUTO_CREATE_MIN_SOURCE_COUNT || '2', 10),
    autoPatchMinConfidence: parseFloat(process.env.BRAINX_SKILL_PROMOTER_AUTO_PATCH_MIN_CONFIDENCE || '0.9'),
    autoPatchMinRecurrence: parseInt(process.env.BRAINX_SKILL_PROMOTER_AUTO_PATCH_MIN_RECURRENCE || '2', 10),
    autoPatchMinSourceCount: parseInt(process.env.BRAINX_SKILL_PROMOTER_AUTO_PATCH_MIN_SOURCE_COUNT || '2', 10),
    autoPatchRequireRawSession: process.env.BRAINX_SKILL_PROMOTER_AUTO_PATCH_REQUIRE_RAW_SESSION !== '0',
    autoPatchRequireBrainxConfirmation: process.env.BRAINX_SKILL_PROMOTER_AUTO_PATCH_REQUIRE_BRAINX_CONFIRMATION !== '0',
    autoCreateRequireRawSession: process.env.BRAINX_SKILL_PROMOTER_AUTO_CREATE_REQUIRE_RAW_SESSION !== '0',
    autoCreateRequireBrainxConfirmation: process.env.BRAINX_SKILL_PROMOTER_AUTO_CREATE_REQUIRE_BRAINX_CONFIRMATION !== '0',
    dryRun: false,
    emitDir: null,
    candidateFile: null,
    skill: null,
    all: false,
    allowExistingPatch: false,
    skipValidation: false,
    skillsRoot: null,
    auditDir: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    const next = argv[i + 1];
    if (current === '--min-recurrence' && next) args.minRecurrence = parseInt(next, 10) || args.minRecurrence;
    else if (current === '--days' && next) args.days = parseInt(next, 10) || args.days;
    else if (current === '--limit' && next) args.limit = parseInt(next, 10) || args.limit;
    else if (current === '--per-agent') args.perAgent = true;
    else if (current === '--agent-limit' && next) args.agentLimit = parseInt(next, 10) || args.agentLimit;
    else if (current === '--per-agent-limit' && next) args.perAgentLimit = parseInt(next, 10) || args.perAgentLimit;
    else if (current === '--hybrid') args.hybrid = true;
    else if (current === '--session-limit' && next) args.sessionLimit = parseInt(next, 10) || args.sessionLimit;
    else if (current === '--per-agent-session-limit' && next) args.perAgentSessionLimit = parseInt(next, 10) || args.perAgentSessionLimit;
    else if (current === '--sessions-root' && next) args.sessionsRoot = next;
    else if (current === '--min-score' && next) args.minScore = parseFloat(next) || args.minScore;
    else if (current === '--json') args.json = true;
    else if (current === '--save') args.save = true;
    else if (current === '--apply') args.apply = true;
    else if (current === '--auto-create') args.autoCreate = true;
    else if (current === '--auto-patch') args.autoPatch = true;
    else if (current === '--auto-create-min-confidence' && next) args.autoCreateMinConfidence = parseFloat(next) || args.autoCreateMinConfidence;
    else if (current === '--auto-create-min-recurrence' && next) args.autoCreateMinRecurrence = parseInt(next, 10) || args.autoCreateMinRecurrence;
    else if (current === '--auto-create-min-source-count' && next) args.autoCreateMinSourceCount = parseInt(next, 10) || args.autoCreateMinSourceCount;
    else if (current === '--auto-create-no-raw-session') args.autoCreateRequireRawSession = false;
    else if (current === '--auto-create-no-brainx-confirmation') args.autoCreateRequireBrainxConfirmation = false;
    else if (current === '--auto-patch-min-confidence' && next) args.autoPatchMinConfidence = parseFloat(next) || args.autoPatchMinConfidence;
    else if (current === '--auto-patch-min-recurrence' && next) args.autoPatchMinRecurrence = parseInt(next, 10) || args.autoPatchMinRecurrence;
    else if (current === '--auto-patch-min-source-count' && next) args.autoPatchMinSourceCount = parseInt(next, 10) || args.autoPatchMinSourceCount;
    else if (current === '--auto-patch-no-raw-session') args.autoPatchRequireRawSession = false;
    else if (current === '--auto-patch-no-brainx-confirmation') args.autoPatchRequireBrainxConfirmation = false;
    else if (current === '--dry-run') args.dryRun = true;
    else if (current === '--emit-dir' && next) args.emitDir = next;
    else if (current === '--candidate-file' && next) args.candidateFile = next;
    else if (current === '--skill' && next) args.skill = next;
    else if (current === '--all') args.all = true;
    else if (current === '--allow-existing-patch') args.allowExistingPatch = true;
    else if (current === '--skip-validation') args.skipValidation = true;
    else if (current === '--skills-root' && next) args.skillsRoot = next;
    else if (current === '--audit-dir' && next) args.auditDir = next;
    if (['--min-recurrence', '--days', '--limit', '--agent-limit', '--per-agent-limit', '--session-limit', '--per-agent-session-limit', '--sessions-root', '--min-score', '--auto-create-min-confidence', '--auto-create-min-recurrence', '--auto-create-min-source-count', '--auto-patch-min-confidence', '--auto-patch-min-recurrence', '--auto-patch-min-source-count', '--emit-dir', '--candidate-file', '--skill', '--skills-root', '--audit-dir'].includes(current) && next) i++;
  }
  return args;
}

function getDb() {
  return require(path.join(__dirname, '..', 'lib', 'db'));
}

async function fetchRows(db, args) {
  const rows = [];
  const patternSql = [
    'SELECT',
    "  'pattern' AS source,",
    '  p.pattern_key,',
    '  p.recurrence_count,',
    '  p.first_seen,',
    '  p.last_seen,',
    '  p.impact_score,',
    '  p.representative_memory_id,',
    '  p.last_memory_id,',
    '  p.last_category,',
    '  p.last_status,',
    '  p.promoted_to,',
    '  COALESCE(m.content, p.pattern_key) AS content,',
    '  m.type,',
    '  m.category,',
    '  m.tags,',
    '  m.importance,',
    '  m.access_count,',
    '  m.agent,',
    '  m.context,',
    '  m.source_kind,',
    '  m.source_path,',
    '  m.sensitivity,',
    '  m.verification_state',
    'FROM brainx_patterns p',
    'LEFT JOIN brainx_memories m ON m.id = p.representative_memory_id',
    'WHERE p.recurrence_count >= $1',
    "  AND p.last_seen >= NOW() - make_interval(days => $2)",
    "  AND COALESCE(p.last_status, 'pending') NOT IN ('resolved', 'wont_fix')",
    '  AND p.promoted_to IS NULL',
    "  AND p.pattern_key NOT LIKE 'tool-failure:%'",
    '  AND (m.id IS NULL OR (',
    '    m.superseded_by IS NULL',
    "    AND COALESCE(m.status, 'pending') NOT IN ('resolved', 'wont_fix')",
    "    AND COALESCE(m.verification_state, 'hypothesis') != 'obsolete'",
    "    AND COALESCE(m.sensitivity, 'normal') != 'restricted'",
    "    AND m.type IN ('learning', 'gotcha', 'decision', 'fact')",
    '  ))',
    'ORDER BY p.recurrence_count DESC, p.impact_score DESC NULLS LAST, p.last_seen DESC',
    'LIMIT $3',
  ].join('\n');
  const patternRows = await db.query(patternSql, [args.minRecurrence, args.days, args.limit]);
  rows.push(...patternRows.rows);

  const memorySql = [
    'SELECT',
    "  'memory' AS source,",
    '  id,',
    '  pattern_key,',
    '  recurrence_count,',
    '  first_seen,',
    '  last_seen,',
    '  content,',
    '  type,',
    '  category,',
    '  tags,',
    '  importance,',
    '  access_count,',
    '  agent,',
    '  context,',
    '  source_kind,',
    '  source_path,',
    '  sensitivity,',
    '  verification_state',
    'FROM brainx_memories',
    'WHERE superseded_by IS NULL',
    "  AND COALESCE(status, 'pending') NOT IN ('resolved', 'wont_fix')",
    "  AND COALESCE(verification_state, 'hypothesis') != 'obsolete'",
    "  AND COALESCE(sensitivity, 'normal') != 'restricted'",
    "  AND type IN ('learning', 'gotcha', 'decision', 'fact')",
    '  AND (',
    '    COALESCE(recurrence_count, 1) >= $1',
    '    OR COALESCE(access_count, 0) >= GREATEST(3, $1)',
    '  )',
    '  AND last_seen >= NOW() - make_interval(days => $2)',
    "  AND NOT ('promotion-suggestion' = ANY(tags))",
    "  AND NOT ('skill-candidate' = ANY(tags))",
    "  AND NOT ('tool-failure' = ANY(tags))",
    'ORDER BY COALESCE(recurrence_count, 1) DESC, importance DESC, last_seen DESC',
    'LIMIT $3',
  ].join('\n');
  const memoryRows = await db.query(memorySql, [args.minRecurrence, args.days, args.limit]);
  rows.push(...memoryRows.rows);

  let agentCoverage = null;
  if (args.perAgent) {
    const scoped = await fetchRowsByAgent(db, args);
    rows.push(...scoped.rows);
    agentCoverage = scoped.agentCoverage;
  }

  let sessionCoverage = null;
  if (args.hybrid) {
    const scoped = fetchRowsFromSessions(args, rows);
    rows.push(...scoped.rows);
    sessionCoverage = scoped.sessionCoverage;
  }

  const deduped = dedupeRows(rows);
  if (agentCoverage) deduped.agentCoverage = agentCoverage;
  if (sessionCoverage) deduped.sessionCoverage = sessionCoverage;
  return deduped;
}

function rowDedupeKey(row) {
  const memoryId = row && (row.id || row.memory_id || row.representative_memory_id || row.last_memory_id);
  if (memoryId) return 'brainx-memory:' + String(memoryId);
  const patternKey = row && row.pattern_key;
  if (patternKey) return 'brainx-pattern:' + String(patternKey);
  const sourceSession = row && row.source_session;
  if (sourceSession) return 'session:' + String(sourceSession) + ':' + normalizeInstructionKey(row.content || row.description || '');
  return 'row:' + hashId('row', JSON.stringify(row || {}));
}

function dedupeRows(rows) {
  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    const key = rowDedupeKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

async function fetchRowsByAgent(db, args) {
  const agentLimit = Math.max(1, Number(args.agentLimit || 80));
  const perAgentLimit = Math.max(1, Number(args.perAgentLimit || 20));
  const agentSql = [
    "SELECT COALESCE(NULLIF(agent, ''), 'unknown') AS agent,",
    '  COUNT(*)::int AS rows,',
    "  COUNT(*) FILTER (WHERE type IN ('learning', 'gotcha', 'decision', 'fact'))::int AS typed_rows,",
    "  COUNT(*) FILTER (WHERE type IN ('learning', 'gotcha', 'decision', 'fact') AND (COALESCE(recurrence_count, 1) >= $1 OR COALESCE(access_count, 0) >= GREATEST(3, $1)))::int AS candidate_rows,",
    '  MAX(last_seen) AS last_seen',
    'FROM brainx_memories',
    'WHERE superseded_by IS NULL',
    "  AND COALESCE(status, 'pending') NOT IN ('resolved', 'wont_fix')",
    "  AND COALESCE(verification_state, 'hypothesis') != 'obsolete'",
    "  AND COALESCE(sensitivity, 'normal') != 'restricted'",
    '  AND last_seen >= NOW() - make_interval(days => $2)',
    'GROUP BY 1',
    "HAVING COUNT(*) FILTER (WHERE type IN ('learning', 'gotcha', 'decision', 'fact') AND (COALESCE(recurrence_count, 1) >= $1 OR COALESCE(access_count, 0) >= GREATEST(3, $1))) > 0",
    'ORDER BY candidate_rows DESC, rows DESC, last_seen DESC',
    'LIMIT $3',
  ].join('\n');
  const agentResult = await db.query(agentSql, [args.minRecurrence, args.days, agentLimit]);

  const memorySql = [
    'SELECT',
    "  'memory' AS source,",
    '  id,',
    '  pattern_key,',
    '  recurrence_count,',
    '  first_seen,',
    '  last_seen,',
    '  content,',
    '  type,',
    '  category,',
    '  tags,',
    '  importance,',
    '  access_count,',
    '  agent,',
    '  context,',
    '  source_kind,',
    '  source_path,',
    '  sensitivity,',
    '  verification_state',
    'FROM brainx_memories',
    'WHERE superseded_by IS NULL',
    "  AND COALESCE(status, 'pending') NOT IN ('resolved', 'wont_fix')",
    "  AND COALESCE(verification_state, 'hypothesis') != 'obsolete'",
    "  AND COALESCE(sensitivity, 'normal') != 'restricted'",
    "  AND type IN ('learning', 'gotcha', 'decision', 'fact')",
    '  AND (',
    '    COALESCE(recurrence_count, 1) >= $1',
    '    OR COALESCE(access_count, 0) >= GREATEST(3, $1)',
    '  )',
    '  AND last_seen >= NOW() - make_interval(days => $2)',
    "  AND COALESCE(NULLIF(agent, ''), 'unknown') = $4",
    "  AND NOT ('promotion-suggestion' = ANY(tags))",
    "  AND NOT ('skill-candidate' = ANY(tags))",
    "  AND NOT ('tool-failure' = ANY(tags))",
    'ORDER BY COALESCE(recurrence_count, 1) DESC, importance DESC, last_seen DESC',
    'LIMIT $3',
  ].join('\n');

  const patternSql = [
    'SELECT',
    "  'pattern' AS source,",
    '  p.pattern_key,',
    '  p.recurrence_count,',
    '  p.first_seen,',
    '  p.last_seen,',
    '  p.impact_score,',
    '  p.representative_memory_id,',
    '  p.last_memory_id,',
    '  p.last_category,',
    '  p.last_status,',
    '  p.promoted_to,',
    '  COALESCE(m.content, p.pattern_key) AS content,',
    '  m.type,',
    '  m.category,',
    '  m.tags,',
    '  m.importance,',
    '  m.access_count,',
    '  m.agent,',
    '  m.context,',
    '  m.source_kind,',
    '  m.source_path,',
    '  m.sensitivity,',
    '  m.verification_state',
    'FROM brainx_patterns p',
    'LEFT JOIN brainx_memories m ON m.id = p.representative_memory_id',
    'WHERE p.recurrence_count >= $1',
    '  AND p.last_seen >= NOW() - make_interval(days => $2)',
    "  AND COALESCE(NULLIF(m.agent, ''), 'unknown') = $4",
    "  AND COALESCE(p.last_status, 'pending') NOT IN ('resolved', 'wont_fix')",
    '  AND p.promoted_to IS NULL',
    "  AND p.pattern_key NOT LIKE 'tool-failure:%'",
    '  AND (m.id IS NULL OR (',
    '    m.superseded_by IS NULL',
    "    AND COALESCE(m.status, 'pending') NOT IN ('resolved', 'wont_fix')",
    "    AND COALESCE(m.verification_state, 'hypothesis') != 'obsolete'",
    "    AND COALESCE(m.sensitivity, 'normal') != 'restricted'",
    "    AND m.type IN ('learning', 'gotcha', 'decision', 'fact')",
    '  ))',
    'ORDER BY p.recurrence_count DESC, p.impact_score DESC NULLS LAST, p.last_seen DESC',
    'LIMIT $3',
  ].join('\n');

  const rows = [];
  for (const agent of agentResult.rows.map((row) => row.agent)) {
    const [memoryRows, patternRows] = await Promise.all([
      db.query(memorySql, [args.minRecurrence, args.days, perAgentLimit, agent]),
      db.query(patternSql, [args.minRecurrence, args.days, perAgentLimit, agent]),
    ]);
    rows.push(...memoryRows.rows, ...patternRows.rows);
  }

  return {
    rows,
    agentCoverage: {
      enabled: true,
      agentLimit,
      perAgentLimit,
      agentCount: agentResult.rows.length,
      agents: agentResult.rows,
    },
  };
}

function findRecentSessionFiles(args) {
  const root = args.sessionsRoot || DEFAULT_SESSIONS_ROOT;
  const cutoff = Date.now() - Math.max(1, Number(args.days || 60)) * 24 * 60 * 60 * 1000;
  const files = [];
  const stack = [root];
  const seen = new Set();

  while (stack.length) {
    const dir = stack.pop();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl') || entry.name.endsWith('.trajectory.jsonl')) continue;
      if (!full.split(path.sep).includes('sessions')) continue;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch (_) {
        continue;
      }
      if (stat.mtimeMs < cutoff) continue;
      const agent = resolveAgentFromSessionPath(root, full);
      if (!agent || isOpsAgent(agent)) continue;
      files.push({
        agent,
        sessionId: path.basename(full).replace(/\.jsonl$/, ''),
        sourceSession: hashId('session', agent + '|' + full),
        path: full,
        modified: stat.mtimeMs,
        size: stat.size,
      });
    }
  }

  files.sort((a, b) => b.modified - a.modified);
  const perAgentLimit = Math.max(1, Number(args.perAgentSessionLimit || 8));
  const totalLimit = Math.max(1, Number(args.sessionLimit || 120));
  const counts = new Map();
  const selected = [];
  for (const file of files) {
    const count = counts.get(file.agent) || 0;
    if (count >= perAgentLimit) continue;
    counts.set(file.agent, count + 1);
    selected.push(file);
    if (selected.length >= totalLimit) break;
  }
  return selected;
}

function resolveAgentFromSessionPath(root, filePath) {
  const relative = path.relative(root, filePath);
  const first = relative.split(path.sep)[0];
  return first && first !== '..' ? first : null;
}

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block) return '';
      if (typeof block === 'string') return block;
      return block.text || block.input_text || block.output_text || '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractMessageRecord(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.type === 'message' && entry.message) {
    const role = entry.message.role;
    if (!['user', 'assistant'].includes(role)) return null;
    return {
      role,
      text: flattenContent(entry.message.content),
      timestamp: entry.timestamp || entry.message.timestamp || null,
    };
  }
  if (entry.type === 'response_item' && entry.payload && entry.payload.type === 'message') {
    const role = entry.payload.role;
    if (!['user', 'assistant'].includes(role)) return null;
    return {
      role,
      text: flattenContent(entry.payload.content),
      timestamp: entry.timestamp || null,
    };
  }
  return null;
}

function isSyntheticTranscriptEnvelope(text) {
  const value = String(text || '').trim();
  if (!value) return true;
  if (/^# AGENTS\.md instructions\b/i.test(value)) return true;
  if (/^Conversation info \(untrusted metadata\):/i.test(value)) return true;
  if (/^System \(untrusted\):/i.test(value)) return true;
  if (/^<permissions instructions>/i.test(value)) return true;
  if (/OpenClaw assembled context for this turn:/i.test(value)) return true;
  if (/<conversation_context>/i.test(value)) return true;
  if (/Current user request:/i.test(value) && /Untrusted context/i.test(value)) return true;
  if (/You are Codex, a coding agent based on/i.test(value)) return true;
  return false;
}

function cleanInstructionLine(line) {
  return normalizeText(String(line || '')
    .replace(/^[-*]\s*/, '')
    .replace(/^\d+[.)]\s*/, '')
    .replace(/^>\s*/, '')
    .replace(/\s+/g, ' '));
}

function normalizeInstructionKey(text) {
  return toSlug(String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' url ')
    .replace(/\b[0-9a-f]{8,}\b/gi, ' id ')
    .replace(/\b\d{2,}\b/g, ' n ')
    .replace(/\s+/g, ' ')
    .slice(0, 180), 'instruction');
}

function extractProceduralInstructions(text, max = 8) {
  if (isSyntheticTranscriptEnvelope(text)) return [];
  if (isPromotionMetaNoise(text)) return [];
  const bullets = extractInstructionBullets(text, max * 2)
    .map((line) => cleanInstructionLine(line.replace(/^[-*]\s*/, '')))
    .filter(Boolean);
  const seen = new Set();
  const instructions = [];
  for (const instruction of bullets) {
    if (instruction.length < 24 || instruction.length > 320) continue;
    if (!RAW_SESSION_ACTIONABLE_RE.test(instruction) && !RAW_SESSION_STYLE_ACTIONABLE_RE.test(instruction)) continue;
    if (/[?¿]\s*$/.test(instruction)) continue;
    if (/[:：]\s*$/.test(instruction)) continue;
    if (RAW_SESSION_NOISE_RE.some((pattern) => pattern.test(instruction))) continue;
    if (containsSecretLike(instruction)) continue;
    const isStyleProcedure = RAW_SESSION_STYLE_ACTIONABLE_RE.test(instruction);
    if (isChatStatusNoise(instruction) || (isOneOffOperationalReport(instruction) && !isStyleProcedure)) continue;
    if (isProjectSpecificInstruction(instruction) && !isStyleProcedure) continue;
    const key = normalizeInstructionKey(instruction);
    if (seen.has(key)) continue;
    seen.add(key);
    instructions.push(instruction);
    if (instructions.length >= max) break;
  }
  return instructions;
}

function confirmationTokens(text) {
  return normalizeText(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4)
    .filter((token) => !CONFIRMATION_STOP_WORDS.has(token));
}

function confirmationSimilarity(instructionTokens, confirmationTokensValue) {
  if (!instructionTokens.length || !confirmationTokensValue.length) return 0;
  const instructionSet = new Set(instructionTokens);
  const confirmationSet = new Set(confirmationTokensValue);
  let overlap = 0;
  for (const token of instructionSet) {
    if (confirmationSet.has(token)) overlap += 1;
  }
  if (overlap < 2) return 0;
  const minCoverage = overlap / Math.min(instructionSet.size, confirmationSet.size);
  const union = new Set([...instructionSet, ...confirmationSet]);
  const jaccard = overlap / union.size;
  if (minCoverage < 0.2 && jaccard < 0.14) return 0;
  return Number(Math.max(minCoverage, jaccard).toFixed(3));
}

function buildConfirmationIndex(rows) {
  const index = new Map();
  for (const row of rows || []) {
    if (!row || row.source === 'session' || row.source_kind === 'raw_session') continue;
    const skillName = inferSkillName(row);
    if (!skillName) continue;
    const sourceId = row.id || row.memory_id || row.representative_memory_id || row.pattern_key;
    if (!sourceId) continue;
    const text = normalizeText([
      row.content,
      row.representative_content,
      row.description,
      row.pattern_key,
    ].filter(Boolean).join('\n'));
    const tokens = confirmationTokens(text);
    if (tokens.length < 2) continue;
    if (!index.has(skillName)) index.set(skillName, []);
    const bucket = index.get(skillName);
    if (bucket.length < 16) bucket.push({ id: sourceId, tokens });
  }
  return index;
}

function findInstructionConfirmations(confirmationIndex, skillName, instruction) {
  const bucket = confirmationIndex.get(skillName) || [];
  if (!bucket.length) return [];
  const instructionTokens = confirmationTokens(instruction);
  return bucket
    .map((entry) => ({
      id: entry.id,
      score: confirmationSimilarity(instructionTokens, entry.tokens),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 8)
    .map((entry) => entry.id);
}

function fetchRowsFromSessions(args, confirmationRows = []) {
  const files = findRecentSessionFiles(args);
  const confirmationIndex = buildConfirmationIndex(confirmationRows);
  const rows = [];
  const byAgent = {};
  const seenInstructions = new Map();
  let messagesScanned = 0;
  let messagesSkipped = 0;
  let instructionsExtracted = 0;

  for (const file of files) {
    byAgent[file.agent] = byAgent[file.agent] || {
      sessions: 0,
      messages: 0,
      instructions: 0,
    };
    byAgent[file.agent].sessions += 1;
    let content = '';
    try {
      content = fs.readFileSync(file.path, 'utf8');
    } catch (_) {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (_) {
        continue;
      }
      const message = extractMessageRecord(entry);
      if (!message || !message.text) continue;
      messagesScanned += 1;
      byAgent[file.agent].messages += 1;
      const instructions = extractProceduralInstructions(message.text);
      if (!instructions.length) {
        messagesSkipped += 1;
        continue;
      }
      for (const instruction of instructions) {
        const skillName = inferSkillName({
          content: instruction,
          tags: ['workflow', 'raw-session'],
          source_kind: 'raw_session',
        });
        const instructionKey = skillName + ':' + normalizeInstructionKey(instruction);
        const existing = seenInstructions.get(instructionKey);
        if (existing) {
          existing.recurrence_count += 1;
          existing.sourceSessions = Array.from(new Set(existing.sourceSessions.concat(file.sourceSession)));
          existing.agents = Array.from(new Set(existing.agents.concat(file.agent)));
          continue;
        }
        const confirmations = findInstructionConfirmations(confirmationIndex, skillName, instruction);
        if (!confirmations.length) continue;
        const id = hashId('sraw', file.agent + '|' + file.sourceSession + '|' + instructionKey);
        seenInstructions.set(instructionKey, {
          source: 'session',
          id,
          pattern_key: 'raw-session:' + skillName + ':' + normalizeInstructionKey(instruction).slice(0, 48),
          recurrence_count: 1,
          first_seen: new Date(file.modified).toISOString(),
          last_seen: new Date(file.modified).toISOString(),
          content: instruction,
          type: 'learning',
          category: 'best_practice',
          tags: ['workflow', 'raw-session'],
          importance: 6,
          access_count: 0,
          agent: file.agent,
          context: 'agent:' + file.agent,
          source_kind: 'raw_session',
          source_path: 'openclaw-session-jsonl',
          source_session: file.sourceSession,
          sourceSessions: [file.sourceSession],
          agents: [file.agent],
          brainx_confirmation: confirmations,
          brainxConfirmations: confirmations,
          sensitivity: 'normal',
          verification_state: 'hypothesis',
        });
        instructionsExtracted += 1;
        byAgent[file.agent].instructions += 1;
      }
    }
  }

  rows.push(...Array.from(seenInstructions.values()));
  return {
    rows,
    sessionCoverage: {
      enabled: true,
      root: args.sessionsRoot || DEFAULT_SESSIONS_ROOT,
      days: args.days,
      sessionLimit: args.sessionLimit,
      perAgentSessionLimit: args.perAgentSessionLimit,
      sessionsScanned: files.length,
      agentsScanned: Object.keys(byAgent).length,
      messagesScanned,
      messagesSkipped,
      instructionsExtracted,
      instructionRows: rows.length,
      confirmedInstructionRows: rows.filter((row) => (row.brainxConfirmations || []).length > 0).length,
      byAgent,
    },
  };
}

async function saveCandidates(db, candidates) {
  let saved = 0;
  const sql = [
    'INSERT INTO brainx_memories (',
    '  id, content, type, tier, importance, category, tags, source_kind,',
    '  agent, status, verification_state, pattern_key, recurrence_count,',
    '  first_seen, last_seen, promoted_to, created_at',
    ')',
    'VALUES (',
    "  $1, $2, 'decision', 'warm', 7, 'best_practice', $3,",
    "  'agent_inference', 'system', 'pending', 'hypothesis', $4, $5,",
    '  NOW(), NOW(), $6, NOW()',
    ')',
    'ON CONFLICT (id) DO NOTHING',
  ].join('\n');

  for (const candidate of candidates) {
    const content = buildCandidateMemoryContent(candidate);
    const id = hashId('m_skill_candidate', content);
    await db.query(sql, [
      id,
      content,
      SKILL_CANDIDATE_TAGS,
      candidate.patternKeys[0] || candidate.skillName,
      Math.max(1, Math.round(candidate.recurrence || 1)),
      'skill_candidate:' + candidate.skillName,
    ]);
    saved += 1;
  }
  return saved;
}

function emitCandidateFiles(emitDir, candidates) {
  fs.mkdirSync(emitDir, { recursive: true });
  const written = [];
  for (const candidate of candidates) {
    const filePath = path.join(emitDir, candidate.skillName + '.candidate.md');
    const body = [
      '# Skill Candidate: ' + candidate.skillName,
      '',
      '- Action: ' + candidate.action,
      '- Confidence: ' + candidate.confidence,
      '- Recurrence: ' + candidate.recurrence + 'x',
      '- Sources: ' + (candidate.sourceIds.join(', ') || 'unknown'),
      '',
      '## Agent-Core Registration Checklist',
      '',
      ...((candidate.registrationChecklist || []).map((item) => '- ' + item)),
      '',
      '## Draft SKILL.md',
      '',
      '~~~markdown',
      candidate.draftSkillMd.trim(),
      '~~~',
      '',
    ].join('\n');
    fs.writeFileSync(filePath, body, 'utf8');
    written.push(filePath);
  }
  return written;
}

function selectApplyCandidates(candidates, args) {
  if (args.candidateFile) return candidates;
  if (args.skill) {
    return candidates.filter((candidate) => candidate.skillName === args.skill);
  }
  if (args.all) return candidates;
  throw new Error('Refusing --apply without --skill, --candidate-file, or --all.');
}

function applyCandidates(candidates, args, deps = {}) {
  const selected = selectApplyCandidates(candidates, args);
  const applied = [];
  const skipped = [];
  const errors = [];

  for (const candidate of selected) {
    try {
      const result = (deps.applyCandidate || applyCandidate)(candidate, {
        skillsRoot: args.skillsRoot,
        dryRun: args.dryRun,
        allowExistingPatch: args.allowExistingPatch,
        validate: !args.skipValidation,
        runCommand: deps.runCommand,
        regenScript: deps.regenScript,
        openclawBin: deps.openclawBin,
      });
      if (result.skipped) skipped.push(result);
      else applied.push(result);
    } catch (err) {
      errors.push({
        skillName: candidate.skillName,
        error: err.message || String(err),
      });
    }
  }

  return { selected: selected.length, applied, skipped, errors };
}

function skillNameTokens(value) {
  return toSlug(value || '')
    .split('-')
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function hasSimilarExistingSkillName(skillName, existingSkillNames) {
  if (hasKnownSkillName(existingSkillNames, skillName)) return true;
  const candidateSlug = toSlug(skillName || '');
  const candidateTokens = skillNameTokens(candidateSlug);
  if (!candidateSlug || !candidateTokens.length || !(existingSkillNames instanceof Set)) return false;
  for (const existing of existingSkillNames) {
    const existingSlug = toSlug(existing || '');
    if (!existingSlug || existingSlug === candidateSlug) continue;
    if (candidateSlug.startsWith(existingSlug + '-') || existingSlug.startsWith(candidateSlug + '-')) return true;
    const existingTokens = skillNameTokens(existingSlug);
    if (!existingTokens.length) continue;
    const existingSet = new Set(existingTokens);
    const overlap = candidateTokens.filter((token) => existingSet.has(token)).length;
    const coverage = overlap / Math.min(candidateTokens.length, existingTokens.length);
    if (overlap >= 2 && coverage >= 0.67) return true;
  }
  return false;
}

function autoCreateGate(candidate, args, existingSkillNames) {
  if (!candidate || candidate.action !== 'create_new_skill') return 'not_create_new_skill';
  const confidence = Number(candidate.confidence || 0);
  if (confidence < Number(args.autoCreateMinConfidence || 0.86)) return 'confidence_below_threshold';
  const recurrence = Number(candidate.recurrence || 0);
  if (recurrence < Number(args.autoCreateMinRecurrence || 2)) return 'recurrence_below_threshold';
  const sourceCount = Number(candidate.sourceCount || (candidate.sourceIds || []).length || 0);
  if (sourceCount < Number(args.autoCreateMinSourceCount || 2)) return 'source_count_below_threshold';
  const hasRawSessionEvidence = (candidate.sourceKinds || []).includes('raw_session') || (candidate.sourceSessions || []).length > 0 || candidate.source === 'session';
  if (args.autoCreateRequireRawSession !== false && !hasRawSessionEvidence) return 'missing_raw_session_evidence';
  if (args.autoCreateRequireBrainxConfirmation !== false && candidate.brainxConfirmed !== true) return 'missing_brainx_confirmation';
  if (hasSimilarExistingSkillName(candidate.skillName, existingSkillNames)) return 'similar_existing_skill';
  if (!candidate.draftSkillMd || !String(candidate.draftSkillMd).trim().startsWith('---')) return 'invalid_draft';
  return null;
}

function selectAutoCreateCandidates(candidates, args, existingSkillNames) {
  const selected = [];
  const skipped = [];
  for (const candidate of candidates || []) {
    const reason = autoCreateGate(candidate, args, existingSkillNames);
    if (reason) {
      skipped.push({
        skillName: candidate && candidate.skillName,
        action: candidate && candidate.action,
        reason,
      });
      continue;
    }
    selected.push(candidate);
  }
  return { selected, skipped };
}

function candidateSourceCount(candidate) {
  return Number(candidate && (candidate.sourceCount || (candidate.sourceIds || []).length) || 0);
}

function classifyManualReviewCandidate(candidate, gateReason) {
  if (!candidate || !gateReason) return null;
  const confidence = Number(candidate.confidence || 0);
  const recurrence = Number(candidate.recurrence || 0);
  const sourceCount = candidateSourceCount(candidate);
  const hasRawSessionEvidence = (candidate.sourceKinds || []).includes('raw_session') || (candidate.sourceSessions || []).length > 0 || candidate.source === 'session';
  const brainxConfirmations = Array.isArray(candidate.brainxConfirmations) ? candidate.brainxConfirmations.length : 0;
  const highEvidence = confidence >= 0.86 && recurrence >= 2 && sourceCount >= 2;
  const confirmed = hasRawSessionEvidence && (candidate.brainxConfirmed === true || brainxConfirmations > 0);
  const reason = String(gateReason || '');

  if (!highEvidence) return null;
  if (reason.startsWith('patch_risk_high:critical_skill')) {
    return {
      decision: 'manual_patch_required',
      reason,
      why: 'high-confidence evidence targets a critical skill; auto-patch is intentionally blocked',
    };
  }
  if (reason === 'not_create_new_skill' && candidate.action === 'extend_existing_skill') {
    return {
      decision: 'existing_skill_patch_required',
      reason,
      why: 'auto-create cannot patch existing skills',
    };
  }
  if (reason === 'not_existing_skill_patch' && candidate.action === 'create_new_skill') {
    return {
      decision: 'new_skill_review_required',
      reason,
      why: 'auto-patch cannot create new skills',
    };
  }
  if (confirmed && (reason === 'similar_existing_skill' || reason === 'target_skill_not_registered')) {
    return {
      decision: 'manual_routing_required',
      reason,
      why: 'candidate is confirmed but needs human target-skill routing',
    };
  }
  return null;
}

function summarizeManualReviewCandidates(candidates, skipped) {
  const byKey = new Map();
  for (const candidate of candidates || []) {
    byKey.set(String(candidate.skillName || '') + '|' + String(candidate.action || ''), candidate);
  }
  const out = [];
  const seen = new Set();
  for (const item of skipped || []) {
    const candidate = byKey.get(String(item.skillName || '') + '|' + String(item.action || ''));
    const review = classifyManualReviewCandidate(candidate, item.reason);
    if (!review) continue;
    const key = String(candidate.skillName || '') + '|' + review.decision + '|' + review.reason;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      skillName: candidate.skillName,
      action: candidate.action,
      decision: review.decision,
      reason: review.reason,
      why: review.why,
      confidence: candidate.confidence,
      recurrence: candidate.recurrence,
      sourceCount: candidateSourceCount(candidate),
      sourceKinds: candidate.sourceKinds || [],
      sourceSessions: Array.isArray(candidate.sourceSessions) ? candidate.sourceSessions.length : 0,
      brainxConfirmations: Array.isArray(candidate.brainxConfirmations) ? candidate.brainxConfirmations.length : 0,
      instructions: Array.isArray(candidate.instructions) ? candidate.instructions.slice(0, 3) : [],
    });
  }
  return out.sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0) || Number(b.recurrence || 0) - Number(a.recurrence || 0));
}

function autoCreateCandidates(candidates, args, deps = {}, existingSkillNames = new Set()) {
  const gated = selectAutoCreateCandidates(candidates, args, existingSkillNames);
  const applied = [];
  const errors = [];

  for (const candidate of gated.selected) {
    try {
      const result = (deps.applyCandidate || applyCandidate)(candidate, {
        skillsRoot: args.skillsRoot,
        dryRun: args.dryRun,
        allowExistingPatch: false,
        validate: !args.skipValidation,
        runCommand: deps.runCommand,
        regenScript: deps.regenScript,
        openclawBin: deps.openclawBin,
        auditDir: args.auditDir,
      });
      applied.push(result);
    } catch (err) {
      errors.push({
        skillName: candidate.skillName,
        error: err.message || String(err),
      });
    }
  }

  return {
    selected: gated.selected.length,
    applied,
    skipped: gated.skipped,
    manualReview: summarizeManualReviewCandidates(candidates, gated.skipped),
    errors,
    gates: {
      minConfidence: Number(args.autoCreateMinConfidence || 0.86),
      minRecurrence: Number(args.autoCreateMinRecurrence || 2),
      minSourceCount: Number(args.autoCreateMinSourceCount || 2),
      requireRawSession: args.autoCreateRequireRawSession !== false,
      requireBrainxConfirmation: args.autoCreateRequireBrainxConfirmation !== false,
    },
  };
}

function autoPatchGate(candidate, args, existingSkillNames) {
  if (!candidate || candidate.action !== 'extend_existing_skill') return 'not_existing_skill_patch';
  if (!hasKnownSkillName(existingSkillNames, candidate.skillName)) return 'target_skill_not_registered';
  const confidence = Number(candidate.confidence || 0);
  if (confidence < Number(args.autoPatchMinConfidence || 0.9)) return 'confidence_below_threshold';
  const recurrence = Number(candidate.recurrence || 0);
  if (recurrence < Number(args.autoPatchMinRecurrence || 2)) return 'recurrence_below_threshold';
  const sourceCount = Number(candidate.sourceCount || (candidate.sourceIds || []).length || 0);
  if (sourceCount < Number(args.autoPatchMinSourceCount || 2)) return 'source_count_below_threshold';
  const hasRawSessionEvidence = (candidate.sourceKinds || []).includes('raw_session') || (candidate.sourceSessions || []).length > 0 || candidate.source === 'session';
  if (args.autoPatchRequireRawSession !== false && !hasRawSessionEvidence) return 'missing_raw_session_evidence';
  if (args.autoPatchRequireBrainxConfirmation !== false && candidate.brainxConfirmed !== true) return 'missing_brainx_confirmation';
  const risk = classifyPatchRisk(candidate);
  if (!risk.allowed || risk.level !== 'low') return 'patch_risk_' + risk.level + ':' + risk.reasons.join(',');
  return null;
}

function selectAutoPatchCandidates(candidates, args, existingSkillNames) {
  const selected = [];
  const skipped = [];
  for (const candidate of candidates || []) {
    const reason = autoPatchGate(candidate, args, existingSkillNames);
    if (reason) {
      skipped.push({
        skillName: candidate && candidate.skillName,
        action: candidate && candidate.action,
        reason,
      });
      continue;
    }
    selected.push(candidate);
  }
  return { selected, skipped };
}

function autoPatchCandidates(candidates, args, deps = {}, existingSkillNames = new Set()) {
  const gated = selectAutoPatchCandidates(candidates, args, existingSkillNames);
  const applied = [];
  const errors = [];

  for (const candidate of gated.selected) {
    try {
      const result = (deps.applyCandidate || applyCandidate)(candidate, {
        skillsRoot: args.skillsRoot,
        dryRun: args.dryRun,
        allowExistingPatch: true,
        validate: !args.skipValidation,
        runCommand: deps.runCommand,
        regenScript: deps.regenScript,
        openclawBin: deps.openclawBin,
        auditDir: args.auditDir,
      });
      applied.push(result);
    } catch (err) {
      errors.push({
        skillName: candidate.skillName,
        error: err.message || String(err),
      });
    }
  }

  return {
    selected: gated.selected.length,
    applied,
    skipped: gated.skipped,
    manualReview: summarizeManualReviewCandidates(candidates, gated.skipped),
    errors,
    gates: {
      minConfidence: Number(args.autoPatchMinConfidence || 0.9),
      minRecurrence: Number(args.autoPatchMinRecurrence || 2),
      minSourceCount: Number(args.autoPatchMinSourceCount || 2),
      requireRawSession: args.autoPatchRequireRawSession !== false,
      requireBrainxConfirmation: args.autoPatchRequireBrainxConfirmation !== false,
      risk: 'low',
    },
  };
}

async function run(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const writeModes = [args.autoCreate, args.autoPatch, args.apply].filter(Boolean).length;
  if (writeModes > 1) throw new Error('Choose at most one of --auto-create, --auto-patch, or --apply.');
  if (args.autoCreate && args.allowExistingPatch) throw new Error('--auto-create never accepts --allow-existing-patch.');
  if (args.autoPatch && args.allowExistingPatch) throw new Error('--auto-patch controls existing patch eligibility internally; do not pass --allow-existing-patch.');
  const db = deps.db || (args.candidateFile ? null : getDb());
  const existingSkillNames = deps.existingSkillNames || loadExistingSkillNames();

  let rows = [];
  let candidates = [];
  if (args.candidateFile) {
    candidates = [extractDraftFromCandidateFile(args.candidateFile)];
  } else {
    rows = await fetchRows(db, args);
    const rawCandidates = rows
      .map((row) => createCandidateFromRow(row, { minScore: args.minScore, existingSkillNames }))
      .filter(Boolean);
    candidates = groupCandidates(rawCandidates).slice(0, args.limit);
  }

  const payload = {
    ok: true,
    mode: args.autoCreate
      ? (args.dryRun ? 'auto-create-dry-run' : 'auto-create')
      : args.autoPatch ? (args.dryRun ? 'auto-patch-dry-run' : 'auto-patch')
      : (args.apply ? (args.dryRun ? 'apply-dry-run' : 'apply') : (args.save && !args.dryRun ? 'save' : 'dry-run')),
    thresholds: {
      minRecurrence: args.minRecurrence,
      days: args.days,
      minScore: args.minScore,
      perAgent: args.perAgent,
      agentLimit: args.agentLimit,
      perAgentLimit: args.perAgentLimit,
      hybrid: args.hybrid,
      sessionLimit: args.sessionLimit,
      perAgentSessionLimit: args.perAgentSessionLimit,
      autoCreate: args.autoCreate,
      autoCreateMinConfidence: args.autoCreateMinConfidence,
      autoCreateMinRecurrence: args.autoCreateMinRecurrence,
      autoCreateMinSourceCount: args.autoCreateMinSourceCount,
      autoCreateRequireRawSession: args.autoCreateRequireRawSession,
      autoCreateRequireBrainxConfirmation: args.autoCreateRequireBrainxConfirmation,
      autoPatch: args.autoPatch,
      autoPatchMinConfidence: args.autoPatchMinConfidence,
      autoPatchMinRecurrence: args.autoPatchMinRecurrence,
      autoPatchMinSourceCount: args.autoPatchMinSourceCount,
      autoPatchRequireRawSession: args.autoPatchRequireRawSession,
      autoPatchRequireBrainxConfirmation: args.autoPatchRequireBrainxConfirmation,
    },
    rowsScanned: rows.length,
    count: candidates.length,
    candidates,
  };
  if (rows.agentCoverage) payload.agentCoverage = rows.agentCoverage;
  if (rows.sessionCoverage) payload.sessionCoverage = rows.sessionCoverage;

  if (args.emitDir) {
    payload.files = emitCandidateFiles(args.emitDir, candidates);
  }

  if (args.apply) {
    payload.apply = applyCandidates(candidates, args, deps);
    payload.ok = payload.apply.errors.length === 0;
  }

  if (args.autoCreate) {
    payload.autoCreate = autoCreateCandidates(candidates, args, deps, existingSkillNames);
    payload.ok = payload.autoCreate.errors.length === 0;
  }

  if (args.autoPatch) {
    payload.autoPatch = autoPatchCandidates(candidates, args, deps, existingSkillNames);
    payload.ok = payload.autoPatch.errors.length === 0;
  }

  if (args.save && !args.dryRun) {
    payload.saved = await saveCandidates(db, candidates);
  }

  return payload;
}

function printPayload(payload, args) {
  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('BrainX Skill Promoter — ' + payload.mode);
  console.log('scanned=' + payload.rowsScanned + ' candidates=' + payload.count + ' minRecurrence=' + args.minRecurrence + ' days=' + args.days + '\n');
  if (payload.agentCoverage) {
    console.log('per-agent scan: agents=' + payload.agentCoverage.agentCount + ' perAgentLimit=' + payload.agentCoverage.perAgentLimit + '\n');
  }
  if (payload.sessionCoverage) {
    console.log('session scan: sessions=' + payload.sessionCoverage.sessionsScanned + ' messages=' + payload.sessionCoverage.messagesScanned + ' instructions=' + payload.sessionCoverage.instructionsExtracted + ' confirmed=' + payload.sessionCoverage.confirmedInstructionRows + '\n');
  }
  if (!payload.candidates.length) {
    console.log('No skill candidates found.');
  } else {
    for (const candidate of payload.candidates) {
      console.log(formatCandidateSummary(candidate));
      console.log('');
    }
    if (!args.apply && !args.autoCreate) {
      console.log('Review gate: candidates are drafts. Use --apply with --skill, --candidate-file, or --all for Hermes-style creation/patching.');
      if (!args.save) console.log('Use --save only when you intentionally want to store drafts as BrainX memories.');
    }
  }
  if (payload.files && payload.files.length) {
    console.log('\nReview files:\n' + payload.files.map((file) => '- ' + file).join('\n'));
  }
  if (payload.apply) {
    console.log('\nApply selected: ' + payload.apply.selected);
    for (const result of payload.apply.applied) {
      console.log('- applied ' + result.skillName + ' [' + result.action + ']' + (result.dryRun ? ' dry-run' : ''));
    }
    for (const result of payload.apply.skipped) {
      console.log('- skipped ' + result.skillName + ': ' + result.reason);
    }
    for (const result of payload.apply.errors) {
      console.log('- failed ' + result.skillName + ': ' + result.error);
    }
  }
  if (payload.autoCreate) {
    console.log('\nAuto-create selected: ' + payload.autoCreate.selected);
    console.log('Auto-create gates: confidence>=' + payload.autoCreate.gates.minConfidence + ' recurrence>=' + payload.autoCreate.gates.minRecurrence + ' sources>=' + payload.autoCreate.gates.minSourceCount);
    for (const result of payload.autoCreate.applied) {
      console.log('- auto-created ' + result.skillName + ' [' + result.action + ']' + (result.dryRun ? ' dry-run' : ''));
    }
    for (const result of payload.autoCreate.skipped) {
      console.log('- skipped ' + result.skillName + ': ' + result.reason);
    }
    for (const result of payload.autoCreate.errors) {
      console.log('- failed ' + result.skillName + ': ' + result.error);
    }
  }
  if (payload.autoPatch) {
    console.log('\nAuto-patch selected: ' + payload.autoPatch.selected);
    console.log('Auto-patch gates: confidence>=' + payload.autoPatch.gates.minConfidence + ' recurrence>=' + payload.autoPatch.gates.minRecurrence + ' sources>=' + payload.autoPatch.gates.minSourceCount + ' risk=' + payload.autoPatch.gates.risk);
    for (const result of payload.autoPatch.applied) {
      console.log('- auto-patched ' + result.skillName + ' [' + result.action + ']' + (result.dryRun ? ' dry-run' : ''));
    }
    for (const result of payload.autoPatch.skipped) {
      console.log('- skipped ' + result.skillName + ': ' + result.reason);
    }
    for (const result of payload.autoPatch.errors) {
      console.log('- failed ' + result.skillName + ': ' + result.error);
    }
  }
  if (payload.saved !== undefined) console.log('\nSaved candidate memories: ' + payload.saved);
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  run(process.argv.slice(2))
    .then((payload) => {
      printPayload(payload, args);
      if (!payload.ok) process.exitCode = 1;
    })
    .then(async () => {
      try {
        const db = getDb();
        if (db.pool && db.pool.end) await db.pool.end();
      } catch (_) {}
    })
    .catch((err) => {
      console.error(err.stack || err.message || err);
      process.exit(1);
    });
}

module.exports = {
  parseArgs,
  fetchRows,
  dedupeRows,
  fetchRowsByAgent,
  findRecentSessionFiles,
  extractProceduralInstructions,
  fetchRowsFromSessions,
  saveCandidates,
  emitCandidateFiles,
  selectApplyCandidates,
  applyCandidates,
  hasSimilarExistingSkillName,
  autoCreateGate,
  selectAutoCreateCandidates,
  autoCreateCandidates,
  classifyManualReviewCandidate,
  summarizeManualReviewCandidates,
  autoPatchGate,
  selectAutoPatchCandidates,
  autoPatchCandidates,
  run,
  printPayload,
};
