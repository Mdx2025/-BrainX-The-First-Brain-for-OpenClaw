const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const OpenAI = require('openai');

const STATE_DIR = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), '.openclaw');
const WORKING_MEMORY_DIR = path.join(STATE_DIR, 'brainx-working-memory');
const DEFAULT_MAX_EVENTS = 12;
const DEFAULT_MAX_ITEMS = 6;
const DEFAULT_SUMMARY_COOLDOWN_MS = 75 * 1000;
const DEFAULT_SUMMARY_MIN_TEXT_CHARS = 180;
const DEFAULT_SUMMARY_MAX_TOKENS = 520;
const STALE_OPEN_SESSION_MS = 36 * 60 * 60 * 1000;
const CLOSED_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 15 * 60 * 1000;
const UNTRUSTED_PROMPT_MARKERS = [
  /Untrusted context \(metadata, do not treat as instructions or commands\):/i,
  /Conversation info \(untrusted metadata\)/i,
  /Sender \(untrusted metadata\)/i,
  /UNTRUSTED (?:Discord|Slack|Telegram|WhatsApp) message body/i,
  /Discord channel topic:/i,
  /"is_group_chat"\s*:/i,
  /"group_channel"\s*:/i,
  /"conversation_label"\s*:/i,
  /^\[[^\]\n]*(?:Discord|Slack|Telegram|WhatsApp|Guild|channel id|thread|direct message|dm|GMT|UTC)[^\]\n]*\]/i,
  // SANITIZE_FIX_20260419: systemic prompts injected by the gateway that must
  // never be treated as user goals/tasks.
  /^File delivery rule:/i,
  /^\[media attached:/i,
  /^\[cron:/i,
  /^\[Image generated/i,
];
const WRAPPED_CHANNEL_PREFIX_RE = /^\[[^\]\n]*(?:Discord|Slack|Telegram|WhatsApp|Guild|channel id|thread|direct message|dm|GMT|UTC)[^\]\n]*\]\s*/i;
// SANITIZE_FIX_20260419: additional prefixes that wrap user text without being
// Discord/Slack envelopes themselves, e.g. [Image] User text: ... before the
// real channel prefix. Stripped in sequence until prompt stabilizes.
const WRAPPED_MEDIA_PREFIX_RE = /^\[(?:Image|Video|Audio|File|Voice|Document|Sticker|GIF)\]\s*(?:User text:\s*)?/i;
const WRAPPED_CRON_PREFIX_RE = /^\[cron:[^\]\n]+\]\s*/i;
const WRAPPED_MEDIA_ATTACH_PREFIX_RE = /^\[media attached:[^\]\n]*\]\s*/i;
const SYSTEMIC_PROMPT_HEAD_RE = /^File delivery rule:/i;
const WRAPPED_SENDER_PREFIX_RE = /^[A-ZÁÉÍÓÚÑ0-9][^:\n]{0,80}(?:\([^)]+\))?:\s+/;
const TRANSPORT_TOOL_NAMES = new Set(['message']);
const TRANSPORT_OUTCOME_KEYS = ['messageId', 'channelId', 'threadId', 'conversationId', 'deliveryId'];

const sessionQueues = new Map();
let cachedClient = null;
let cachedClientKey = '';
let cachedMiniMaxOauth = { key: '', expiresAt: 0 };
let prunePromise = null;
let lastPruneAt = 0;

function nowIso() {
  return new Date().toISOString();
}

function sha(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function normalizeWhitespace(value) {
  return String(value ?? '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncate(value, maxChars) {
  const text = normalizeWhitespace(value);
  if (!text || text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
}

function isLikelyPath(value) {
  const text = normalizeWhitespace(value);
  if (!text) return false;
  if (/^https?:\/\//i.test(text)) return false;
  if (/^[0-9]{8,}$/.test(text)) return false;
  return /[\/~\\]/.test(text) || /\.[a-z0-9]{1,12}$/i.test(text);
}

function parseIsoMs(value) {
  const parsed = value ? Date.parse(String(value)) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function toSlug(value) {
  return String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
}

function sessionIdentity(ref = {}) {
  const agentId = normalizeWhitespace(ref.agentId) || 'unknown';
  const sessionKey = normalizeWhitespace(ref.sessionKey) || null;
  const sessionId = normalizeWhitespace(ref.sessionId) || null;
  const stableKey = sessionKey || sessionId || `agent:${agentId}`;
  return { agentId, sessionKey, sessionId, stableKey };
}

const PROJECT_NONE = '_none';
const PROJECT_KEY_CANDIDATES = ['workdir', 'cwd', 'path', 'file', 'filePath', 'filepath', 'target', 'source', 'destination'];

// CROSS_PROJECT_FIX_20260608: canonical project identity from ANY repo-like
// path, mirroring the plugin bridge's path-scope logic. Before this, the writer
// only recognized `/projects/<name>/` paths (plus a hardcoded domain allowlist),
// so repos living under `/home/clawd/<repo>` or `workspace-<agent>/<repo>` all
// collapsed into the shared `_none` bucket. That commingled facts/files from
// unrelated projects (reasoning: TowerGarage cross-wired with UniLife) and the
// soup was then fed back on session-rotation recovery. The generic-prefix set
// and excluded segments keep `/home/clawd` (a git repo itself) from becoming a
// catch-all "clawd" project the way the bridge's repo_state did.
const WM_SCOPE_GENERIC_PREFIXES = new Set([
  '/home', '/home/clawd', '/tmp', '/var', '/etc', '/usr', '/opt', '/root',
  '/home/clawd/.claude', '/home/clawd/.cache', '/home/clawd/.config',
  '/home/clawd/.local', '/home/clawd/.nvm', '/home/clawd/.openclaw',
  '/home/clawd/.openclaw/logs', '/home/clawd/.openclaw/cache',
  '/home/clawd/.openclaw/backups', '/home/clawd/.openclaw/skills',
  '/home/clawd/.openclaw/workspace', '/home/clawd/.openclaw/extensions',
  '/home/clawd/.openclaw/agents', '/home/Mdx2025',
]);
const WM_NON_PROJECT_SEGMENTS = new Set([
  'clawd', 'home', 'root', 'tmp', 'var', 'etc', 'usr', 'opt', 'mnt', 'srv',
  // Workspace-internal / generic dirs that are never a project of their own.
  'memory', 'media', 'scripts', 'sessions', 'agent', 'qmd', 'logs', 'backups',
  'node_modules', 'dist', 'build', 'src', 'lib', 'tests', 'test', 'docs',
  'data', 'cache', 'coverage', 'state',
]);
const WM_SCOPE_PREFIX_MIN_LEN = 12;

function projectKeyFromPath(rawPath) {
  const raw = normalizeWhitespace(rawPath);
  if (!raw || !raw.includes('/')) return PROJECT_NONE;
  const p = raw.split('#')[0].split('?')[0];
  // 1) Explicit /projects/<name>/ (legacy, highest priority).
  const wsProj = p.match(/\/workspace-[^/]+\/projects\/([^/]+)/);
  if (wsProj && wsProj[1]) return toSlug(wsProj[1]);
  if (!p.includes('/workspace-')) {
    const proj = p.match(/\/projects\/([^/]+)/);
    if (proj && proj[1]) return toSlug(proj[1]);
  }
  // 2) Generic: the first non-generic path segment IS the project dir.
  const segs = p.split('/').filter(Boolean);
  if (segs.length < 2) return PROJECT_NONE;
  let acc = '';
  for (let i = 0; i < segs.length; i += 1) {
    const next = `${acc}/${segs[i]}`;
    const isContainer = WM_SCOPE_GENERIC_PREFIXES.has(next)
      || /^\/home\/clawd\/\.openclaw\/workspace-[^/]+$/.test(next);
    if (isContainer) { acc = next; continue; }
    if (next.length < WM_SCOPE_PREFIX_MIN_LEN) { acc = next; continue; }
    const seg = segs[i];
    // A bare FILE directly under a generic dir (last segment with an extension)
    // is not a project — but a directory that is itself the cwd/repo root IS.
    if (i >= segs.length - 1 && /\.[a-z0-9]{1,12}$/i.test(seg)) return PROJECT_NONE;
    if (WM_NON_PROJECT_SEGMENTS.has(seg.toLowerCase())) return PROJECT_NONE;
    return toSlug(seg);
  }
  return PROJECT_NONE;
}

function resolveProjectKey(params = {}) {
  const p = asObject(params);
  for (const key of PROJECT_KEY_CANDIDATES) {
    const value = p[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    const k = projectKeyFromPath(value.trim());
    if (k !== PROJECT_NONE) return k;
  }
  return PROJECT_NONE;
}

// CROSS_PROJECT_FIX_20260419: derive a project key from free-text prompts so
// working-memory facts get scoped per project. Without this, a fact like
// "currentGoal: Tienes acceso a la plataforma MdxPlatformMdx" would persist
// across every subsequent prompt regardless of which project the user was
// actually asking about.
function resolveProjectKeyFromText(text) {
  const s = normalizeWhitespace(text);
  if (!s) return PROJECT_NONE;
  // 1) Explicit Railway / custom domains we see today.
  const urlPatterns = [
    /\bplatformdx-frontend[-\w]*\.up\.railway\.app\b/i,
    /\bmdxplatformmdx[-\w]*\.up\.railway\.app\b/i,
    /\bautomation\.mdxspace\.com\b/i,
    /\bmdx-engage\b/i,
    /\bplatformdx\b/i,
    /\bmdxplatformmdx\b/i,
  ];
  const rawSlugs = {
    'platformdx-frontend': 'platformdx',
    'mdxplatformmdx': 'platformdx',
    'platformdx': 'platformdx',
    'automation.mdxspace.com': 'mdx-engage',
    'mdx-engage': 'mdx-engage',
  };
  for (const re of urlPatterns) {
    const match = s.match(re);
    if (match && match[0]) {
      const key = match[0].toLowerCase().split('.')[0];
      const slug = rawSlugs[match[0].toLowerCase()] || rawSlugs[key];
      if (slug) return toSlug(slug);
    }
  }
  // 2) CROSS_PROJECT_FIX_20260608: any repo-like path mentioned in the prompt.
  // projectKeyFromPath handles /projects/<name>/, workspace-<agent>/<repo>, and
  // /home/clawd/<repo> uniformly, and excludes generic/home roots.
  const pathMatches = s.match(/(?:\/[A-Za-z0-9._-]+){2,}/g) || [];
  for (const pm of pathMatches) {
    const k = projectKeyFromPath(pm);
    if (k !== PROJECT_NONE) return k;
  }
  return PROJECT_NONE;
}

function ensureProjectBuckets(state) {
  if (!state.recentByProject || typeof state.recentByProject !== 'object' || Array.isArray(state.recentByProject)) {
    state.recentByProject = {};
  }
  if (!state.recentByProject[PROJECT_NONE]) {
    state.recentByProject[PROJECT_NONE] = { files: [], commands: [], urls: [] };
  }
  return state.recentByProject;
}

function getProjectBucket(state, projectKey) {
  const buckets = ensureProjectBuckets(state);
  const key = projectKey || PROJECT_NONE;
  if (!buckets[key] || typeof buckets[key] !== 'object') {
    buckets[key] = { files: [], commands: [], urls: [] };
  }
  const bucket = buckets[key];
  if (!Array.isArray(bucket.files)) bucket.files = [];
  if (!Array.isArray(bucket.commands)) bucket.commands = [];
  if (!Array.isArray(bucket.urls)) bucket.urls = [];
  return bucket;
}

// CROSS_PROJECT_FIX_20260419: per-project facts bucket. On first access of a
// legacy state (where facts live at state.facts), migrate them to
// state.factsByProject[_none] so they don't leak into whichever project the
// current prompt lands in.
function ensureFactsByProject(state) {
  if (!state.factsByProject || typeof state.factsByProject !== 'object' || Array.isArray(state.factsByProject)) {
    state.factsByProject = {};
  }
  if (state.facts && typeof state.facts === 'object' && !state.factsByProject[PROJECT_NONE]) {
    // Migration: seed _none with the legacy global facts so no data is lost.
    state.factsByProject[PROJECT_NONE] = { ...state.facts };
  }
  if (!state.factsByProject[PROJECT_NONE] || typeof state.factsByProject[PROJECT_NONE] !== 'object') {
    state.factsByProject[PROJECT_NONE] = {
      currentGoal: null, activeTask: null, currentHypothesis: null,
      nextStep: null, blocker: null, lastUserPrompt: null,
      lastAssistantTurn: null, lastToolName: null, lastToolOutcome: null, lastError: null,
    };
  }
  return state.factsByProject;
}

function getProjectFacts(state, projectKey) {
  const buckets = ensureFactsByProject(state);
  const key = projectKey || PROJECT_NONE;
  if (!buckets[key] || typeof buckets[key] !== 'object') {
    buckets[key] = {
      currentGoal: null, activeTask: null, currentHypothesis: null,
      nextStep: null, blocker: null, lastUserPrompt: null,
      lastAssistantTurn: null, lastToolName: null, lastToolOutcome: null, lastError: null,
    };
  }
  return buckets[key];
}

function stateFilePath(ref = {}) {
  const identity = sessionIdentity(ref);
  const agentDir = path.join(WORKING_MEMORY_DIR, toSlug(identity.agentId));
  const fileName = `${sha(identity.stableKey).slice(0, 24)}.json`;
  return { identity, filePath: path.join(agentDir, fileName) };
}

function defaultState(ref = {}) {
  const { agentId, sessionKey, sessionId, stableKey } = sessionIdentity(ref);
  const timestamp = nowIso();
  return {
    version: 1,
    kind: 'brainx-working-memory',
    agentId,
    sessionKey,
    sessionId,
    stableKey,
    createdAt: timestamp,
    updatedAt: timestamp,
    closedAt: null,
    counters: {
      prompts: 0,
      toolCalls: 0,
      toolFailures: 0,
      assistantUpdates: 0,
      llmSummaries: 0,
    },
    facts: {
      currentGoal: null,
      activeTask: null,
      currentHypothesis: null,
      nextStep: null,
      blocker: null,
      lastUserPrompt: null,
      lastAssistantTurn: null,
      lastToolName: null,
      lastToolOutcome: null,
      lastError: null,
    },
    recent: {
      files: [],
      commands: [],
      urls: [],
      events: [],
    },
    recentByProject: {
      [PROJECT_NONE]: { files: [], commands: [], urls: [] },
    },
    activeProject: null,
    summary: {
      headline: null,
      confidence: null,
      notes: [],
      model: null,
      updatedAt: null,
    },
  };
}

function getMaxEvents(options = {}) {
  const value = Number(options.maxEvents || DEFAULT_MAX_EVENTS);
  if (!Number.isFinite(value)) return DEFAULT_MAX_EVENTS;
  return Math.max(6, Math.min(20, Math.round(value)));
}

function getMaxItems(options = {}) {
  const value = Number(options.maxItems || DEFAULT_MAX_ITEMS);
  if (!Number.isFinite(value)) return DEFAULT_MAX_ITEMS;
  return Math.max(3, Math.min(10, Math.round(value)));
}

async function resolveMiniMaxOauthAccessToken() {
  if (cachedMiniMaxOauth.key && cachedMiniMaxOauth.expiresAt > Date.now()) {
    return cachedMiniMaxOauth.key;
  }

  const authProfilePath = path.join(STATE_DIR, 'agents', 'main', 'agent', 'auth-profiles.json');
  try {
    const parsed = JSON.parse(await fs.readFile(authProfilePath, 'utf8'));
    const profile = parsed?.profiles?.['minimax-portal:default'];
    const access = normalizeWhitespace(profile?.access);
    const expires = Number(profile?.expires || 0);
    if (!access) return '';
    cachedMiniMaxOauth = {
      key: access,
      expiresAt: Number.isFinite(expires) && expires > Date.now() ? expires : Date.now() + 5 * 60 * 1000,
    };
    return cachedMiniMaxOauth.key;
  } catch {
    return '';
  }
}

function keepNewestUnique(list, value, limit, keyFn) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return list;
  const next = [];
  const seen = new Set();
  const push = (item) => {
    const key = keyFn ? keyFn(item) : String(item).toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    next.push(item);
  };
  push(normalized);
  for (const item of Array.isArray(list) ? list : []) push(item);
  return next.slice(0, limit);
}

function pushEvent(state, event, options = {}) {
  const limit = getMaxEvents(options);
  const entry = {
    ts: nowIso(),
    kind: event.kind || 'note',
    detail: truncate(event.detail || '', 240),
  };
  if (!entry.detail) return;
  if (!state.recent || typeof state.recent !== 'object') {
    state.recent = { files: [], commands: [], urls: [], events: [] };
  }
  const recent = Array.isArray(state?.recent?.events) ? state.recent.events : [];
  state.recent.events = [entry, ...recent].slice(0, limit);
}

function isLiveMessagingPrompt(prompt) {
  const normalized = normalizeWhitespace(prompt);
  if (!normalized) return false;
  return UNTRUSTED_PROMPT_MARKERS.some((re) => re.test(normalized));
}

function firstUntrustedMarkerIndex(prompt) {
  const normalized = normalizeWhitespace(prompt);
  if (!normalized) return -1;
  return UNTRUSTED_PROMPT_MARKERS.reduce((best, re) => {
    const match = normalized.match(re);
    if (!match || typeof match.index !== 'number') return best;
    if (best === -1) return match.index;
    return Math.min(best, match.index);
  }, -1);
}

function stripWrappedEnvelope(prompt) {
  let normalized = normalizeWhitespace(prompt);
  if (!normalized) return { text: '', changed: false };
  let changed = false;
  // SANITIZE_FIX_20260419: strip all known wrapper prefixes in a loop until the
  // prompt stabilizes. Covers media envelopes ([Image], [Video], etc.),
  // channel envelopes (Discord/Slack/...), media-attached hints, cron wrappers
  // and systemic rules that the gateway prepends.
  const prefixes = [
    WRAPPED_MEDIA_PREFIX_RE,
    WRAPPED_MEDIA_ATTACH_PREFIX_RE,
    WRAPPED_CRON_PREFIX_RE,
    WRAPPED_CHANNEL_PREFIX_RE,
  ];
  let stable = false;
  let passes = 0;
  while (!stable && passes < 6) {
    stable = true;
    for (const re of prefixes) {
      if (re.test(normalized)) {
        normalized = normalizeWhitespace(normalized.replace(re, ''));
        changed = true;
        stable = false;
      }
    }
    passes++;
  }
  // SANITIZE_FIX_20260502: any UNTRUSTED marker at index 0 must drop BEFORE the
  // sender-prefix strip. WRAPPED_SENDER_PREFIX_RE matches "Marker: body"
  // patterns and eats "File delivery rule: ", "Conversation info (untrusted
  // metadata): ", "Sender (untrusted metadata): ", "UNTRUSTED Discord message
  // body: ", etc — leaving the marker body to leak downstream as
  // facts.activeTask / currentGoal. The post-strip SYSTEMIC check below missed
  // it because the head was already gone after sender-prefix ate it.
  if (firstUntrustedMarkerIndex(normalized) === 0) {
    return { text: '', changed: true };
  }
  if (changed && WRAPPED_SENDER_PREFIX_RE.test(normalized)) {
    normalized = normalizeWhitespace(normalized.replace(WRAPPED_SENDER_PREFIX_RE, ''));
  }
  // After stripping envelopes, if what remains is a pure systemic head (e.g.
  // only "File delivery rule: ..." with nothing from the user), treat the
  // entire thing as discardable.
  if (SYSTEMIC_PROMPT_HEAD_RE.test(normalized)) {
    return { text: '', changed: true };
  }
  return { text: normalized, changed };
}

function extractQuestionFromWrappedPrompt(prompt) {
  const normalized = normalizeWhitespace(prompt);
  if (!normalized) return '';

  const envelope = stripWrappedEnvelope(normalized);
  if (envelope.changed && envelope.text && envelope.text !== normalized) {
    const strippedQuestion = extractQuestionFromWrappedPrompt(envelope.text);
    if (strippedQuestion) return strippedQuestion;
  }

  const labelledMatches = Array.from(
    normalized.matchAll(/\b(?:pregunta|question|actual question|user question|consulta)\b\s*:\s*([\s\S]+?)(?=(?:\b(?:respuesta?|answer|output)\b\s*:)|$)/gi),
  );
  const labelled = normalizeWhitespace(labelledMatches.at(-1)?.[1]);
  if (labelled.length >= 8) return labelled;

  const segments = normalized
    .split(/(?:\n+|(?<=[.!?])\s+(?=(?:[A-ZÁÉÍÓÚÑ¿]|Pregunta\b|Question\b|Consulta\b)))/)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);

  const candidate = [...segments]
    .reverse()
    .find((part) => {
      if (part.length < 8) return false;
      if (/^(?:no uses|no leas|no cites|responde|devuelve|answer|respond|return|do not|dont)\b/i.test(part)) {
        return false;
      }
      if (UNTRUSTED_PROMPT_MARKERS.some((re) => re.test(part))) return false;
      return /[?？]$/.test(part) || /^¿/.test(part);
    });

  return candidate || '';
}

function sanitizePromptForWorkingMemory(prompt) {
  const normalized = normalizeWhitespace(prompt);
  if (!normalized) return '';

  const wrappedQuestion = extractQuestionFromWrappedPrompt(normalized);
  if (wrappedQuestion) return truncate(wrappedQuestion, 500);

  const envelope = stripWrappedEnvelope(normalized);
  // SANITIZE_FIX_20260502: when envelope explicitly returns changed=true with
  // text='' it has already classified the prompt as "drop entirely" (e.g. an
  // untrusted marker at index 0 after envelope-strip). Falling back to
  // `normalized` re-introduces the wrapper-plus-marker chain that just got
  // rejected and lets it through downstream because the surface marker
  // (e.g. "[Image] ") isn't in UNTRUSTED_PROMPT_MARKERS.
  const candidate = envelope.changed ? envelope.text : normalized;
  if (!candidate) return '';
  const markerIndex = firstUntrustedMarkerIndex(candidate);
  // SANITIZE_FIX_20260423: the previous guard `markerIndex > 0` let prompts
  // whose FIRST char is already an untrusted marker ("Conversation info
  // (untrusted metadata): …" with no user text before it) pass through
  // verbatim into facts.lastUserPrompt. Treat marker-at-0 as "nothing salvable"
  // and return ''. This is the re-contamination loop that `brainx fix` cleans
  // and then the next turn re-creates.
  if (markerIndex === 0) return '';
  if (markerIndex > 0) {
    return truncate(normalizeWhitespace(candidate.slice(0, markerIndex)), 500);
  }

  return truncate(candidate, 500);
}

function extractQuestion(prompt) {
  const normalized = sanitizePromptForWorkingMemory(prompt);
  if (!normalized) return '';
  const labelled = normalized.match(/\b(?:pregunta|question|consulta)\b\s*:\s*([\s\S]+)$/i);
  if (labelled?.[1]) return truncate(labelled[1], 500);
  const segments = normalized
    .split(/(?<=[.!?])\s+/)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);
  const question = [...segments].find((part) => /^¿/.test(part) || /[?？]$/.test(part));
  return truncate(question || segments[0] || normalized, 500);
}

function extractGoalFromPrompt(prompt) {
  const question = extractQuestion(prompt);
  if (!question) return null;
  if (question.length < 18) return null;
  return truncate(question.replace(/^¿/, ''), 180);
}

function stateActivityMs(state) {
  return (
    parseIsoMs(state?.updatedAt)
    ?? parseIsoMs(state?.summary?.updatedAt)
    ?? parseIsoMs(state?.closedAt)
    ?? parseIsoMs(state?.createdAt)
  );
}

function isClosedState(state) {
  return Boolean(parseIsoMs(state?.closedAt));
}

function isStaleOpenState(state) {
  if (isClosedState(state)) return false;
  const activityMs = stateActivityMs(state);
  return activityMs != null && Date.now() - activityMs > STALE_OPEN_SESSION_MS;
}

function isExpiredClosedState(state) {
  const closedAtMs = parseIsoMs(state?.closedAt);
  return closedAtMs != null && Date.now() - closedAtMs > CLOSED_SESSION_TTL_MS;
}

function hasUntrustedPromptLeak(state) {
  const facts = state?.facts || {};
  return ['currentGoal', 'activeTask', 'lastUserPrompt'].some((key) =>
    UNTRUSTED_PROMPT_MARKERS.some((re) => re.test(normalizeWhitespace(facts[key]))) || WRAPPED_CHANNEL_PREFIX_RE.test(normalizeWhitespace(facts[key])),
  );
}

async function pruneWorkingMemoryDir() {
  let agents = [];
  try {
    agents = await fs.readdir(WORKING_MEMORY_DIR, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of agents) {
    if (!entry.isDirectory()) continue;
    const agentDir = path.join(WORKING_MEMORY_DIR, entry.name);
    let files = [];
    try {
      files = await fs.readdir(agentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const filePath = path.join(agentDir, file.name);
      let state;
      try {
        state = JSON.parse(await fs.readFile(filePath, 'utf8'));
      } catch {
        continue;
      }
      const before = JSON.stringify(state);
      sanitizeStateInPlace(state);
      let shouldWrite = JSON.stringify(state) !== before;

      if (isExpiredClosedState(state)) {
        await fs.unlink(filePath).catch(() => {});
        continue;
      }

      if (isStaleOpenState(state)) {
        state.closedAt = state.closedAt || nowIso();
        state.updatedAt = nowIso();
        pushEvent(state, { kind: 'session_end', detail: 'session auto-closed after stale inactivity' });
        shouldWrite = true;
      }

      if (!shouldWrite) continue;
      await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
    }
  }
}

async function maybePruneWorkingMemory() {
  if (Date.now() - lastPruneAt < PRUNE_INTERVAL_MS) return;
  if (prunePromise) return prunePromise;
  prunePromise = pruneWorkingMemoryDir()
    .catch(() => {})
    .finally(() => {
      lastPruneAt = Date.now();
      prunePromise = null;
    });
  return prunePromise;
}

function extractSentenceBySignal(text, signalRe) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return null;
  const sentences = normalized
    .split(/(?<=[.!?])\s+/)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);
  const found = sentences.find((sentence) => signalRe.test(sentence));
  return found ? truncate(found, 180) : null;
}

function extractNextStep(text) {
  return extractSentenceBySignal(
    text,
    /\b(next step|siguiente paso|next up|ahora voy a|voy a|we should|debemos|toca\s+(?:revisar|probar|ver|inspeccionar|hacer)|the plan is|plan now)\b/i,
  );
}

function extractHypothesis(text) {
  return extractSentenceBySignal(
    text,
    /\b(hypothesis|hip[oó]tesis|root cause|causa ra[ií]z|likely|probablemente|parece que|the issue is|el problema es)\b/i,
  );
}

function extractPaths(params = {}) {
  const keys = ['path', 'file', 'filePath', 'filepath', 'workdir', 'cwd', 'target', 'source', 'destination'];
  const values = [];
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.trim() && isLikelyPath(value)) values.push(value.trim());
  }
  return values
    .map((value) => truncate(value, 160))
    .filter(Boolean);
}

function extractUrls(params = {}) {
  const text = JSON.stringify(asObject(params));
  const matches = Array.isArray(text.match(/https?:\/\/[^\s"']+/g)) ? text.match(/https?:\/\/[^\s"']+/g) : [];
  const urls = [];
  const seen = new Set();
  for (const value of matches || []) {
    const normalized = truncate(value, 180);
    const key = String(normalized).toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    urls.push(normalized);
    if (urls.length >= DEFAULT_MAX_ITEMS) break;
  }
  return urls;
}

function extractCommand(params = {}) {
  const command = typeof params.command === 'string' ? params.command : typeof params.cmd === 'string' ? params.cmd : '';
  const normalized = normalizeWhitespace(command);
  if (!normalized) return null;
  const firstLine = normalizeWhitespace(String(command).replace(/\r/g, '').split('\n')[0]);
  if (!firstLine) return null;
  const heredocMatch = firstLine.match(/^cat\s+<<\s*['"]?EOF['"]?\s*>\s*(.+)$/i);
  if (heredocMatch?.[1]) return truncate(`cat > ${normalizeWhitespace(heredocMatch[1])}`, 180);
  return truncate(firstLine, 180);
}

function extractToolText(result) {
  if (typeof result === 'string') return normalizeWhitespace(result);
  if (result == null) return '';
  const content = Array.isArray(result?.content) ? result.content : [];
  for (const part of content) {
    if (typeof part?.text === 'string' && normalizeWhitespace(part.text)) {
      return normalizeWhitespace(part.text);
    }
  }
  return '';
}

function extractTransportSummary(result) {
  const details = asObject(result?.details);
  for (const key of TRANSPORT_OUTCOME_KEYS) {
    if (normalizeWhitespace(details[key])) return 'sent';
  }
  const text = extractToolText(result);
  if (TRANSPORT_OUTCOME_KEYS.some((key) => text.includes(`"${key}"`))) return 'sent';
  return 'sent';
}

function summarizeToolOutcome(toolName, params = {}, result) {
  if (result == null) return null;
  const normalizedTool = normalizeWhitespace(toolName).toLowerCase();
  const paths = extractPaths(params);
  const firstPath = paths[0] || null;
  if (TRANSPORT_TOOL_NAMES.has(normalizedTool)) return firstPath ? `sent via ${firstPath}` : 'sent';

  const details = asObject(result?.details);
  const text = extractToolText(result);

  if (normalizedTool === 'read') {
    const target = firstPath || normalizeWhitespace(details.path);
    return target ? `read ${truncate(target, 140)}` : 'read ok';
  }
  if (normalizedTool === 'write' || normalizedTool === 'edit') {
    const target = firstPath || normalizeWhitespace(details.path);
    return target ? `${normalizedTool} ${truncate(target, 140)}` : `${normalizedTool} ok`;
  }
  if (normalizedTool === 'browser') return 'browser ok';
  if (normalizedTool === 'image') return 'image ok';
  if (normalizedTool === 'exec' || normalizedTool === 'process') {
    const status = normalizeWhitespace(details.status);
    const exitCode = Number.isFinite(Number(details.exitCode)) ? Number(details.exitCode) : null;
    const timedOut = Boolean(details.timedOut);
    if (timedOut) return `${normalizedTool} timed out`;
    if (status === 'running') return `${normalizedTool} running`;
    if (exitCode != null) return `${normalizedTool} exit=${exitCode}`;
  }

  if (text) return truncate(text, 180);
  try {
    return truncate(JSON.stringify(result), 180);
  } catch {
    return truncate(String(result), 180);
  }
}

function sanitizeToolEventDetail(detail) {
  const normalized = normalizeWhitespace(detail);
  if (!normalized) return '';
  if (/^message ok \|/i.test(normalized)) return 'message ok | sent';
  if (/^message failed \|/i.test(normalized)) return 'message failed';
  if (/^message started$/i.test(normalized)) return 'message started';
  if (/^(read|write|edit|exec|process) ok \|\s*\{"/i.test(normalized)) {
    return normalized.replace(/\|\s*\{.+$/i, '| ok');
  }
  return truncate(normalized, 240);
}

function sanitizeStateInPlace(state, options = {}) {
  if (!state || typeof state !== 'object') return state;
  const facts = asObject(state.facts);
  const recent = asObject(state.recent);

  const sanitizeFactsBlock = (factsObj) => {
    if (!factsObj || typeof factsObj !== 'object') return;
    for (const key of ['currentGoal', 'activeTask', 'lastUserPrompt']) {
      const value = normalizeWhitespace(factsObj[key]);
      if (!value) continue;
      const cleaned = sanitizePromptForWorkingMemory(value);
      // SANITIZE_FIX_20260423: when sanitizer returns '' (e.g. marker-at-0
      // case), DROP the field instead of leaving the contaminated value.
      if (cleaned) factsObj[key] = truncate(cleaned, key === 'lastUserPrompt' ? 320 : 180);
      else factsObj[key] = null;
    }
  };

  sanitizeFactsBlock(facts);
  // Also sanitize per-project facts buckets — the cross-project fix in
  // 2026-04-19 copies facts into factsByProject but the original sanitize
  // only covered the top-level `facts` block, leaving contamination behind.
  const fbp = asObject(state.factsByProject);
  for (const bucket of Object.values(fbp)) sanitizeFactsBlock(bucket);

  if (normalizeWhitespace(facts.lastToolName)) {
    const toolName = normalizeWhitespace(facts.lastToolName).toLowerCase();
    const outcome = normalizeWhitespace(facts.lastToolOutcome);
    if (TRANSPORT_TOOL_NAMES.has(toolName) && outcome) {
      facts.lastToolOutcome = 'sent';
    } else if ((outcome.startsWith('{') || outcome.includes('"messageId"') || outcome.includes('"channelId"')) && outcome) {
      facts.lastToolOutcome = `${toolName} ok`;
    }
  }

  // Legacy recent.{files,commands,urls} is cross-project contaminated (pre-2026-04-18). Discard it.
  // Current data lives in state.recentByProject keyed by project slug.
  delete recent.files;
  delete recent.commands;
  delete recent.urls;

  ensureProjectBuckets(state);
  for (const [projectKey, rawBucket] of Object.entries(state.recentByProject)) {
    const bucket = asObject(rawBucket);
    bucket.files = Array.isArray(bucket.files)
      ? bucket.files.filter(isLikelyPath).map((value) => truncate(value, 160)).filter(Boolean).slice(0, getMaxItems(options))
      : [];
    bucket.commands = Array.isArray(bucket.commands)
      ? bucket.commands.map((value) => extractCommand({ command: value })).filter(Boolean).slice(0, getMaxItems(options))
      : [];
    bucket.urls = Array.isArray(bucket.urls)
      ? bucket.urls.map((value) => truncate(value, 180)).filter(Boolean).slice(0, getMaxItems(options))
      : [];
    state.recentByProject[projectKey] = bucket;
  }
  if (state.activeProject != null && typeof state.activeProject !== 'string') state.activeProject = null;
  if (typeof state.activeProject === 'string' && !state.activeProject.trim()) state.activeProject = null;

  recent.events = Array.isArray(recent.events)
    ? recent.events
        .map((event) => {
          const kind = normalizeWhitespace(event?.kind) || 'note';
          let detail = normalizeWhitespace(event?.detail);
          if (kind === 'prompt') detail = sanitizePromptForWorkingMemory(detail);
          else if (kind === 'tool' || kind === 'tool_result' || kind === 'tool_error') detail = sanitizeToolEventDetail(detail);
          else detail = truncate(detail, 240);
          if (!detail) return null;
          return { ts: event?.ts || nowIso(), kind, detail };
        })
        .filter(Boolean)
        .slice(0, getMaxEvents(options))
    : [];

  state.facts = facts;
  state.recent = recent;
  return state;
}

function buildHeadline(state) {
  const facts = state?.facts || {};
  const parts = [];
  if (facts.activeTask) parts.push(`task=${facts.activeTask}`);
  if (facts.lastToolName) parts.push(`tool=${facts.lastToolName}`);
  if (facts.blocker) parts.push(`blocker=${facts.blocker}`);
  return truncate(parts.join(' | '), 180);
}

async function buildLlmSettings(options = {}) {
  const explicitEnabled = options.useLlm;
  const baseURL = normalizeWhitespace(options.llmBaseURL) || process.env.BRAINX_WORKING_MEMORY_LLM_BASE_URL || 'https://api.minimax.io/v1';
  const model = normalizeWhitespace(options.llmModel) || process.env.BRAINX_WORKING_MEMORY_LLM_MODEL || 'MiniMax-M2.7';
  const explicitApiKey = normalizeWhitespace(process.env.BRAINX_WORKING_MEMORY_API_KEY || '');
  const oauthApiKey = await resolveMiniMaxOauthAccessToken();
  const envApiKey = normalizeWhitespace(process.env.MINIMAX_API_KEY || '');
  const apiKey = explicitApiKey || oauthApiKey || envApiKey;
  const enabled = typeof explicitEnabled === 'boolean'
    ? explicitEnabled && Boolean(apiKey)
    : Boolean(apiKey);
  return {
    enabled,
    apiKey,
    baseURL,
    model,
    cooldownMs: Number(options.llmCooldownMs || DEFAULT_SUMMARY_COOLDOWN_MS),
    minTextChars: Number(options.llmMinTextChars || DEFAULT_SUMMARY_MIN_TEXT_CHARS),
  };
}

function getClient(settings) {
  const cacheKey = `${settings.baseURL}|${settings.apiKey}`;
  if (cachedClient && cachedClientKey === cacheKey) return cachedClient;
  cachedClientKey = cacheKey;
  cachedClient = new OpenAI({
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
  });
  return cachedClient;
}

function extractJsonObject(text) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return null;
  const fenced = normalized.match(/```(?:json)?\s*([\s\S]+?)```/i);
  const candidate = fenced?.[1] || normalized;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function withSessionState(ref, handler) {
  await maybePruneWorkingMemory();
  const { filePath, identity } = stateFilePath(ref);
  const key = filePath;
  const previous = sessionQueues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      let state;
      try {
        state = JSON.parse(await fs.readFile(filePath, 'utf8'));
      } catch {
        state = defaultState(identity);
      }
      sanitizeStateInPlace(state);
      state.agentId = identity.agentId;
      state.sessionKey = identity.sessionKey;
      state.sessionId = identity.sessionId;
      state.stableKey = identity.stableKey;
      state.closedAt = null;
      const result = await handler(state, { filePath, identity });
      state.updatedAt = nowIso();
      await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
      return result;
    });
  sessionQueues.set(key, next.finally(() => {
    if (sessionQueues.get(key) === next) sessionQueues.delete(key);
  }));
  return next;
}

async function prepareSession(ref, options = {}) {
  return withSessionState(ref, async (state) => {
    pushEvent(state, { kind: 'session', detail: 'session initialized' }, options);
    return { ok: true, sessionKey: state.sessionKey, sessionId: state.sessionId };
  });
}

async function observePrompt(ref, prompt, options = {}) {
  const normalized = normalizeWhitespace(prompt);
  const sanitizedPrompt = sanitizePromptForWorkingMemory(prompt);
  if (!normalized) return null;
  if (!sanitizedPrompt) return null;
  // SANITIZE_FIX_20260419: if the sanitized prompt is *still* a systemic
  // wrapper (e.g. survived the strip as "[media attached:..." or starts with
  // "File delivery rule:"), do not let it contaminate durable facts.
  const isSystemic = (
    SYSTEMIC_PROMPT_HEAD_RE.test(sanitizedPrompt)
    || WRAPPED_MEDIA_PREFIX_RE.test(sanitizedPrompt)
    || WRAPPED_MEDIA_ATTACH_PREFIX_RE.test(sanitizedPrompt)
    || WRAPPED_CRON_PREFIX_RE.test(sanitizedPrompt)
    || WRAPPED_CHANNEL_PREFIX_RE.test(sanitizedPrompt)
  );
  return withSessionState(ref, async (state) => {
    state.counters.prompts = Number(state?.counters?.prompts || 0) + 1;
    // CROSS_PROJECT_FIX_20260419: detect project from the prompt text itself so
    // facts (currentGoal, activeTask) don't bleed across unrelated projects.
    const detectedProject = resolveProjectKeyFromText(sanitizedPrompt);
    if (detectedProject !== PROJECT_NONE) {
      state.activeProject = detectedProject;
    }
    const projectKey = normalizeWhitespace(state.activeProject) || PROJECT_NONE;
    const facts = getProjectFacts(state, projectKey);
    // lastUserPrompt is histórico; update even for systemic turns so we know
    // the turn happened. But do NOT overwrite durable facts (currentGoal,
    // activeTask) with systemic text.
    facts.lastUserPrompt = truncate(extractQuestion(sanitizedPrompt), 320);
    if (!isSystemic) {
      const extractedGoal = extractGoalFromPrompt(sanitizedPrompt);
      if (!facts.currentGoal && extractedGoal) facts.currentGoal = extractedGoal;
      facts.activeTask = truncate(extractedGoal || sanitizedPrompt, 180);
    }
    // Mirror to top-level state.facts for backward compatibility with any code
    // or existing consumer that still reads state.facts directly.
    state.facts = facts;
    pushEvent(state, { kind: 'prompt', detail: (isSystemic ? '[systemic]' : (facts.activeTask || sanitizedPrompt)) }, options);
    return state;
  });
}

async function observeToolStart(ref, toolName, params = {}, options = {}) {
  const normalizedTool = normalizeWhitespace(toolName);
  if (!normalizedTool) return null;
  return withSessionState(ref, async (state) => {
    state.counters.toolCalls = Number(state?.counters?.toolCalls || 0) + 1;
    const projectKey = resolveProjectKey(params);
    if (projectKey !== PROJECT_NONE) state.activeProject = projectKey;
    // CROSS_PROJECT_FIX_20260419_184700: tools without paths in params
    // (e.g. Bash with only `command`) would resolve to PROJECT_NONE and
    // drop files/commands/urls into the shared _none bucket even when
    // state.activeProject is already set from a prior prompt or tool.
    // Use the same fallback logic that facts already used.
    const factsProjectKey = projectKey !== PROJECT_NONE ? projectKey : (state.activeProject || PROJECT_NONE);
    const facts = getProjectFacts(state, factsProjectKey);
    facts.lastToolName = normalizedTool;
    facts.lastToolOutcome = 'pending';
    state.facts = facts;
    const bucket = getProjectBucket(state, factsProjectKey);
    for (const filePath of extractPaths(params)) {
      bucket.files = keepNewestUnique(bucket.files, filePath, getMaxItems(options));
    }
    const command = extractCommand(params);
    if (command) bucket.commands = keepNewestUnique(bucket.commands, command, getMaxItems(options));
    for (const url of extractUrls(params)) {
      bucket.urls = keepNewestUnique(bucket.urls, url, getMaxItems(options));
    }
    pushEvent(state, { kind: 'tool', detail: `${normalizedTool} started${command ? ` | ${command}` : ''}` }, options);
    return state;
  });
}

async function observeToolResult(ref, toolName, params = {}, result, error, options = {}) {
  const normalizedTool = normalizeWhitespace(toolName);
  if (!normalizedTool) return null;
  return withSessionState(ref, async (state) => {
    const projectKey = resolveProjectKey(params);
    if (projectKey !== PROJECT_NONE) state.activeProject = projectKey;
    const factsProjectKey = projectKey !== PROJECT_NONE ? projectKey : (state.activeProject || PROJECT_NONE);
    const facts = getProjectFacts(state, factsProjectKey);
    facts.lastToolName = normalizedTool;
    if (error) {
      const errorText = truncate(error, 220);
      state.counters.toolFailures = Number(state?.counters?.toolFailures || 0) + 1;
      facts.lastError = errorText;
      facts.blocker = errorText;
      facts.lastToolOutcome = 'failed';
      pushEvent(state, { kind: 'tool_error', detail: `${normalizedTool} failed | ${errorText}` }, options);
    } else {
      const outcome = summarizeToolOutcome(normalizedTool, params, result) || 'success';
      facts.lastToolOutcome = truncate(outcome, 180);
      facts.lastError = null;
      pushEvent(state, { kind: 'tool_result', detail: `${normalizedTool} ok | ${truncate(outcome, 180)}` }, options);
    }
    state.facts = facts;
    // CROSS_PROJECT_FIX_20260419_184700: same bucket fallback as observeToolStart.
    const bucket = getProjectBucket(state, factsProjectKey);
    for (const filePath of extractPaths(params)) {
      bucket.files = keepNewestUnique(bucket.files, filePath, getMaxItems(options));
    }
    const command = extractCommand(params);
    if (command) bucket.commands = keepNewestUnique(bucket.commands, command, getMaxItems(options));
    for (const url of extractUrls(params)) {
      bucket.urls = keepNewestUnique(bucket.urls, url, getMaxItems(options));
    }
    return state;
  });
}

async function summarizeWithLlm(state, assistantText, options = {}) {
  const settings = await buildLlmSettings(options);
  if (!settings.enabled) return null;
  if (normalizeWhitespace(assistantText).length < settings.minTextChars) return null;

  const lastSummaryAt = state?.summary?.updatedAt ? Date.parse(state.summary.updatedAt) : NaN;
  if (Number.isFinite(lastSummaryAt) && Date.now() - lastSummaryAt < settings.cooldownMs) return null;

  const client = getClient(settings);
  const compactState = {
    currentGoal: state?.facts?.currentGoal || null,
    activeTask: state?.facts?.activeTask || null,
    currentHypothesis: state?.facts?.currentHypothesis || null,
    nextStep: state?.facts?.nextStep || null,
    blocker: state?.facts?.blocker || null,
    lastToolName: state?.facts?.lastToolName || null,
    lastToolOutcome: state?.facts?.lastToolOutcome || null,
    lastError: state?.facts?.lastError || null,
    files: Array.isArray(state?.recent?.files) ? state.recent.files.slice(0, 4) : [],
    commands: Array.isArray(state?.recent?.commands) ? state.recent.commands.slice(0, 3) : [],
    events: Array.isArray(state?.recent?.events) ? state.recent.events.slice(0, 6) : [],
  };

  const response = await client.chat.completions.create({
    model: settings.model,
    temperature: 0,
    max_tokens: DEFAULT_SUMMARY_MAX_TOKENS,
    messages: [
      {
        role: 'system',
        content:
          'You maintain BrainX working memory. Output one raw JSON object only. Do not output reasoning. Do not output <think>. Do not use markdown fences. Start with { and end with }. Use null when uncertain. Never invent facts. JSON schema: {"currentGoal":string|null,"activeTask":string|null,"currentHypothesis":string|null,"nextStep":string|null,"blocker":string|null,"headline":string|null,"notes":string[],"confidence":number|null}. Keep strings short, concrete, and operational.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          state: compactState,
          latestAssistantOutput: truncate(assistantText, 2200),
        }),
      },
    ],
  });

  const content = response?.choices?.[0]?.message?.content || '';
  return {
    parsed: extractJsonObject(content),
    model: settings.model,
  };
}

async function observeAssistantOutput(ref, assistantText, options = {}) {
  const normalized = normalizeWhitespace(assistantText);
  if (!normalized) return null;

  let snapshot = null;
  await withSessionState(ref, async (state) => {
    state.counters.assistantUpdates = Number(state?.counters?.assistantUpdates || 0) + 1;
    // CROSS_PROJECT_FIX_20260419: write assistant-derived facts to the active
    // project bucket, not to a global state.facts.
    const activeKey = normalizeWhitespace(state.activeProject) || PROJECT_NONE;
    const facts = getProjectFacts(state, activeKey);
    facts.lastAssistantTurn = truncate(normalized, 600);
    facts.nextStep = extractNextStep(normalized) || facts.nextStep;
    facts.currentHypothesis = extractHypothesis(normalized) || facts.currentHypothesis;
    if (/resolved|solved|fixed|listo|qued[oó]|ya est[aá] arreglado/i.test(normalized)) {
      facts.blocker = null;
    }
    state.facts = facts;
    pushEvent(state, { kind: 'assistant', detail: truncate(normalized, 220) }, options);
    snapshot = JSON.parse(JSON.stringify(state));
    return state;
  });

  let llmUpdate = null;
  try {
    llmUpdate = await summarizeWithLlm(snapshot, normalized, options);
  } catch {
    llmUpdate = null;
  }

  const parsed = llmUpdate?.parsed && typeof llmUpdate.parsed === 'object' ? llmUpdate.parsed : null;
  if (parsed) {
    await withSessionState(ref, async (state) => {
      if (parsed) {
        // CROSS_PROJECT_FIX_20260419: write LLM-summarized facts to the active
        // project bucket, not to the legacy global state.facts.
        const activeKey = normalizeWhitespace(state.activeProject) || PROJECT_NONE;
        const facts = getProjectFacts(state, activeKey);
        const fields = ['currentGoal', 'activeTask', 'currentHypothesis', 'nextStep', 'blocker'];
        for (const field of fields) {
          if (!(field in parsed)) continue;
          const raw = parsed[field];
          facts[field] = raw == null ? null : truncate(raw, 180);
        }
        state.facts = facts;
        state.summary = {
          headline: truncate(parsed.headline || buildHeadline(state), 180) || null,
          confidence:
            parsed.confidence == null
              ? null
              : Number.isFinite(Number(parsed.confidence))
                ? Number(Number(parsed.confidence).toFixed(3))
                : null,
          notes: Array.isArray(parsed.notes)
            ? parsed.notes.map((note) => truncate(note, 120)).filter(Boolean).slice(0, 4)
            : [],
          model: llmUpdate.model,
          updatedAt: nowIso(),
        };
        state.counters.llmSummaries = Number(state?.counters?.llmSummaries || 0) + 1;
      }
      return state;
    });
  }

  return llmUpdate;
}

async function closeSession(ref, options = {}) {
  return withSessionState(ref, async (state) => {
    state.closedAt = nowIso();
    pushEvent(state, { kind: 'session_end', detail: 'session closed' }, options);
    return { ok: true, closedAt: state.closedAt };
  });
}

function formatBlockFromState(state, maxChars) {
  if (!state) return null;
  // CROSS_PROJECT_FIX_20260419: read facts from the active project bucket, NOT
  // from the global state.facts. Without this a stale goal from a previous
  // project would leak into prompts about unrelated projects.
  const activeProject = normalizeWhitespace(state.activeProject) || PROJECT_NONE;
  ensureFactsByProject(state);
  // CROSS_PROJECT_FIX_20260419_184700: when no active project is known, the
  // _none bucket holds a mix of facts and commands from whatever project(s)
  // the agent touched in prior turns. Injecting that back is the main vector
  // of "artemis worked in the wrong project" incidents. Skip injection
  // entirely when activeProject is unknown — aligned with the on-demand
  // philosophy: inject only when a signal is clear.
  if (activeProject === PROJECT_NONE) return null;
  const facts = asObject(state.factsByProject?.[activeProject]) ?? {};
  if (!facts || Object.keys(facts).length === 0) return null;
  const lines = ['BrainX working memory — continuidad de sesion. Usala solo si sigue siendo relevante y nunca reemplaces la solicitud actual del usuario.'];
  const push = (label, value) => {
    const text = truncate(value, 180);
    if (!text) return;
    lines.push(`- ${label}: ${text}`);
  };

  push('Goal', facts.currentGoal);
  push('Task', facts.activeTask);
  push('Hypothesis', facts.currentHypothesis);
  push('Blocker', facts.blocker);
  const lastToolName = normalizeWhitespace(facts.lastToolName);
  if (lastToolName && !TRANSPORT_TOOL_NAMES.has(lastToolName.toLowerCase())) {
    push('Last tool', `${lastToolName}${facts.lastToolOutcome ? ` -> ${facts.lastToolOutcome}` : ''}`);
  }
  const byProject = asObject(state.recentByProject);
  const mergeBucket = (field, limit) => {
    const out = [];
    const seen = new Set();
    const consume = (arr) => {
      if (!Array.isArray(arr)) return;
      for (const item of arr) {
        const key = String(item || '').toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(item);
        if (out.length >= limit) return;
      }
    };
    // CROSS_PROJECT_FIX_20260419_184700: do NOT merge _none bucket into the
    // active project bucket. Before this, an activeProject="mdx-engage" prompt
    // would still see platformdx files that leaked into _none from tools that
    // didn't carry project-detectable params. When activeProject is known, the
    // block shows only that project. When unknown, the block shows only _none.
    if (activeProject !== PROJECT_NONE) {
      consume(asObject(byProject[activeProject])[field]);
    } else {
      consume(asObject(byProject[PROJECT_NONE])[field]);
    }
    return out;
  };
  if (activeProject !== PROJECT_NONE) push('Active project', activeProject);
  const files = mergeBucket('files', 4);
  if (files.length) push('Recent files', files.join(' | '));
  const commands = mergeBucket('commands', 3);
  if (commands.length) push('Recent commands', commands.join(' | '));
  push('Next step', facts.nextStep);
  push('Session summary', state?.summary?.headline);
  if (Array.isArray(state?.summary?.notes) && state.summary.notes.length) push('Notes', state.summary.notes.slice(0, 3).join(' | '));

  // SANITIZE_FIX_20260419: if only the header survived (no useful facts, files,
  // commands or summary to share), return null instead of injecting a bare
  // header line that adds noise without value.
  if (lines.length <= 1) return null;
  return truncate(lines.join('\n'), Math.max(240, maxChars || 800));
}

async function buildPromptBlock(ref, options = {}) {
  await maybePruneWorkingMemory();
  const { filePath } = stateFilePath(ref);
  try {
    const state = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (isClosedState(state) || isStaleOpenState(state)) return null;
    return formatBlockFromState(state, options.maxChars || 800);
  } catch {
    return null;
  }
}

// Read-only snapshot for the plugin's scope/intent inference. Does NOT mutate
// state, does NOT observe new events. The plugin decides scope on its own from
// the raw paths; the skill's `activeProject` slug is advisory only (it has
// edge cases like `/projects/[id]/` producing slug="id").
async function getSessionSnapshot(ref) {
  const { filePath } = stateFilePath(ref);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const state = JSON.parse(raw);
    if (isClosedState(state)) return null;
    return {
      activeProject: state.activeProject || null,
      recentByProject: state.recentByProject || {},
      recent: state.recent || { files: [], commands: [], urls: [], events: [] },
      counters: state.counters || {},
      updatedAt: state.updatedAt || null,
      stale: isStaleOpenState(state),
    };
  } catch {
    return null;
  }
}

async function getStats() {
  await maybePruneWorkingMemory();
  try {
    const agents = await fs.readdir(WORKING_MEMORY_DIR, { withFileTypes: true });
    let fileCount = 0;
    let openCount = 0;
    let closedCount = 0;
    let staleOpenCount = 0;
    let contaminatedCount = 0;
    for (const entry of agents) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(WORKING_MEMORY_DIR, entry.name);
      const files = await fs.readdir(dir);
      for (const file of files.filter((name) => name.endsWith('.json'))) {
        fileCount += 1;
        try {
          const filePath = path.join(dir, file);
          const raw = await fs.readFile(filePath, 'utf8');
          const state = JSON.parse(raw);
          const before = JSON.stringify(state);
          sanitizeStateInPlace(state);
          if (JSON.stringify(state) !== before) {
            await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
          }
          if (isClosedState(state)) closedCount += 1;
          else openCount += 1;
          if (isStaleOpenState(state)) staleOpenCount += 1;
          if (hasUntrustedPromptLeak(state)) contaminatedCount += 1;
        } catch {
          // Ignore malformed state files in stats.
        }
      }
    }
    return { fileCount, openCount, closedCount, staleOpenCount, contaminatedCount };
  } catch {
    return { fileCount: 0, openCount: 0, closedCount: 0, staleOpenCount: 0, contaminatedCount: 0 };
  }
}

module.exports = {
  buildPromptBlock,
  closeSession,
  getSessionSnapshot,
  getStats,
  observeAssistantOutput,
  observePrompt,
  observeToolResult,
  observeToolStart,
  prepareSession,
  // Exported for unit tests (CROSS_PROJECT_FIX_20260608).
  projectKeyFromPath,
  resolveProjectKey,
  resolveProjectKeyFromText,
};
