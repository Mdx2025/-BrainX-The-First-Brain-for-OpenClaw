const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_SKILL_ROOTS = [
  '/home/clawd/.openclaw/skills',
  '/home/clawd/.openclaw/plugin-skills',
];

const SKILL_CANDIDATE_TAGS = ['skill-candidate', 'brainx-skill-promoter'];

const AGENT_CORE_SKILL_REGISTRATION_CHECKLIST = Object.freeze([
  'Load agent-core and log the review intent before applying the candidate.',
  'Create or update the SKILL.md in the canonical skill directory; do not treat BrainX memory as registration.',
  'Run openclaw skills check or openclaw skills list --json to verify the skill is visible in runtime.',
  'Run ~/.openclaw/skills/agent-core/scripts/regen-references.sh skills --apply to refresh SKILLS_REGISTRY drift evidence.',
  'Curate the human SKILLS_REGISTRY entry separately when the runtime check shows a real new or changed skill.',
]);

const SOURCE_KIND_WHITELIST = new Set([
  'consolidated',
  'llm_distilled',
  'auto_distilled',
  'auto_harvested',
  'memory_bridge',
  'agent_inference',
  'tool_verified',
  'regex_extraction',
  'raw_session',
  'session_hybrid',
  'user_explicit',
  'knowledge_canonical',
]);

const PROCEDURAL_KEYWORDS = [
  'workflow', 'runbook', 'procedure', 'protocol', 'checklist', 'guardrail',
  'always', 'never', 'prefer', 'avoid', 'before', 'after', 'when', 'must',
  'obligatorio', 'protocolo', 'flujo', 'paso', 'pasos', 'siempre', 'nunca',
  'evitar', 'preferir', 'antes', 'despues', 'después', 'cuando', 'regla',
  'usar', 'validar', 'verificar', 'leer', 'ejecutar', 'extraer', 'agrupar',
  'confirmar', 'emitir', 'crear', 'generar',
];

const EXPLICIT_PROCEDURAL_RE = /\b(siempre|nunca|cuando|antes|despues|después|usar|validar|verificar|ejecutar|leer|extraer|agrupar|confirmar|emitir|crear|generar|preferir|evitar|obligatorio|must|always|never|before|after|when|workflow|runbook|checklist|guardrail)\b/i;
const ACTIONABLE_INSTRUCTION_RE = /^(siempre|nunca|cuando|antes|despues|después|usar|usa|validar|verificar|ejecutar|leer|extraer|agrupar|confirmar|emitir|crear|generar|preferir|evitar|always|never|when|before|after|use|run|check|verify|prefer|avoid|create|generate|do not)\b/i;
const OBLIGATION_RE = /\b(debe|deben|obligatorio|required|must|should)\b/i;
const STYLE_PROCEDURAL_KEYWORDS = [
  'tono', 'estilo', 'voice', 'vibe', 'communication', 'comunicacion', 'comunicación',
  'formato', 'report', 'reports', 'respuesta', 'responder', 'mensaje', 'markdown',
  'tabla', 'tables', 'directo', 'relleno', 'conciso', 'escaneable', 'emoji',
  'prefiere', 'prefers', 'valora', 'molesta',
];
const STYLE_PROCEDURAL_RE = /\b(tono|estilo|voice|vibe|communication|comunicaci[oó]n|formato|reports?|respuesta|responder|mensaje|markdown|tablas?|tables|directo|relleno|conciso|escaneable|emoji|prefiere|prefers|valora|molesta)\b/i;
const STYLE_INSTRUCTION_RE = /\b(prefiere|prefers|valora|molesta|evitar|evita|avoid|sin\s+relleno|directo|conciso|escaneable|markdown|tablas?|tables|tono|estilo|voice|vibe|formato|reports?|respuesta|responder)\b/i;
const COMMUNICATION_STYLE_CONTEXT_RE = /\b(tono|voice|vibe|communication|comunicaci[oó]n|respuesta|responder|mensaje|reporte|reports?|discord|telegram|whatsapp|markdown|tablas?\s+markdown|markdown\s+tables?|sin\s+relleno|directo|conciso|escaneable|una\s+idea\s+por\s+l[ií]nea|brand\s+voice|estilo\s+de\s+(?:respuesta|comunicaci[oó]n))\b/i;
const VISUAL_STYLE_CONTEXT_RE = /\b(css|ui|ux|layout|render|renderizando|frontend|componente|component|bot[oó]n|button|header|footer|dashboard|divi|lenis|scroll|smooth|color|branded|rojo|clase|selector|px|pixel|responsive|tabla|table|candidato|deleted|deactivated|fantasma|page|p[aá]gina|vista|view|card|modal|checkbox)\b/i;

const NEGATIVE_ONE_OFF_RE = [
  /\b(report|reporte|article|art[íi]culo|draft|published|publicado)\b/i,
  /\b(commit|sha|deploy(?:ment)?|backfill|featured image)\b/i,
  /\b(restart|hotfix|issue\s*#?\d+|\b[45]\d\d\b|stack trace|traceback)\b/i,
  /\b(arreglado|fixed|done|listo|qued[oó] listo|qued[oó] arreglado|desaparece|persist[eí]a?)\b/i,
  /\b(lo acabo de|te reviso|quieres que|puedo hacer|si hace falta)\b/i,
  /\bactualmente hay \d+\b/i,
  /\bse agreg[oó] un archivo\b/i,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b[0-9a-f]{12,40}\b/i,
];

const CHAT_STATUS_NOISE_RE = [
  /^\s*\[\[reply_to_current\]\]/i,
  /^\s*(listo|arreglado|fixed|done|ya casi|veredicto|resumen|exacto|b[aá]sicamente|honestamente)\b/i,
  /^\s*[\u2705\u26a0\u274c]/u,
  /^\s*#{1,6}\s+/,
  /\}\);\s*[-—]/,
];

const PROMOTION_META_NOISE_RE = [
  /\b(skill candidate|candidato|candidate)\b.*\b(confidence|recurrence|fuentes|sources|acci[oó]n|action)\b/i,
  /^\s*(acci[oó]n|confidence|recurrence|fuentes|sources|señal|problema|mi veredicto|veredicto|propuesta)\s*:/i,
  /\b(palabras gatillo|señal que intenta capturar|c[oó]mo se ensuci[oó]|por qu[eé] trae esto el loop|no vale la pena por que trae esto)\b/i,
  /\b(este candidato|ese candidato|el candidato|la propuesta|el draft actual|el promotor)\b.*\b(skill|loop|brainx|promotor|candidato|candidate)\b/i,
  /\b(portmanteau|responseRules)\b/i,
];

const SECRET_OR_PRIVATE_RE = [
  /\b(api[_-]?key|secret|token|password|passwd|pwd|cookie|session[_-]?id|client[_-]?secret)\b\s*[:=]/i,
  /\b(sk|ghp|github_pat|xox[baprs]|figu|railway)_[a-z0-9_\-]{12,}\b/i,
  /\b[A-Za-z0-9+/]{32,}={0,2}\b/,
  /\.env\b|credentials(?:-[\w-]+)?\.json\b/i,
];

const TOOL_FAILURE_NOISE_RE = [
  /^tool-failure:/i,
  /\b(exec|browser|apply_patch|validation) failed\b/i,
  /\bvalidation failed for tool\b/i,
  /\bcommand aborted by signal\b/i,
  /\bcdp diagnostic\b/i,
  /\bsubprocess usage\b/i,
];

const PROJECT_SPECIFIC_INSTRUCTION_RE = [
  /\b(verificar|validar|check|verify)\b.*\b(link|enlace)\b.*\b(existe|exists)\b/i,
  /\b(link|enlace)\b\s+(?:a|to)\s+[A-Z][A-Za-z0-9_-]*\b.*\b(existe|exists)\b/i,
  /\b(mdxspace|mdx\.so|gulfmdx|exothatch|closer academy|closeracademy)\b/i,
  /\b(faltaba|carec[ií]a|se\s+(?:agreg[oó]|cre[oó]|corrigi[oó]|corrige|arregl[oó]|implement[oó])|fixed|bugfix)\b.*\b([a-z]+[A-Z][A-Za-z0-9]*|[A-Za-z_$][\w$]*\s*\(|DOM|frontend|backend|componente|component|endpoint|handler|controller)\b/i,
  /\b([a-z]+[A-Z][A-Za-z0-9]*|[A-Za-z_$][\w$]*\s*\(|DOM|frontend|backend|componente|component|endpoint|handler|controller)\b.*\b(faltaba|carec[ií]a|se\s+(?:agreg[oó]|cre[oó]|corrigi[oó]|corrige|arregl[oó]|implement[oó])|fixed|bugfix)\b/i,
];

const DOMAIN_SKILL_RULES = [
  { skillName: 'communication-style', terms: ['tono', 'estilo', 'voice', 'vibe', 'communication', 'comunicacion', 'comunicación', 'formato escaneable', 'reporte escaneable', 'markdown tables', 'tablas markdown', 'sin relleno', 'respuesta directa'] },
  { skillName: 'brainx', terms: ['brainx', 'memory', 'memoria', 'embedding', 'vector', 'pgvector', 'recall'] },
  { skillName: 'openclaw-runtime', terms: ['openclaw', 'gateway', 'plugin', 'subagent', 'acp', 'session rotation', 'runtime hook'] },
  { skillName: 'playwright-browser-automation', terms: ['playwright', 'browser', 'screenshot', 'responsive', 'visual verification'] },
  { skillName: 'gws', terms: ['gws', 'gmail', 'google workspace', 'drive', 'docs', 'sheets', 'calendar'] },
  { skillName: 'railway-ops', terms: ['railway', 'deployment', 'service', 'environment variables'] },
  { skillName: 'github', terms: ['github', 'gh cli', 'pull request', 'issue', 'branch'] },
  { skillName: 'notion', terms: ['notion', 'database', 'page block'] },
  { skillName: 'recruiter', terms: ['candidate', 'portfolio', 'recruiter', 'applicant', 'candidato'] },
  { skillName: 'automation-workflows', terms: ['cron', 'scheduler', 'automation', 'heartbeat', 'monitor'] },
];

const PROJECT_DOC_RULES = [
  {
    project: 'emailbot',
    canonicalPath: 'knowledge/emailbot/email-protocol.md',
    terms: ['emailbot', 'gmail', 'followup', 'follow-up', 'correo', 'draft', 'lead', 'sequence', 'notion'],
  },
];

const SUPPRESSED_SKILL_CANDIDATE_NAMES = new Set([
  'playwright-browser-automation',
]);

function normalizeText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function toSlug(value, fallback = 'procedural-skill') {
  const raw = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return (raw || fallback).slice(0, 64).replace(/-+$/g, '') || fallback;
}

function addSkillNameAliases(names, value) {
  const raw = String(value || '').trim();
  if (!raw) return;
  names.add(raw);
  names.add(raw.toLowerCase());
  names.add(toSlug(raw));
}

function skillPathBasename(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const clean = raw.replace(/\/+$/, '');
  if (path.basename(clean).toLowerCase() === 'skill.md') {
    return path.basename(path.dirname(clean));
  }
  return path.basename(clean);
}

function arrayFromTags(tags) {
  if (Array.isArray(tags)) return tags.map((tag) => String(tag).trim()).filter(Boolean);
  if (typeof tags === 'string') {
    return tags
      .replace(/^\{/, '')
      .replace(/\}$/, '')
      .split(',')
      .map((tag) => tag.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
  }
  return [];
}

function hashId(prefix, value) {
  return prefix + '_' + crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function containsSecretLike(text) {
  return SECRET_OR_PRIVATE_RE.some((pattern) => pattern.test(String(text || '')));
}

function isOneOffOperationalReport(text) {
  return NEGATIVE_ONE_OFF_RE.some((pattern) => pattern.test(String(text || '')));
}

function isChatStatusNoise(text) {
  return CHAT_STATUS_NOISE_RE.some((pattern) => pattern.test(String(text || '')));
}

function isPromotionMetaNoise(text) {
  return PROMOTION_META_NOISE_RE.some((pattern) => pattern.test(String(text || '')));
}

function isProjectSpecificInstruction(text) {
  return PROJECT_SPECIFIC_INSTRUCTION_RE.some((pattern) => pattern.test(String(text || '')));
}

function isVisualStyleInstruction(text) {
  const value = String(text || '');
  return STYLE_PROCEDURAL_RE.test(value) && VISUAL_STYLE_CONTEXT_RE.test(value) && !COMMUNICATION_STYLE_CONTEXT_RE.test(value);
}

function isCommunicationStyleInstruction(text) {
  const value = String(text || '');
  if (!STYLE_PROCEDURAL_RE.test(value) && !STYLE_INSTRUCTION_RE.test(value)) return false;
  if (isVisualStyleInstruction(value)) return false;
  return COMMUNICATION_STYLE_CONTEXT_RE.test(value);
}

function isUnsafeSkillCandidate(row) {
  const sensitivity = String(row && row.sensitivity || 'normal').toLowerCase();
  const tags = arrayFromTags(row && row.tags).map((tag) => tag.toLowerCase());
  const text = normalizeText([
    row && row.pattern_key,
    row && row.content,
    row && row.representative_content,
    row && row.description,
    row && row.source_path
  ].filter(Boolean).join('\n'));
  if (sensitivity === 'restricted') return true;
  if (tags.some((tag) => tag.includes('tool-failure'))) return true;
  if (TOOL_FAILURE_NOISE_RE.some((pattern) => pattern.test(text))) return true;
  if (isChatStatusNoise(text)) return true;
  if (isPromotionMetaNoise(text)) return true;
  if (containsSecretLike(text)) return true;
  return false;
}

function countKeywordHits(text, keywords = PROCEDURAL_KEYWORDS) {
  const lower = String(text || '').toLowerCase();
  let hits = 0;
  for (const keyword of keywords) {
    if (lower.includes(keyword)) hits += 1;
  }
  return hits;
}

function scoreProceduralSignal(row) {
  const content = normalizeText(row && (row.content || row.representative_content || row.description) || '');
  const tags = arrayFromTags(row && row.tags).map((tag) => tag.toLowerCase());
  const type = String(row && row.type || '').toLowerCase();
  const category = String(row && (row.category || row.last_category) || '').toLowerCase();
  const sourceKind = String(row && row.source_kind || '').toLowerCase();
  const recurrence = Number(row && (row.recurrence_count || row.recurrence) || 1);
  const accessCount = Number(row && row.access_count || 0);

  const reasons = [];
  let score = 0;

  if (['learning', 'gotcha'].includes(type)) {
    score += 0.2;
    reasons.push('type:' + type);
  } else if (type === 'decision') {
    score += 0.12;
    reasons.push('type:decision');
  } else if (type === 'fact') {
    score += 0.04;
  }

  if (['best_practice', 'infrastructure', 'error', 'correction', 'routine', 'context'].includes(category)) {
    score += 0.16;
    reasons.push('category:' + category);
  }

  if (SOURCE_KIND_WHITELIST.has(sourceKind)) {
    score += 0.08;
    reasons.push('source:' + sourceKind);
  }

  if (sourceKind === 'raw_session' && EXPLICIT_PROCEDURAL_RE.test(content)) {
    score += 0.08;
    reasons.push('raw_session:procedural');
  }

  if (recurrence >= 3) {
    score += Math.min(0.24, 0.08 + recurrence * 0.025);
    reasons.push('recurrence:' + recurrence);
  }

  if (accessCount >= 3) {
    score += Math.min(0.1, accessCount * 0.015);
    reasons.push('access:' + accessCount);
  }

  const keywordHits = countKeywordHits(content);
  if (keywordHits > 0) {
    score += Math.min(0.22, keywordHits * 0.04);
    reasons.push('procedural_terms:' + keywordHits);
  }

  const styleHits = countKeywordHits(content, STYLE_PROCEDURAL_KEYWORDS);
  if (styleHits >= 2 && (isCommunicationStyleInstruction(content) || tags.some((tag) => ['voice', 'communication', 'comms', 'brand-voice'].includes(tag)))) {
    score += Math.min(0.2, 0.08 + styleHits * 0.025);
    reasons.push('style_procedure_terms:' + styleHits);
  }

  if (tags.some((tag) => ['skill', 'skill-candidate', 'workflow', 'runbook', 'best-practice'].includes(tag))) {
    score += 0.16;
    reasons.push('tag:procedural');
  }

  if (isOneOffOperationalReport(content)) {
    score -= 0.22;
    reasons.push('penalty:one_off_report');
  }

  if (content.length < 80) {
    score -= sourceKind === 'raw_session' ? 0.03 : 0.08;
    reasons.push('penalty:short');
  }

  return {
    score: Math.max(0, Math.min(1, Number(score.toFixed(3)))),
    reasons,
  };
}

function inferSkillName(row) {
  const content = normalizeText([
    row && row.content,
    row && row.representative_content,
    row && row.description,
    row && row.pattern_key,
    row && row.context,
    arrayFromTags(row && row.tags).join(' '),
  ].filter(Boolean).join('\n')).toLowerCase();

  for (const rule of DOMAIN_SKILL_RULES) {
    if (rule.skillName === 'communication-style' && !isCommunicationStyleInstruction(content)) continue;
    if (rule.terms.some((term) => content.includes(term))) {
      return rule.skillName;
    }
  }

  const patternKey = String(row && row.pattern_key || '').trim();
  if (patternKey) {
    return toSlug(patternKey.replace(/^(workflow|tool|agent|memory|general)[:-]/i, ''));
  }

  const stopWords = new Set(['para', 'cuando', 'antes', 'despues', 'after', 'before', 'with', 'from', 'that', 'this', 'usar']);
  const words = content
    .replace(/[^a-z0-9áéíóúñ\s-]/gi, ' ')
    .split(/\s+/)
    .map((word) => toSlug(word, ''))
    .filter((word) => word.length >= 4)
    .filter((word) => !stopWords.has(word));

  return toSlug(words.slice(0, 3).join('-') || 'procedural-workflow');
}

function inferProjectDocTarget(row) {
  const content = normalizeText([
    row && row.content,
    row && row.representative_content,
    row && row.description,
    row && row.pattern_key,
    row && row.context,
    row && row.source_path,
    arrayFromTags(row && row.tags).join(' '),
  ].filter(Boolean).join('\n')).toLowerCase();

  for (const rule of PROJECT_DOC_RULES) {
    const hasProjectSignal = content.includes(rule.project) || content.includes('project:' + rule.project);
    const termHits = rule.terms.filter((term) => content.includes(term)).length;
    if (hasProjectSignal && termHits >= 1) {
      return {
        kind: 'project-doc',
        project: rule.project,
        canonicalPath: rule.canonicalPath,
        canonicalKey: 'project-doc:' + rule.project + ':' + rule.canonicalPath,
      };
    }
  }

  return null;
}

function buildSkillCanonicalTarget(skillName) {
  const slug = toSlug(skillName || 'procedural-skill');
  return {
    kind: 'skill',
    project: 'global',
    canonicalPath: 'skills/' + slug + '/SKILL.md',
    canonicalKey: 'skill:global:skills/' + slug + '/SKILL.md',
  };
}

function isSuppressedSkillCandidateName(skillName) {
  return SUPPRESSED_SKILL_CANDIDATE_NAMES.has(toSlug(skillName || ''));
}

function loadRuntimeSkillNames(options = {}) {
  const names = new Set();
  const openclawBin = options.openclawBin || process.env.OPENCLAW_BIN || 'openclaw';
  const execImpl = options.execFileSync || execFileSync;
  const timeout = Number(options.timeoutMs || process.env.BRAINX_SKILL_PROMOTER_RUNTIME_TIMEOUT_MS || 8000);

  try {
    const output = execImpl(openclawBin, ['skills', 'list', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout,
    });
    const data = JSON.parse(String(output || '{}'));
    const skills = Array.isArray(data.skills) ? data.skills : [];
    for (const skill of skills) {
      if (!skill || skill.eligible === false) continue;
      addSkillNameAliases(names, skill.name);
      addSkillNameAliases(names, skill.id);
      addSkillNameAliases(names, skill.slug);
      addSkillNameAliases(names, skill.key);
      addSkillNameAliases(names, skillPathBasename(skill.location || skill.path || skill.dir));
    }
  } catch (_) {
    return names;
  }

  return names;
}

function loadFilesystemSkillNames(roots = DEFAULT_SKILL_ROOTS) {
  const names = new Set();
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillDir = path.join(root, entry.name);
        const skillMd = path.join(skillDir, 'SKILL.md');
        addSkillNameAliases(names, entry.name);
        if (!fs.existsSync(skillMd)) continue;
        const head = fs.readFileSync(skillMd, 'utf8').slice(0, 4000);
        const match = head.match(/^name:\s*["']?([^"'\n]+)["']?/m);
        if (match && match[1]) addSkillNameAliases(names, match[1]);
      }
    } catch (_) {}
  }
  return names;
}

function loadExistingSkillNames(roots = DEFAULT_SKILL_ROOTS, options = {}) {
  if (!Array.isArray(roots) && roots && typeof roots === 'object') {
    options = roots;
    roots = DEFAULT_SKILL_ROOTS;
  }
  if (options.runtimeSkillNames instanceof Set && options.runtimeSkillNames.size) {
    return options.runtimeSkillNames;
  }
  const names = new Set();
  if (options.preferRuntime !== false) {
    const runtimeNames = loadRuntimeSkillNames(options);
    for (const name of runtimeNames) names.add(name);
  }
  const filesystemNames = loadFilesystemSkillNames(roots);
  for (const name of filesystemNames) names.add(name);
  return names;
}

function hasKnownSkillName(existingSkillNames, skillName) {
  if (!existingSkillNames || !skillName) return false;
  return (
    existingSkillNames.has(skillName)
    || existingSkillNames.has(String(skillName).toLowerCase())
    || existingSkillNames.has(toSlug(skillName))
  );
}

function extractInstructionBullets(text, max = 6) {
  const normalized = normalizeText(text);
  const sourceLines = normalized.split(/\n|(?<=[.!?])\s+/).map((line) => line.trim()).filter(Boolean);
  const bullets = [];
  for (const line of sourceLines) {
    if (bullets.length >= max) break;
    const clean = line
      .replace(/^[-*]\s*/, '')
      .replace(/^Rule:\s*/i, '')
      .replace(/^Reason:\s*/i, '')
      .trim();
    if (clean.length < 24) continue;
    const plain = clean.replace(/^[#*>_\-\s*]+/g, '').trim();
    if (/^\|.*\|$/.test(plain)) continue;
    const isImperative = ACTIONABLE_INSTRUCTION_RE.test(plain) || OBLIGATION_RE.test(plain);
    const isStyleProcedure = isCommunicationStyleInstruction(plain);
    if (isVisualStyleInstruction(plain) || isPromotionMetaNoise(plain)) continue;
    if (isOneOffOperationalReport(clean) && !isStyleProcedure) continue;
    if (isChatStatusNoise(clean) || containsSecretLike(clean)) continue;
    if (isProjectSpecificInstruction(clean) && !isStyleProcedure) continue;
    if (!isImperative && !isStyleProcedure) continue;
    bullets.push('- ' + clean.slice(0, 220) + (clean.length > 220 ? '...' : ''));
  }
  return bullets;
}

function buildDraftSkillMd(candidate) {
  const description = candidate.description
    || 'Use when the task matches the recurring BrainX pattern "' + candidate.skillName + '".';
  const bullets = candidate.instructions && candidate.instructions.length ? candidate.instructions : extractInstructionBullets(candidate.evidenceText || '');

  return [
    '---',
    'name: ' + candidate.skillName,
    'description: ' + description.replace(/\s+/g, ' ').slice(0, 240),
    '---',
    '# ' + (candidate.title || candidate.skillName),
    '',
    'Use this skill only when the task clearly matches the recurring workflow captured by BrainX.',
    '',
    '## Workflow',
    '',
    ...bullets,
    '',
    '## Guardrails',
    '',
    '- Treat this draft as review-gated until a human or skill vetter approves it.',
    '- Do not include secrets, credentials, private session transcripts, or host-specific state.',
    '- Keep project-specific details in the project profile or repo docs instead of this reusable skill.',
    '',
  ].join('\n');
}

function createCandidateFromRow(row, options = {}) {
  if (isUnsafeSkillCandidate(row)) return null;
  if (inferProjectDocTarget(row)) return null;

  const minScore = Number(options.minScore !== undefined ? options.minScore : 0.58);
  const signal = scoreProceduralSignal(row);
  if (signal.score < minScore) return null;

  const existingSkillNames = options.existingSkillNames || new Set();
  const skillName = inferSkillName(row);
  if (isSuppressedSkillCandidateName(skillName)) return null;
  const canonicalTarget = buildSkillCanonicalTarget(skillName);
  const existing = hasKnownSkillName(existingSkillNames, skillName);
  const content = normalizeText(row && (row.content || row.representative_content || row.description) || '');
  const hasProceduralTrigger =
    signal.reasons.some((reason) => reason.startsWith('procedural_terms:') || reason === 'tag:procedural')
    || EXPLICIT_PROCEDURAL_RE.test(content);
  const hasStyleProcedureTrigger =
    signal.reasons.some((reason) => reason.startsWith('style_procedure_terms:'))
    || (STYLE_PROCEDURAL_RE.test(content) && STYLE_INSTRUCTION_RE.test(content));
  if (!hasProceduralTrigger && !hasStyleProcedureTrigger) return null;

  const instructions = extractInstructionBullets(content);
  if (!instructions.length) return null;

  const recurrence = Number(row && (row.recurrence_count || row.recurrence) || 1);
  const sourceId = row && (row.id || row.memory_id || row.representative_memory_id || row.pattern_key) || hashId('src', content);
  const action = existing ? 'extend_existing_skill' : 'create_new_skill';
  const confidence = Number(Math.min(0.98, signal.score + (existing ? 0.04 : 0)).toFixed(3));
  const sourceSessions = Array.from(new Set([]
    .concat(row && row.source_session ? row.source_session : [])
    .concat(row && row.sourceSessions ? row.sourceSessions : [])
    .filter(Boolean)));
  const agents = Array.from(new Set([]
    .concat(row && row.agent ? row.agent : [])
    .concat(row && row.agents ? row.agents : [])
    .filter(Boolean)));
  const brainxConfirmations = Array.from(new Set([]
    .concat(row && row.brainx_confirmation ? row.brainx_confirmation : [])
    .concat(row && row.brainxConfirmations ? row.brainxConfirmations : [])
    .filter(Boolean)));

  const candidate = {
    id: hashId('skillcand', skillName + '|' + sourceId + '|' + content.slice(0, 240)),
    skillName,
    targetKind: canonicalTarget.kind,
    targetProject: canonicalTarget.project,
    canonicalPath: canonicalTarget.canonicalPath,
    canonicalKey: canonicalTarget.canonicalKey,
    title: skillName.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' '),
    action,
    confidence,
    score: signal.score,
    reasons: signal.reasons,
    recurrence,
    source: row && row.source || (row && row.pattern_key ? 'pattern' : 'memory'),
    sourceKind: row && row.source_kind || null,
    sourceIds: [sourceId].filter(Boolean),
    patternKeys: [row && row.pattern_key].filter(Boolean),
    memoryIds: [row && (row.id || row.memory_id || row.representative_memory_id)].filter(Boolean),
    sourceSessions,
    agents,
    brainxConfirmations,
    brainxConfirmed: brainxConfirmations.length > 0,
    description: 'Reusable workflow candidate inferred from BrainX recurrence ' + recurrence + 'x.',
    evidenceText: content,
    instructions,
    registrationChecklist: AGENT_CORE_SKILL_REGISTRATION_CHECKLIST,
  };
  candidate.draftSkillMd = buildDraftSkillMd(candidate);
  return candidate;
}

function mergeCandidateGroup(candidates) {
  if (!candidates.length) return null;
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence || b.recurrence - a.recurrence);
  const base = { ...sorted[0] };
  const sourceIds = new Set();
  const patternKeys = new Set();
  const memoryIds = new Set();
  const reasons = new Set();
  const sourceKinds = new Set();
  const sourceSessions = new Set();
  const agents = new Set();
  const brainxConfirmations = new Set();
  const instructions = [];
  let recurrence = 0;
  let confidence = 0;

  for (const candidate of sorted) {
    candidate.sourceIds.forEach((id) => sourceIds.add(id));
    candidate.patternKeys.forEach((id) => patternKeys.add(id));
    candidate.memoryIds.forEach((id) => memoryIds.add(id));
    candidate.reasons.forEach((reason) => reasons.add(reason));
    if (candidate.sourceKind) sourceKinds.add(candidate.sourceKind);
    (candidate.sourceSessions || []).forEach((id) => sourceSessions.add(id));
    (candidate.agents || []).forEach((id) => agents.add(id));
    (candidate.brainxConfirmations || []).forEach((id) => brainxConfirmations.add(id));
    for (const line of candidate.instructions || []) {
      if (!instructions.includes(line) && instructions.length < 8) instructions.push(line);
    }
    recurrence += Number(candidate.recurrence || 0);
    confidence = Math.max(confidence, Number(candidate.confidence || 0));
  }

  base.sourceIds = Array.from(sourceIds);
  base.patternKeys = Array.from(patternKeys);
  base.memoryIds = Array.from(memoryIds);
  base.reasons = Array.from(reasons);
  base.sourceKinds = Array.from(sourceKinds);
  base.sourceSessions = Array.from(sourceSessions);
  base.agents = Array.from(agents);
  base.brainxConfirmations = Array.from(brainxConfirmations);
  base.brainxConfirmed = base.brainxConfirmations.length > 0;
  base.instructions = instructions;
  base.recurrence = recurrence || base.recurrence;
  base.confidence = Number(Math.min(0.99, confidence + Math.min(0.08, sorted.length * 0.01)).toFixed(3));
  base.sourceCount = sorted.length;
  const hasRawSessionEvidence = base.sourceKinds.includes('raw_session') || sorted.some((candidate) => candidate.source === 'session');
  const hasBrainxEvidence = sorted.some((candidate) => candidate.source !== 'session' && candidate.sourceKind !== 'raw_session');
  if (hasRawSessionEvidence && !hasBrainxEvidence && !base.brainxConfirmed) return null;
  if (hasRawSessionEvidence && base.sourceSessions.length < 2 && base.brainxConfirmations.length < 2 && !hasBrainxEvidence) return null;
  if (base.sourceCount < 2 && base.recurrence < 5) return null;
  if (base.action === 'create_new_skill' && base.sourceCount < 3) return null;
  if (!base.instructions.length) return null;
  base.description = 'Review-gated ' + (base.action === 'extend_existing_skill' ? 'extension' : 'new skill') + ' candidate from ' + base.sourceCount + ' recurring source(s).';
  if (hasRawSessionEvidence) {
    base.description += ' Includes raw session evidence confirmed against BrainX memory/pattern signal.';
  }
  base.registrationChecklist = AGENT_CORE_SKILL_REGISTRATION_CHECKLIST;
  base.draftSkillMd = buildDraftSkillMd(base);
  return base;
}

function groupCandidates(candidates) {
  const groups = new Map();
  for (const candidate of candidates.filter(Boolean)) {
    const key = candidate.canonicalKey || ('skill:global:skills/' + toSlug(candidate.skillName || 'procedural-skill') + '/SKILL.md');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  return Array.from(groups.values())
    .map(mergeCandidateGroup)
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence || b.recurrence - a.recurrence || a.skillName.localeCompare(b.skillName));
}

function buildCandidateMemoryContent(candidate) {
  return [
    '[SKILL CANDIDATE] ' + candidate.skillName,
    'Action: ' + candidate.action,
    'Confidence: ' + candidate.confidence,
    'Recurrence: ' + candidate.recurrence + 'x',
    'Sources: ' + (candidate.sourceIds.join(', ') || 'unknown'),
    'Reason: ' + candidate.description,
    '',
    'Registration checklist:',
    ...(candidate.registrationChecklist || AGENT_CORE_SKILL_REGISTRATION_CHECKLIST).map((item) => '- ' + item),
    '',
    'Draft SKILL.md:',
    '~~~markdown',
    candidate.draftSkillMd.trim(),
    '~~~',
  ].join('\n');
}

function formatCandidateSummary(candidate) {
  return [
    '- ' + candidate.skillName + ' [' + candidate.action + '] confidence=' + candidate.confidence + ' recurrence=' + candidate.recurrence + 'x sources=' + (candidate.sourceCount || 1),
    '  reasons: ' + (candidate.reasons.slice(0, 5).join(', ') || 'procedural recurrence'),
    '  sources: ' + (candidate.sourceIds.slice(0, 5).join(', ') || 'unknown'),
  ].join('\n');
}

module.exports = {
  DEFAULT_SKILL_ROOTS,
  SKILL_CANDIDATE_TAGS,
  AGENT_CORE_SKILL_REGISTRATION_CHECKLIST,
  SOURCE_KIND_WHITELIST,
  PROCEDURAL_KEYWORDS,
  normalizeText,
  toSlug,
  arrayFromTags,
  hashId,
  containsSecretLike,
  isOneOffOperationalReport,
  isChatStatusNoise,
  isPromotionMetaNoise,
  isProjectSpecificInstruction,
  isVisualStyleInstruction,
  isCommunicationStyleInstruction,
  isUnsafeSkillCandidate,
  scoreProceduralSignal,
  inferSkillName,
  inferProjectDocTarget,
  buildSkillCanonicalTarget,
  isSuppressedSkillCandidateName,
  loadRuntimeSkillNames,
  loadFilesystemSkillNames,
  loadExistingSkillNames,
  hasKnownSkillName,
  extractInstructionBullets,
  buildDraftSkillMd,
  createCandidateFromRow,
  groupCandidates,
  buildCandidateMemoryContent,
  formatCandidateSummary,
};
