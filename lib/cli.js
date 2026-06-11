// Load env silently (dotenv prints tips sometimes)
try {
  const dotenv = require('dotenv');
  const path = process.env.BRAINX_ENV || require('path').join(__dirname, '..', '.env');
  dotenv.configDotenv({ path });
} catch (_) {}

const crypto = require('crypto');
const fs = require('fs');
const { summarizeLiveCapture } = require('./live-capture-stats');

let rag;
let db;

function usage() {
  console.log(`brainx

Aliases:
  brainx
  brainx

Commands:
  doctor [--json] [--verbose] [--full]
      Run diagnostic checks on BrainX health, schema, data integrity, and stats.
  fix [--dry-run] [--json] [--verbose] [--skip-embeddings] [--only <step_ids>]
      Auto-repair issues detected by doctor.
  health
  add --type <type> --content <text> [--context <ctx>] [--tier <hot|warm|cold|archive>] [--importance <1-10>] [--tags a,b,c] [--agent <name>] [--id <id>]
      [--status <pending|in_progress|resolved|promoted|wont_fix>] [--category <category>]
      [--patternKey <key>] [--recurrenceCount <n>] [--firstSeen <iso>] [--lastSeen <iso>] [--resolvedAt <iso>] [--promotedTo <target>] [--resolutionNotes <text>]
      [--sourceKind <kind>] [--sourcePath <path>] [--confidence <0-1>] [--verificationState <verified|hypothesis|changelog|obsolete>] [--expiresAt <iso>] [--sensitivity <normal|sensitive|restricted>]
  fact --content <text> [--context <project:name>] [--importance <1-10>] [--tags a,b,c]
      Shortcut for: add --type fact --tier hot --category infrastructure
  facts [--context <ctx>] [--limit <n>]
      List all stored facts (infrastructure, URLs, services)
  feature --content <text> [--context <project:name>] [--importance <1-10>] [--tags a,b,c]
      Shortcut for: add --type feature_request --tier warm --category feature_request
  features [--context <ctx>] [--limit <n>] [--status <pending|in_progress|resolved|promoted|wont_fix>]
      List all stored feature requests
  search --query <text> [--limit <n>] [--minSimilarity <0-1>] [--context <ctx>] [--tier <tier>] [--minImportance <n>] [--maxSensitivity <normal|sensitive|restricted>]
  inject --query <text> [--limit <n>] [--context <ctx>] [--tier <tier>] [--minImportance <n>] [--minScore <n>] [--agent <name>] [--maxTotalChars <n>] [--maxCharsPerItem <n>] [--maxLinesPerItem <n>] [--maxSensitivity <normal|sensitive|restricted>]
  resolve (--id <id> | --patternKey <key>) --status <pending|in_progress|resolved|promoted|wont_fix> [--resolvedAt <iso>] [--promotedTo <target>] [--resolutionNotes <text>]
  promote-candidates [--minRecurrence <n>] [--days <n>] [--limit <n>] [--json]
  lifecycle-run [--promoteMinRecurrence <n>] [--promoteDays <n>] [--degradeDays <n>] [--lowImportanceMax <n>] [--lowAccessMax <n>] [--promoteImportanceMin <n>] [--demoteImportanceMax <n>] [--dryRun] [--json]
  metrics [--days <n>] [--topPatterns <n>] [--json]
  runtime-report [--days <n>] [--since <iso>] [--until <iso>] [--opsFixCutoff <iso>] [--json]
      Runtime injection report with hard/soft signal ratios and pre/post ops-denylist audit.
  agent-metrics [--days <n>] [--since <iso>] [--until <iso>] [--json] [--markdown] [--include-media-gen]
      Consolidated per-agent BrainX plugin coverage, runtime signal, surfaces, and warnings.
  router-quality [--days <n>] [--since <iso>] [--until <iso>] [--agent <name>] [--surface <name>] [--limit <n>] [--json]
      Router decision quality report for BrainX runtime injections.
  recall-health [--days <n>] [--min-calls <n>] [--json]
      Recall quality health for runtime surfaces: zero-result, zero-selected, no-signal, and stale scoring warnings.
  explain (--id <runtime_injection_id> | --session <session_id> | --sessionKey <session_key> | --agent <agent>) [--limit <n>] [--json]
      Explain BrainX runtime injection decisions from brainx_runtime_injections.
  feedback --id <memory_id> (--useful | --useless | --doubtful | --incorrect) [--supersededBy <memory_id>]
      --useful    Boost importance +1 (max 10), increment access_count, feedback_score +1
      --useless   Lower importance -1 (min 1), feedback_score -1
      --doubtful  Lower trust and move memory back to hypothesis
      --incorrect Mark memory as obsolete; with --supersededBy, point to a replacement memory
  skill-feedback <skill-name> <helpful|wrong|ignored> [--session <session_key>] [--json]
      Report outcome for the most recent load of <skill-name> in the current (or --session) session.
      Looks up the latest brainx_skill_loads row for that skill and stamps its outcome column.
      Used by the host agent to close Spec 2 gap #3 (skills that turned out wrong/ignored).
  skill-stats <skill-name> [--json]
      Outcome stats for a single skill: total loads, helpful / wrong / ignored counts, reported total.
  wiki <status|init|compile|lint|digest|obsidian> [--json] [--vault <dir>] [--knowledgeRoot <dir>] [--agent <name>]
      status      Show BrainX Wiki compile/vault status.
      init        Create the BrainX Wiki vault + Obsidian-compatible folders.
      compile     Compile knowledge + durable memories into the BrainX Wiki vault.
      lint        Validate compile freshness, claims, and Obsidian readiness.
      digest      Read the shared or agent-specific precompiled digest.
      obsidian status|open
                  Report Obsidian compatibility or try to open the vault locally.
  event <init|add|search|timeline|show>
      Deterministic forensic ledger for fixes, incidents, decisions, deployments, handoffs, and audits.
      Routed by the ./brainx wrapper to scripts/event-ledger.js.
  skill-promoter [--min-recurrence <n>] [--days <n>] [--limit <n>] [--per-agent] [--agent-limit <n>] [--per-agent-limit <n>] [--min-score <n>] [--json] [--emit-dir <dir>] [--save] [--auto-create]
      Hermes-style procedural promotion. Emits reusable skill candidates from recurring BrainX patterns.
      Apply mode: --apply with --skill <name>, --candidate-file <file>, or --all. Auto-create mode only creates high-confidence new skills. Both use validation + rollback.
  skill-curator <status|list|pin|unpin|archive|restore|list-archived|prune|run> [--json]
      Hermes-style lifecycle for brainx-created skills: sidecar ownership, pinning, archive/restore, prune.
  self-learning-audit [--days <n>] [--json] [--markdown]
      Read-only autonomy report: noisy memories, useful memories, stale hot/warm rows, repeated failures, and knowledge gaps.
  cost-report [--days N=7] [--agent X] [--operation TYPE] [--model M] [--json]
      LLM cost ledger: total spend, by agent, by operation type. Requires migration 017.

Scripts (run via node scripts/<name>.js):
  reclassify-memories [--dry-run] [--limit <n>]     Reclassify memory types based on content analysis
  cleanup-low-signal [--dry-run]                     Remove or archive low-quality memories
  generate-eval-dataset [--dry-run] [--limit <n>]    Generate eval fixtures from live data

Types: decision, action, learning, gotcha, note, feature_request, fact
Categories: learning, error, feature_request, correction, knowledge_gap, best_practice,
           infrastructure, project_registry, personal, financial, contact, preference,
           goal, relationship, health, business, client, deadline, routine, context

  Provenance flags (V5):
  --sourceKind    Origin of the memory: user_explicit, agent_inference, tool_verified,
                  llm_distilled, markdown_import, regex_extraction, summary_derived,
                  knowledge_canonical
  --sourcePath    File or URL where the memory originated
  --confidence    Confidence score 0-1 (default 0.7)
  --verificationState  verified, hypothesis, changelog, or obsolete
  --expiresAt     ISO timestamp after which the memory is excluded from search/inject
  --sensitivity   normal (default), sensitive, or restricted

V5 Features:
  advisory --tool <name> --args <json> [--agent <agent>] [--project <project>] [--json]
      Get pre-action advisory from relevant memories, trajectories, and patterns.
  advisory-feedback --id <advisory_id> --followed <yes|no> [--outcome <text>] [--json]
      Record feedback on an advisory.
  eidos predict --agent <agent> --tool <tool> --prediction <text> [--project <project>] [--context <json>] [--json]
      Record what the agent expects to happen.
  eidos evaluate --id <prediction_id> --outcome <text> --accuracy <0-1> [--notes <text>] [--json]
      Compare prediction vs actual outcome.
  eidos distill --id <evaluation_id> [--json]
      Auto-generate a learning memory from an evaluated prediction.
  eidos stats [--agent <agent>] [--days <n>] [--json]
      Prediction accuracy stats.

Environment:
  DATABASE_URL, OPENAI_API_KEY
  BRAINX_INJECT_MAX_CHARS_PER_ITEM (default 2000)
  BRAINX_INJECT_MAX_LINES_PER_ITEM (default 80)
  BRAINX_INJECT_MAX_TOTAL_CHARS (default 12000)
  BRAINX_INJECT_MIN_SCORE (default 0.45)
  BRAINX_MAX_SENSITIVITY (default normal)
  BRAINX_SEARCH_MAX_SENSITIVITY (default BRAINX_MAX_SENSITIVITY or normal)
  BRAINX_SEARCH_TWO_STAGE (default true; set 0/false/off/legacy for old weighted scan)
  BRAINX_SEARCH_TWO_STAGE_CANDIDATES (optional explicit HNSW candidate pool)
  BRAINX_SEARCH_TWO_STAGE_MIN_CANDIDATES (default 40)
  BRAINX_SEARCH_TWO_STAGE_MULTIPLIER (default 2)
  BRAINX_SEARCH_TWO_STAGE_MAX_CANDIDATES (default 400)
  BRAINX_SEARCH_TWO_STAGE_SET_EF_SEARCH (default true)
  BRAINX_SEARCH_TWO_STAGE_EF_SEARCH (optional explicit pgvector hnsw.ef_search)
  BRAINX_INJECT_MAX_SENSITIVITY (default BRAINX_MAX_SENSITIVITY or normal)
  BRAINX_PII_SCRUB_ENABLED (default true)
  BRAINX_PII_SCRUB_REPLACEMENT (default [REDACTED])
  BRAINX_DEDUPE_SIM_THRESHOLD (default 0.92)
  BRAINX_WIKI_VAULT_DIR (default ~/brainx-vault)
  BRAINX_WIKI_MAX_MEMORIES (default 240)
  BRAINX_WIKI_MIN_MEMORY_IMPORTANCE (default 7)
  BRAINX_WIKI_DIGEST_MAX_ITEMS (default 6)
  BRAINX_WIKI_STALE_DAYS (default 45)
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

function parseDateArg(v, name) {
  if (v === undefined || v === null || v === '' || v === true) return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid ${name || 'date'}: ${v}`);
  return d;
}

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function normalizeAgentId(value) {
  return String(value || '').trim();
}

function buildRuntimeWindowWhere(args) {
  const days = parseIntArg(args.days, 7);
  const since = parseDateArg(getArg(args, 'since', 'from'), 'since');
  const until = parseDateArg(getArg(args, 'until', 'to'), 'until');
  const params = [];
  const clauses = [];

  if (since) {
    params.push(since.toISOString());
    clauses.push(`injected_at >= $${params.length}::timestamptz`);
  } else {
    params.push(days);
    clauses.push(`injected_at >= NOW() - make_interval(days => $${params.length})`);
  }
  if (until) {
    params.push(until.toISOString());
    clauses.push(`injected_at < $${params.length}::timestamptz`);
  }

  return {
    days,
    since: since ? since.toISOString() : null,
    until: until ? until.toISOString() : null,
    params,
    whereSql: clauses.join(' AND '),
  };
}

function defaultOpenClawConfigPath() {
  return process.env.OPENCLAW_CONFIG
    || process.env.BRAINX_OPENCLAW_CONFIG
    || '/home/clawd/.openclaw/openclaw.json';
}

function readOpenClawConfig(deps = {}, configPath = null) {
  if (deps.openclawConfig) return deps.openclawConfig;
  const resolvedPath = configPath || defaultOpenClawConfigPath();
  const raw = fs.readFileSync(resolvedPath, 'utf8');
  return JSON.parse(raw);
}

function getConfiguredAgents(openclawConfig) {
  const list = openclawConfig?.agents?.list;
  if (Array.isArray(list)) {
    return list
      .map((agent) => ({
        id: normalizeAgentId(agent.id || agent.name),
        name: normalizeAgentId(agent.name || agent.id),
        model: agent.model?.primary || agent.subagents?.model || null,
        runtime: agent.agentRuntime?.id || agent.runtime?.type || agent.runtime?.acp?.agent || null,
        workspace: agent.workspace || null,
      }))
      .filter((agent) => agent.id);
  }

  const agentsObj = openclawConfig?.agents;
  if (agentsObj && typeof agentsObj === 'object') {
    return Object.entries(agentsObj)
      .filter(([id]) => id !== 'defaults' && id !== 'list')
      .map(([id, agent]) => ({
        id: normalizeAgentId(agent?.id || id),
        name: normalizeAgentId(agent?.name || agent?.id || id),
        model: agent?.model?.primary || agent?.subagents?.model || null,
        runtime: agent?.agentRuntime?.id || agent?.runtime?.type || agent?.runtime?.acp?.agent || null,
        workspace: agent?.workspace || null,
      }))
      .filter((agent) => agent.id);
  }
  return [];
}

function getBrainxPluginConfig(openclawConfig) {
  const entry = openclawConfig?.plugins?.entries?.brainx || {};
  return {
    pluginEnabled: entry.enabled !== false,
    config: entry.config || {},
  };
}

function isMediaGenerationAgent(agentId) {
  return /^media-gen(?:$|-)/.test(normalizeAgentId(agentId));
}

function isAgentMatchedByList(agentId, list) {
  const id = normalizeAgentId(agentId);
  return asArray(list).map(normalizeAgentId).filter(Boolean).some((entry) => id === entry);
}

function isAgentPrefixMatchedByList(agentId, list) {
  const id = normalizeAgentId(agentId);
  return asArray(list).map(normalizeAgentId).filter(Boolean).some((entry) => id === entry || id.startsWith(`${entry}-`));
}

function isGloballyDisabledAgent(agentId, list) {
  const exact = isAgentMatchedByList(agentId, list);
  if (exact) return { disabled: true, matchedBy: 'exact' };
  const id = normalizeAgentId(agentId);
  const mediaGenPrefix = isMediaGenerationAgent(id) && asArray(list).map(normalizeAgentId).includes('media-gen');
  if (mediaGenPrefix) return { disabled: true, matchedBy: 'media-gen-prefix' };
  return { disabled: false, matchedBy: null };
}

function compactAgentFeatures(agentId, plugin) {
  const cfg = plugin.config || {};
  const exactJitDisabled = isAgentMatchedByList(agentId, cfg.jitRecallDisabledAgents);
  const exactRouterSkipped = isAgentMatchedByList(agentId, cfg.routerSkipAgents);
  return {
    wikiDigest: plugin.pluginEnabled && asBool(cfg.enabled, true) && asBool(cfg.wikiDigest, false),
    jitRecall: plugin.pluginEnabled && asBool(cfg.enabled, true) && asBool(cfg.jitRecall, false) && !exactJitDisabled,
    workingMemory: plugin.pluginEnabled && asBool(cfg.enabled, true) && asBool(cfg.workingMemory, false),
    toolAdvisories: plugin.pluginEnabled && asBool(cfg.enabled, true) && asBool(cfg.toolAdvisories, false),
    captureToolFailures: plugin.pluginEnabled && asBool(cfg.enabled, true) && asBool(cfg.captureToolFailures, false),
    projectGround: plugin.pluginEnabled && asBool(cfg.enabled, true) && cfg.projectGround !== false,
    router: plugin.pluginEnabled && asBool(cfg.enabled, true) && asBool(cfg.routerEnabled, false) && !exactRouterSkipped,
  };
}

function numericOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function classifyAgentMetric({ agent, stats, plugin, disabled, features, policy }) {
  const warnings = [];
  const reasons = [];
  if (!plugin.pluginEnabled || asBool(plugin.config?.enabled, true) === false) {
    return { status: 'plugin-disabled', reasons: ['brainx_plugin_disabled'], warnings };
  }
  if (disabled.disabled) {
    if (isMediaGenerationAgent(agent.id)) reasons.push('visual_generation_agent');
    else if (agent.id === 'coder') reasons.push('kimi_recovery_preflight_stability_workaround');
    else reasons.push('globalDisabledAgents');
    return { status: 'disabled-intentional', reasons, warnings };
  }
  if (!features.jitRecall) warnings.push('jitRecall_disabled_for_agent');
  if (!features.router) warnings.push('router_skipped_for_agent');
  if (!stats || Number(stats.injections || 0) === 0) {
    return { status: 'no-recent-activity', reasons: ['no_runtime_injections_in_window'], warnings };
  }
  const selected = Number(stats.mems_injected || 0);
  const scored = Number(stats.scored || 0);
  const soft = numericOrNull(stats.soft_signal_ratio_pct);
  const hard = numericOrNull(stats.hard_signal_ratio_pct);
  const latency = numericOrNull(stats.avg_latency_ms);
  if (scored >= 5 && selected > 0 && soft !== null && soft < 10) warnings.push('low_soft_signal');
  if (scored >= 5 && selected > 0 && hard !== null && hard < 1) warnings.push('low_hard_signal');
  if (latency !== null && latency > 2000) warnings.push('high_avg_latency');
  if (warnings.includes('low_soft_signal') || warnings.includes('high_avg_latency')) {
    const lowSignalManaged =
      Number(policy?.low_signal_suppressions || 0) > 0 ||
      Number(policy?.low_signal_explorations || 0) > 0;
    if (lowSignalManaged) {
      reasons.push('adaptive_policy_active');
      return { status: 'managed-low-signal', reasons, warnings };
    }
    return { status: 'low-signal', reasons, warnings };
  }
  return { status: 'healthy', reasons, warnings };
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

const INJECT_ALLOWED_TYPES = new Set(['fact', 'decision', 'gotcha']);
const INJECT_PRIMARY_SOURCE_KINDS = new Set(['knowledge_canonical', 'tool_verified', 'user_explicit']);
const INJECT_HISTORICAL_SOURCE_KINDS = new Set(['consolidated']);
const INJECT_TROUBLESHOOTING_RE = /\b(error|bug|issue|problem|falla|fallando|failed|failing|broken|timeout|denied|permission|auth|unauthorized|forbidden|not found|invalid|no funciona|no sirve|rompi[oó]|stack trace|exception)\b/i;
const INJECT_HISTORICAL_RE = /\b(history|historial|timeline|what changed|what did we decide|before|antes|decision|decisión|decisiones|que se decidi[oó]|qué se decidi[oó]|que cambi[oó]|qué cambi[oó]|que pas[oó]|qué pas[oó])\b/i;
const INJECT_STOP_WORDS = new Set([
  'a', 'about', 'actual', 'again', 'algo', 'alguna', 'alguno', 'algun', 'all', 'and', 'antes',
  'as', 'at', 'ayuda', 'because', 'brainx', 'bug', 'by', 'can', 'como', 'con', 'consulta', 'current',
  'de', 'del', 'does', 'donde', 'el', 'ella', 'ellos', 'en', 'error', 'es', 'esta', 'este', 'esto',
  'for', 'from', 'how', 'http', 'https', 'i', 'if', 'in', 'inject', 'is', 'it', 'la', 'las', 'latest',
  'lo', 'los', 'me', 'memory', 'mi', 'my', 'necesito', 'no', 'not', 'of', 'on', 'openclaw', 'or',
  'para', 'please', 'por', 'pregunta', 'problem', 'prompt', 'que', 'qué', 'related', 'relevant', 'se',
  'session', 'si', 'sí', 'sin', 'sobre', 'solved', 'the', 'this', 'to', 'un', 'una', 'use', 'user',
  'what', 'why', 'with', 'y', 'ya',
]);

function normalizeWhitespace(value) {
  return String(value ?? '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isRecentTimestamp(value, maxAgeDays) {
  const parsed = value ? Date.parse(String(value)) : NaN;
  if (!Number.isFinite(parsed)) return false;
  return Date.now() - parsed <= maxAgeDays * 24 * 60 * 60 * 1000;
}

function isTroubleshootingInjectQuery(query) {
  return INJECT_TROUBLESHOOTING_RE.test(normalizeWhitespace(query));
}

function isHistoricalInjectQuery(query) {
  return INJECT_HISTORICAL_RE.test(normalizeWhitespace(query));
}

function tokenizeInjectQuery(query) {
  return Array.from(
    new Set(
      (normalizeWhitespace(query).toLowerCase().match(/[\p{L}\p{N}_./:-]+/gu) || [])
        .filter((token) => token.length >= 3)
        .filter((token) => !INJECT_STOP_WORDS.has(token)),
    ),
  );
}

function buildInjectHaystack(row) {
  return [
    row?.content,
    row?.context,
    row?.category,
    row?.pattern_key,
    row?.source_path,
    Array.isArray(row?.tags) ? row.tags.join(' ') : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function rowMatchesInjectQuery(row, queryTerms, { troubleshootingQuery = false } = {}) {
  const similarity = Number(row?.similarity ?? 0);
  if (!queryTerms.length) return similarity >= (troubleshootingQuery ? 0.58 : 0.68);
  const haystack = buildInjectHaystack(row);
  let hits = 0;
  let strongHits = 0;

  for (const term of queryTerms) {
    if (!haystack.includes(term)) continue;
    hits += 1;
    if (term.length >= 6 || /[./:_-]/.test(term)) strongHits += 1;
  }

  if (hits === 0) return similarity >= 0.82;
  if (queryTerms.length >= 4) return hits >= 2 || strongHits >= 1;
  return hits >= 1;
}

function isCurrentIssueInjectRow(row) {
  const status = String(row?.status || '').toLowerCase();
  const category = String(row?.category || '').toLowerCase();
  const tags = Array.isArray(row?.tags) ? row.tags.map((tag) => String(tag).toLowerCase()) : [];
  const verification = String(row?.verification_state || '').toLowerCase();
  if (!['pending', 'in_progress'].includes(status)) return false;
  if (verification !== 'changelog' && !tags.some((tag) => tag.includes('tool-failure'))) return false;
  if (['error', 'correction', 'infrastructure'].includes(category)) return true;
  return tags.some((tag) => tag.includes('tool-failure') || tag.startsWith('tool:'));
}

function trustedInjectRow(
  row,
  { troubleshootingQuery = false, historicalQuery = false, agentId = null } = {},
) {
  const type = String(row?.type || '');
  if (!INJECT_ALLOWED_TYPES.has(type)) return false;

  const verification = String(row?.verification_state || 'hypothesis');
  const sourceKind = String(row?.source_kind || '');

  if (verification === 'verified') {
    if (INJECT_PRIMARY_SOURCE_KINDS.has(sourceKind)) return true;
    if (historicalQuery && INJECT_HISTORICAL_SOURCE_KINDS.has(sourceKind)) {
      return isRecentTimestamp(row?.last_seen || row?.resolved_at || row?.created_at, 30);
    }
    return false;
  }

  if (verification !== 'changelog') return false;
  if (!troubleshootingQuery && !historicalQuery) return false;
  if (!isRecentTimestamp(row?.last_seen || row?.resolved_at || row?.created_at, troubleshootingQuery ? 14 : 7)) {
    return false;
  }
  if (troubleshootingQuery && isCurrentIssueInjectRow(row)) return true;
  return Boolean(historicalQuery && agentId && row?.agent === agentId);
}

function rankInjectRow(row, agentId) {
  const verification = String(row?.verification_state || 'hypothesis');
  const sourceKind = String(row?.source_kind || '');
  const local = row?.agent && agentId && row.agent === agentId ? 1 : 0;
  const verificationWeight = verification === 'verified' ? 2 : verification === 'changelog' ? 1 : 0;
  const sourceWeight = INJECT_PRIMARY_SOURCE_KINDS.has(sourceKind) ? 3 : INJECT_HISTORICAL_SOURCE_KINDS.has(sourceKind) ? 2 : 0;
  return [
    local,
    verificationWeight,
    sourceWeight,
    Number(row?.score || 0),
    Number(row?.similarity || 0),
    Number(row?.importance || 0),
  ];
}

function dedupeInjectRows(rows) {
  const seen = new Set();
  const output = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = hashQuery(`${String(row?.type || '')}|${normalizeWhitespace(row?.content || '').toLowerCase()}`);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(row);
  }
  return output;
}

function filterInjectRows(query, rows, { agentId = null } = {}) {
  const troubleshootingQuery = isTroubleshootingInjectQuery(query);
  const historicalQuery = isHistoricalInjectQuery(query);
  const queryTerms = tokenizeInjectQuery(query);
  const filtered = rows.filter((row) =>
    trustedInjectRow(row, { troubleshootingQuery, historicalQuery, agentId })
      && rowMatchesInjectQuery(row, queryTerms, { troubleshootingQuery }),
  );
  return dedupeInjectRows(filtered).sort((a, b) => {
    const aRank = rankInjectRow(a, agentId);
    const bRank = rankInjectRow(b, agentId);
    for (let index = 0; index < aRank.length; index += 1) {
      if (aRank[index] === bRank[index]) continue;
      return bRank[index] - aRank[index];
    }
    return 0;
  });
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
  io.log(`BrainX health: ${ok ? 'OK' : 'FAIL'}`);
  io.log(`- pgvector: ${hasVector ? 'yes' : 'no'}`);
  io.log(`- brainx tables: ${nTables}`);
}

async function cmdAdd(args, deps = {}) {
  const type = args.type || 'note';
  const content = args.content || args._[0] || null;
  if (!content) throw new Error('--content is required (or pass as positional argument)');

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
    resolution_notes: getArg(args, 'resolutionNotes', 'resolution-notes') || null,
    // V5 provenance fields
    source_kind: getArg(args, 'sourceKind', 'source-kind') || null,
    source_path: getArg(args, 'sourcePath', 'source-path') || null,
    confidence_score: getArg(args, 'confidence') ? parseFloatArg(getArg(args, 'confidence'), 0.7) : undefined,
    verification_state: getArg(args, 'verificationState', 'verification-state') || null,
    expires_at: getArg(args, 'expiresAt', 'expires-at') || null,
    sensitivity: getArg(args, 'sensitivity') || null
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
    contextFilter: args.context || null,
    maxSensitivity: getArg(args, 'maxSensitivity', 'max-sensitivity')
      || process.env.BRAINX_SEARCH_MAX_SENSITIVITY
      || process.env.BRAINX_MAX_SENSITIVITY
      || 'normal'
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
  const minSimilarity = parseFloatArg(getArg(args, 'minSimilarity'), 0.28);
  const minScore = parseFloatArg(getArg(args, 'minScore', 'min-score'), parseFloat(process.env.BRAINX_INJECT_MIN_SCORE || '0.45'));
  const agentId = normalizeWhitespace(args.agent) || normalizeWhitespace(process.env.OPENCLAW_AGENT) || null;
  const searchLimit = Math.max(limit * 3, 12);

  const defaultTier = process.env.BRAINX_INJECT_DEFAULT_TIER || 'warm_or_hot';

  let tierFilter = args.tier || null;
  let rows;
  const ragApi = getRag(deps);
  const started = nowMs();

  if (tierFilter) {
    rows = await ragApi.search(query, {
      limit: searchLimit,
      minSimilarity,
      minImportance,
      tierFilter,
      contextFilter: args.context || null,
      maxSensitivity: getArg(args, 'maxSensitivity', 'max-sensitivity')
        || process.env.BRAINX_INJECT_MAX_SENSITIVITY
        || process.env.BRAINX_MAX_SENSITIVITY
        || 'normal'
    });
  } else if (defaultTier === 'warm_or_hot') {
    const hot = await ragApi.search(query, {
      limit: searchLimit,
      minSimilarity,
      minImportance,
      tierFilter: 'hot',
      contextFilter: args.context || null,
      maxSensitivity: getArg(args, 'maxSensitivity', 'max-sensitivity')
        || process.env.BRAINX_INJECT_MAX_SENSITIVITY
        || process.env.BRAINX_MAX_SENSITIVITY
        || 'normal'
    });
    const warm = await ragApi.search(query, {
      limit: searchLimit,
      minSimilarity,
      minImportance,
      tierFilter: 'warm',
      contextFilter: args.context || null,
      maxSensitivity: getArg(args, 'maxSensitivity', 'max-sensitivity')
        || process.env.BRAINX_INJECT_MAX_SENSITIVITY
        || process.env.BRAINX_MAX_SENSITIVITY
        || 'normal'
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
      limit: searchLimit,
      minSimilarity,
      minImportance,
      tierFilter: null,
      contextFilter: args.context || null,
      maxSensitivity: getArg(args, 'maxSensitivity', 'max-sensitivity')
        || process.env.BRAINX_INJECT_MAX_SENSITIVITY
        || process.env.BRAINX_MAX_SENSITIVITY
        || 'normal'
    });
  }

  rows = rows.filter(r => Number(r.score ?? -Infinity) >= minScore);
  rows = filterInjectRows(query, rows, { agentId }).slice(0, limit);

  const durationMs = nowMs() - started;
  const simStats = summarizeSimilarities(rows);
  // INJECT_SELFTEST_TAG_20260601: self-test/diagnostic injects (e.g. brainx doctor's
  // fixed sentinel probe) are logged under a distinct query_kind so recall-health's
  // self-calibrating thermometer never measures itself. Real runtime injects stay
  // 'inject'. Source is opt-in via --source/BRAINX_QUERY_SOURCE; absence = production.
  const querySource = getArg(args, 'source') || process.env.BRAINX_QUERY_SOURCE || null;
  const logKind = querySource === 'selftest' ? 'inject_selftest' : 'inject';
  await maybeLogQuery(ragApi, {
    queryHash: hashQuery(query),
    kind: logKind,
    durationMs,
    resultsCount: rows.length,
    // AGENT_ATTRIBUTION_20260601: agentId resolves from --agent or OPENCLAW_AGENT
    // (set by the inject hook), enabling per-agent recall-health attribution.
    agent: agentId,
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
  if (!id && !patternKey) throw new Error('--id or --patternKey is required\n  Usage: brainx resolve --id <memory_id> --status <resolved|promoted|wont_fix>\n         brainx resolve --patternKey <key> --status <status>');
  if (!status) throw new Error('--status is required (resolved|promoted|wont_fix)');

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
       AND COALESCE(p.last_status, 'pending') NOT IN ('resolved', 'wont_fix')
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

async function cmdRuntimeReport(args, deps = {}) {
  const json = args.json === true || args.json === 'true';
  const window = buildRuntimeWindowWhere(args);
  const opsFixCutoff = parseDateArg(getArg(args, 'opsFixCutoff', 'ops-fix-cutoff'), 'opsFixCutoff') || new Date('2026-05-02T22:36:00Z');
  const dbApi = getDb(deps);
  const io = getIo(deps);
  const whereSql = window.whereSql;
  const windowParams = window.params;
  const opsCutoffParam = windowParams.length + 1;

  const [overall, byAgent, bySurface, topMems, worstAgents, opsDenylistAudit, opsDenylistLatest] = await Promise.all([
    dbApi.query(
      `SELECT
         COUNT(*)::int AS injections,
         COALESCE(SUM(selected_count), 0)::int AS total_memories_injected,
         COALESCE(SUM(referenced_count), 0)::int AS total_hard_referenced,
         COALESCE(SUM(soft_referenced_count), 0)::int AS total_soft_referenced,
         COALESCE(SUM(signal_gate_dropped), 0)::int AS gate_dropped,
         COALESCE(SUM(near_dup_dropped), 0)::int AS dup_dropped,
         ROUND(AVG(latency_ms)::numeric, 1) AS avg_latency_ms,
         COUNT(*) FILTER (WHERE scored_at IS NOT NULL)::int AS scored,
         ROUND(COALESCE(SUM(referenced_count), 0)::numeric / NULLIF(SUM(selected_count), 0) * 100, 2) AS hard_signal_ratio_pct,
         ROUND(COALESCE(SUM(soft_referenced_count), 0)::numeric / NULLIF(SUM(selected_count), 0) * 100, 2) AS soft_signal_ratio_pct,
         ROUND(COALESCE(SUM(referenced_count), 0)::numeric / NULLIF(SUM(selected_count), 0) * 100, 2) AS signal_ratio_pct
       FROM brainx_runtime_injections
       WHERE ${whereSql}`,
      windowParams
    ),
    dbApi.query(
      `SELECT
         COALESCE(agent, '(unknown)') AS agent,
         COUNT(*)::int AS injections,
         COALESCE(SUM(selected_count), 0)::int AS mems_injected,
         COALESCE(SUM(referenced_count), 0)::int AS mems_hard_referenced,
         COALESCE(SUM(soft_referenced_count), 0)::int AS mems_soft_referenced,
         COALESCE(SUM(referenced_count), 0)::int AS mems_referenced,
         ROUND(AVG(latency_ms)::numeric, 1) AS avg_latency_ms,
         ROUND(COALESCE(SUM(referenced_count), 0)::numeric / NULLIF(SUM(selected_count), 0) * 100, 1) AS hard_signal_ratio_pct,
         ROUND(COALESCE(SUM(soft_referenced_count), 0)::numeric / NULLIF(SUM(selected_count), 0) * 100, 1) AS soft_signal_ratio_pct,
         ROUND(COALESCE(SUM(referenced_count), 0)::numeric / NULLIF(SUM(selected_count), 0) * 100, 1) AS signal_ratio_pct
       FROM brainx_runtime_injections
       WHERE ${whereSql}
       GROUP BY 1
       ORDER BY injections DESC
       LIMIT 30`,
      windowParams
    ),
    dbApi.query(
      `SELECT surface, COUNT(*)::int AS injections,
              ROUND(AVG(selected_count)::numeric, 2) AS avg_mems,
              COALESCE(SUM(selected_count), 0)::int AS selected,
              COALESCE(SUM(referenced_count), 0)::int AS hard_referenced,
              COALESCE(SUM(soft_referenced_count), 0)::int AS soft_referenced,
              ROUND(COALESCE(SUM(referenced_count), 0)::numeric / NULLIF(SUM(selected_count), 0) * 100, 1) AS hard_signal_ratio_pct,
              ROUND(COALESCE(SUM(soft_referenced_count), 0)::numeric / NULLIF(SUM(selected_count), 0) * 100, 1) AS soft_signal_ratio_pct,
              ROUND(AVG(latency_ms)::numeric, 1) AS avg_latency_ms
       FROM brainx_runtime_injections
       WHERE ${whereSql}
       GROUP BY surface
       ORDER BY injections DESC`,
      windowParams
    ),
    dbApi.query(
      `WITH exploded AS (
         SELECT unnest(memory_ids) AS mem_id, agent
         FROM brainx_runtime_injections
         WHERE ${whereSql}
       )
       SELECT e.mem_id, m.content, m.type, m.importance, m.agent AS owner_agent,
              COUNT(*)::int AS injections,
              COUNT(DISTINCT e.agent)::int AS unique_agents
       FROM exploded e
       LEFT JOIN brainx_memories m ON m.id = e.mem_id
       GROUP BY e.mem_id, m.content, m.type, m.importance, m.agent
       ORDER BY injections DESC
       LIMIT 10`,
      windowParams
    ),
    dbApi.query(
      `SELECT
         COALESCE(agent, '(unknown)') AS agent,
         COUNT(*)::int AS injections,
         COALESCE(SUM(selected_count), 0)::int AS selected,
         COALESCE(SUM(referenced_count), 0)::int AS hard_referenced,
         COALESCE(SUM(soft_referenced_count), 0)::int AS soft_referenced,
         ROUND(COALESCE(SUM(referenced_count), 0)::numeric / NULLIF(SUM(selected_count), 0) * 100, 1) AS hard_signal_ratio_pct,
         ROUND(COALESCE(SUM(soft_referenced_count), 0)::numeric / NULLIF(SUM(selected_count), 0) * 100, 1) AS soft_signal_ratio_pct,
         ROUND(COALESCE(SUM(referenced_count), 0)::numeric / NULLIF(SUM(selected_count), 0) * 100, 1) AS signal_ratio_pct
       FROM brainx_runtime_injections
       WHERE ${whereSql}
         AND scored_at IS NOT NULL
       GROUP BY 1
       HAVING COUNT(*) >= 5
       ORDER BY soft_signal_ratio_pct ASC NULLS LAST, hard_signal_ratio_pct ASC NULLS LAST
       LIMIT 10`,
      windowParams
    ),
    dbApi.query(
      `SELECT
         CASE WHEN injected_at < $${opsCutoffParam}::timestamptz THEN 'pre_fix' ELSE 'post_fix' END AS phase,
         COUNT(*)::int AS injections,
         COALESCE(SUM(selected_count), 0)::int AS selected,
         MIN(injected_at) AS first_injected_at,
         MAX(injected_at) AS last_injected_at
       FROM brainx_runtime_injections
       WHERE ${whereSql}
         AND surface = 'wiki_digest'
         AND COALESCE(agent,'') ~ '^(monitor|alert)($|-)'
       GROUP BY 1
       ORDER BY 1`,
      [...windowParams, opsFixCutoff.toISOString()]
    ),
    dbApi.query(
      `SELECT agent, surface, COUNT(*)::int AS injections, MAX(injected_at) AS last_injected_at
       FROM brainx_runtime_injections
       WHERE ${whereSql}
         AND COALESCE(agent,'') ~ '^(monitor|alert)($|-)'
       GROUP BY agent, surface
       ORDER BY last_injected_at DESC
       LIMIT 20`,
      windowParams
    )
  ]);

  const payload = {
    ok: true,
    window_days: window.days,
    window_since: window.since,
    window_until: window.until,
    ops_denylist_fix_cutoff_utc: opsFixCutoff.toISOString(),
    overall: overall.rows[0] || {},
    by_agent: byAgent.rows,
    by_surface: bySurface.rows,
    top_injected_memories: topMems.rows.map(r => ({
      mem_id: r.mem_id,
      type: r.type,
      importance: r.importance,
      owner_agent: r.owner_agent,
      injections: r.injections,
      unique_agents: r.unique_agents,
      preview: String(r.content || '').slice(0, 120)
    })),
    worst_signal_agents: worstAgents.rows,
    ops_denylist_audit: {
      note: "monitor/alert wiki_digest rows before the cutoff are historical pre-fix telemetry, not active leakage.",
      wiki_digest_pre_post: opsDenylistAudit.rows,
      latest_monitor_alert_runtime_rows: opsDenylistLatest.rows
    }
  };

  if (json) {
    io.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  const o = payload.overall;
  const windowLabel = payload.window_since
    ? `${payload.window_since}${payload.window_until ? ` → ${payload.window_until}` : ' → now'}`
    : `últimos ${payload.window_days}d${payload.window_until ? ` hasta ${payload.window_until}` : ''}`;
  io.log(`BrainX Runtime Report — ${windowLabel}`);
  io.log('─'.repeat(60));
  io.log(`Inyecciones totales: ${o.injections || 0}`);
  io.log(`Memorias seleccionadas: ${o.total_memories_injected || 0}`);
  io.log(`Referencias hard/soft: ${o.total_hard_referenced || 0}/${o.total_soft_referenced || 0}`);
  io.log(`Bloqueadas por signal gate: ${o.gate_dropped || 0}`);
  io.log(`Bloqueadas por anti-dup: ${o.dup_dropped || 0}`);
  io.log(`Latencia promedio: ${o.avg_latency_ms || 0}ms`);
  io.log(`Turnos evaluados (scored): ${o.scored || 0}`);
  io.log(`Signal global hard: ${o.hard_signal_ratio_pct != null ? o.hard_signal_ratio_pct + '%' : '—'}`);
  io.log(`Signal global soft: ${o.soft_signal_ratio_pct != null ? o.soft_signal_ratio_pct + '%' : '—'}`);
  io.log('');
  io.log('Por agente:');
  for (const r of payload.by_agent) {
    const hard = r.hard_signal_ratio_pct != null ? `${r.hard_signal_ratio_pct}%` : '—';
    const soft = r.soft_signal_ratio_pct != null ? `${r.soft_signal_ratio_pct}%` : '—';
    io.log(`  ${r.agent.padEnd(24)} inj=${String(r.injections).padStart(4)} mem=${String(r.mems_injected).padStart(4)} hard=${String(r.mems_hard_referenced || 0).padStart(4)} soft=${String(r.mems_soft_referenced || 0).padStart(4)} ratio=${hard}/${soft} lat=${r.avg_latency_ms}ms`);
  }
  io.log('');
  io.log('Por superficie:');
  for (const r of payload.by_surface) {
    const hard = r.hard_signal_ratio_pct != null ? `${r.hard_signal_ratio_pct}%` : '—';
    const soft = r.soft_signal_ratio_pct != null ? `${r.soft_signal_ratio_pct}%` : '—';
    io.log(`  ${r.surface.padEnd(16)} inj=${String(r.injections).padStart(4)} selected=${String(r.selected || 0).padStart(4)} hard=${String(r.hard_referenced || 0).padStart(4)} soft=${String(r.soft_referenced || 0).padStart(4)} ratio=${hard}/${soft} lat=${r.avg_latency_ms}ms`);
  }
  io.log('');
  io.log('Top 10 memorias más inyectadas:');
  for (const m of payload.top_injected_memories) {
    io.log(`  [#${m.mem_id}] imp=${m.importance} type=${m.type} inj=${m.injections} agents=${m.unique_agents}  ${m.preview}`);
  }
  if (payload.worst_signal_agents.length) {
    io.log('');
    io.log('Agentes con peor signal ratio soft (>=5 turnos scored):');
    for (const r of payload.worst_signal_agents) {
      const hard = r.hard_signal_ratio_pct != null ? `${r.hard_signal_ratio_pct}%` : '—';
      const soft = r.soft_signal_ratio_pct != null ? `${r.soft_signal_ratio_pct}%` : '—';
      io.log(`  ${r.agent.padEnd(24)} inj=${String(r.injections).padStart(4)} selected=${String(r.selected || 0).padStart(4)} hard=${hard} soft=${soft}`);
    }
  }
  io.log('');
  io.log(`Auditoría ops denylist monitor/alert (cutoff ${payload.ops_denylist_fix_cutoff_utc}):`);
  if (payload.ops_denylist_audit.wiki_digest_pre_post.length) {
    for (const r of payload.ops_denylist_audit.wiki_digest_pre_post) {
      io.log(`  ${r.phase}: wiki_digest inj=${r.injections} selected=${r.selected} first=${r.first_injected_at || '—'} last=${r.last_injected_at || '—'}`);
    }
  } else {
    io.log('  wiki_digest inj=0 en la ventana');
  }
  const postFix = payload.ops_denylist_audit.wiki_digest_pre_post.find(r => r.phase === 'post_fix');
  if (!postFix || Number(postFix.injections || 0) === 0) {
    io.log('  Estado: sin evidencia post-fix de wiki_digest en monitor/alert dentro de la ventana.');
  }
  return 0;
}

async function cmdAgentMetrics(args, deps = {}) {
  const json = args.json === true || args.json === 'true';
  const markdown = args.markdown === true || args.markdown === 'true' || args.md === true || args.md === 'true';
  const includeMediaGen = args.includeMediaGen === true || args['include-media-gen'] === true;
  const window = buildRuntimeWindowWhere(args);
  const dbApi = getDb(deps);
  const io = getIo(deps);
  const configPath = getArg(args, 'config', 'openclawConfig', 'openclaw-config');
  const openclawConfig = readOpenClawConfig(deps, configPath);
  const agents = getConfiguredAgents(openclawConfig);
  const plugin = getBrainxPluginConfig(openclawConfig);
  const cfg = plugin.config || {};
  const globalDisabledAgents = asArray(cfg.globalDisabledAgents).map(normalizeAgentId).filter(Boolean);

  const policyWhereSql = window.whereSql.replace(/\binjected_at\b/g, 'created_at');
  const [byAgentRes, bySurfaceRes, latestRes, policyRes] = await Promise.all([
    dbApi.query(
      `SELECT
         COALESCE(agent, '(unknown)') AS agent,
         COUNT(*)::int AS injections,
         COALESCE(SUM(selected_count), 0)::int AS mems_injected,
         COALESCE(SUM(referenced_count), 0)::int AS mems_hard_referenced,
         COALESCE(SUM(soft_referenced_count), 0)::int AS mems_soft_referenced,
         COALESCE(SUM(signal_gate_dropped), 0)::int AS gate_dropped,
         COALESCE(SUM(near_dup_dropped), 0)::int AS dup_dropped,
         ROUND(AVG(latency_ms)::numeric, 1) AS avg_latency_ms,
         COUNT(*) FILTER (WHERE scored_at IS NOT NULL)::int AS scored,
         ROUND(COALESCE(SUM(referenced_count), 0)::numeric / NULLIF(SUM(selected_count), 0) * 100, 1) AS hard_signal_ratio_pct,
         ROUND(COALESCE(SUM(soft_referenced_count), 0)::numeric / NULLIF(SUM(selected_count), 0) * 100, 1) AS soft_signal_ratio_pct
       FROM brainx_runtime_injections
       WHERE ${window.whereSql}
       GROUP BY 1`,
      window.params
    ),
    dbApi.query(
      `SELECT
         COALESCE(agent, '(unknown)') AS agent,
         surface,
         COUNT(*)::int AS injections,
         COALESCE(SUM(selected_count), 0)::int AS selected,
         COALESCE(SUM(referenced_count), 0)::int AS hard_referenced,
         COALESCE(SUM(soft_referenced_count), 0)::int AS soft_referenced,
         ROUND(AVG(latency_ms)::numeric, 1) AS avg_latency_ms
       FROM brainx_runtime_injections
       WHERE ${window.whereSql}
       GROUP BY 1, 2
       ORDER BY 1 ASC, injections DESC`,
      window.params
    ),
    dbApi.query(
      `SELECT DISTINCT ON (COALESCE(agent, '(unknown)'))
         COALESCE(agent, '(unknown)') AS agent,
         id,
         surface,
         selected_count,
         latency_ms,
         injected_at,
         scored_at
       FROM brainx_runtime_injections
       WHERE ${window.whereSql}
       ORDER BY COALESCE(agent, '(unknown)'), injected_at DESC`,
      window.params
    ),
    dbApi.query(
      `SELECT
         COALESCE(agent, '(unknown)') AS agent,
         COUNT(*)::int AS decisions,
         COUNT(*) FILTER (WHERE action = 'suppress')::int AS suppressions,
         COUNT(*) FILTER (WHERE action = 'explore')::int AS explorations,
         COUNT(*) FILTER (WHERE action = 'suppress' AND reason = 'low_recent_usefulness')::int AS low_signal_suppressions,
         COUNT(*) FILTER (WHERE action = 'explore' AND reason = 'low_signal_exploration_budget')::int AS low_signal_explorations,
         MAX(created_at) AS last_policy_seen,
         STRING_AGG(DISTINCT surface || ':' || action, ',') AS policy_surfaces
       FROM brainx_policy_decisions
       WHERE ${policyWhereSql}
       GROUP BY 1`,
      window.params
    ).catch(() => ({ rows: [], policyUnavailable: true })),
  ]);

  const statsByAgent = new Map(byAgentRes.rows.map((row) => [normalizeAgentId(row.agent), row]));
  const latestByAgent = new Map(latestRes.rows.map((row) => [normalizeAgentId(row.agent), row]));
  const policyByAgent = new Map((policyRes.rows || []).map((row) => [normalizeAgentId(row.agent), row]));
  const surfacesByAgent = new Map();
  for (const row of bySurfaceRes.rows) {
    const agentId = normalizeAgentId(row.agent);
    if (!surfacesByAgent.has(agentId)) surfacesByAgent.set(agentId, []);
    surfacesByAgent.get(agentId).push({
      surface: row.surface,
      injections: row.injections,
      selected: row.selected,
      hard_referenced: row.hard_referenced,
      soft_referenced: row.soft_referenced,
      avg_latency_ms: row.avg_latency_ms,
    });
  }

  const configuredAgentIds = new Set(agents.map((agent) => agent.id));
  const runtimeOnlyAgents = Array.from(statsByAgent.keys())
    .filter((agentId) => agentId && agentId !== '(unknown)' && !configuredAgentIds.has(agentId))
    .map((agentId) => ({ id: agentId, name: agentId, model: null, runtime: null, workspace: null, runtime_only: true }));

  const allAgents = [...agents, ...runtimeOnlyAgents]
    .filter((agent) => includeMediaGen || !isMediaGenerationAgent(agent.id));

  const rows = allAgents.map((agent) => {
    const stats = statsByAgent.get(agent.id) || null;
    const policy = policyByAgent.get(agent.id) || null;
    const disabled = isGloballyDisabledAgent(agent.id, globalDisabledAgents);
    const features = compactAgentFeatures(agent.id, plugin);
    const classified = classifyAgentMetric({ agent, stats, plugin, disabled, features, policy });
    const latest = latestByAgent.get(agent.id) || null;
    return {
      agent: agent.id,
      name: agent.name || agent.id,
      runtime: agent.runtime,
      model: agent.model,
      workspace: agent.workspace,
      runtime_only: agent.runtime_only === true,
      status: classified.status,
      reasons: classified.reasons,
      warnings: classified.warnings,
      brainx: {
        enabled: plugin.pluginEnabled && asBool(cfg.enabled, true) && !disabled.disabled,
        disabled_by: disabled.disabled ? `globalDisabledAgents:${disabled.matchedBy}` : null,
        features,
        policy: policy ? {
          decisions: Number(policy.decisions || 0),
          suppressions: Number(policy.suppressions || 0),
          explorations: Number(policy.explorations || 0),
          low_signal_suppressions: Number(policy.low_signal_suppressions || 0),
          low_signal_explorations: Number(policy.low_signal_explorations || 0),
          surfaces: String(policy.policy_surfaces || '').split(',').filter(Boolean),
          last_seen: policy.last_policy_seen || null,
        } : null,
      },
      metrics: {
        injections: Number(stats?.injections || 0),
        mems_injected: Number(stats?.mems_injected || 0),
        mems_hard_referenced: Number(stats?.mems_hard_referenced || 0),
        mems_soft_referenced: Number(stats?.mems_soft_referenced || 0),
        gate_dropped: Number(stats?.gate_dropped || 0),
        dup_dropped: Number(stats?.dup_dropped || 0),
        scored: Number(stats?.scored || 0),
        hard_signal_ratio_pct: numericOrNull(stats?.hard_signal_ratio_pct),
        soft_signal_ratio_pct: numericOrNull(stats?.soft_signal_ratio_pct),
        avg_latency_ms: numericOrNull(stats?.avg_latency_ms),
      },
      latest_injection: latest ? {
        id: latest.id,
        surface: latest.surface,
        selected_count: latest.selected_count,
        latency_ms: latest.latency_ms,
        injected_at: latest.injected_at,
        scored_at: latest.scored_at,
      } : null,
      surfaces: surfacesByAgent.get(agent.id) || [],
    };
  }).sort((a, b) => {
    const order = {
      'low-signal': 0,
      'managed-low-signal': 1,
      'no-recent-activity': 2,
      healthy: 3,
      'disabled-intentional': 4,
      'plugin-disabled': 5,
    };
    const ao = order[a.status] ?? 99;
    const bo = order[b.status] ?? 99;
    if (ao !== bo) return ao - bo;
    return a.agent.localeCompare(b.agent);
  });

  const summary = {
    total_agents: rows.length,
    enabled: rows.filter((row) => row.brainx.enabled).length,
    disabled_intentional: rows.filter((row) => row.status === 'disabled-intentional').length,
    healthy: rows.filter((row) => row.status === 'healthy').length,
    low_signal: rows.filter((row) => row.status === 'low-signal').length,
    managed_low_signal: rows.filter((row) => row.status === 'managed-low-signal').length,
    no_recent_activity: rows.filter((row) => row.status === 'no-recent-activity').length,
    runtime_only: rows.filter((row) => row.runtime_only).length,
    total_injections: rows.reduce((sum, row) => sum + row.metrics.injections, 0),
    total_mems_injected: rows.reduce((sum, row) => sum + row.metrics.mems_injected, 0),
  };

  const payload = {
    ok: true,
    generated_at: new Date().toISOString(),
    window_days: window.days,
    window_since: window.since,
    window_until: window.until,
    config_path: configPath || defaultOpenClawConfigPath(),
    excludes: includeMediaGen ? [] : ['media-gen*'],
    plugin: {
      enabled: plugin.pluginEnabled,
      config_enabled: asBool(cfg.enabled, true),
      globalDisabledAgents,
      jitRecallDisabledAgents: asArray(cfg.jitRecallDisabledAgents),
      routerSkipAgents: asArray(cfg.routerSkipAgents),
      features: {
        wikiDigest: asBool(cfg.wikiDigest, false),
        jitRecall: asBool(cfg.jitRecall, false),
        workingMemory: asBool(cfg.workingMemory, false),
        toolAdvisories: asBool(cfg.toolAdvisories, false),
        captureToolFailures: asBool(cfg.captureToolFailures, false),
        router: asBool(cfg.routerEnabled, false),
        policyController: asBool(cfg.policyController, true),
      },
    },
    summary,
    agents: rows,
  };

  if (json) {
    io.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  const titleWindow = payload.window_since
    ? `${payload.window_since}${payload.window_until ? ` → ${payload.window_until}` : ' → now'}`
    : `${payload.window_days}d`;
  io.log(`BrainX Agent Metrics — ${titleWindow}`);
  io.log(`agents=${summary.total_agents} enabled=${summary.enabled} healthy=${summary.healthy} managed_low_signal=${summary.managed_low_signal} low_signal=${summary.low_signal} no_recent=${summary.no_recent_activity} disabled=${summary.disabled_intentional} injections=${summary.total_injections}`);
  io.log('');

  const statusGroups = ['low-signal', 'managed-low-signal', 'no-recent-activity', 'healthy', 'disabled-intentional', 'plugin-disabled'];
  for (const status of statusGroups) {
    const group = rows.filter((row) => row.status === status);
    if (!group.length) continue;
    io.log(markdown ? `### ${status}` : `${status}:`);
    for (const row of group) {
      const soft = row.metrics.soft_signal_ratio_pct == null ? '—' : `${row.metrics.soft_signal_ratio_pct}%`;
      const hard = row.metrics.hard_signal_ratio_pct == null ? '—' : `${row.metrics.hard_signal_ratio_pct}%`;
      const surfaces = row.surfaces.map((s) => s.surface).join(', ') || '—';
      const reason = row.reasons.length ? ` reason=${row.reasons.join(',')}` : '';
      const warnings = row.warnings.length ? ` warnings=${row.warnings.join(',')}` : '';
      const policy = row.brainx.policy
        ? ` policy=suppress:${row.brainx.policy.low_signal_suppressions}/explore:${row.brainx.policy.low_signal_explorations}`
        : '';
      io.log(`- ${row.agent}: inj=${row.metrics.injections} mem=${row.metrics.mems_injected} hard=${hard} soft=${soft} lat=${row.metrics.avg_latency_ms ?? '—'}ms surfaces=${surfaces}${reason}${warnings}${policy}`);
    }
    io.log('');
  }
  return 0;
}

function parseJsonMaybe(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch (_) {
    return fallback;
  }
}

function summarizeRouterDecision(decisionSummary) {
  const summary = parseJsonMaybe(decisionSummary, {});
  const router = summary && typeof summary === 'object' ? summary.router : null;
  if (!router || typeof router !== 'object') return null;
  return {
    mode: router.mode ?? null,
    applied: router.applied ?? null,
    model: router.model ?? null,
    proposed_ids: router.proposed_ids || router.proposedIds || [],
    reason: router.reason ?? null,
    error: router.error ?? null,
    fail_closed: router.fail_closed ?? router.failClosed ?? null,
    strict_guard_dropped: router.strict_guard_dropped ?? router.strictGuardDropped ?? null,
  };
}

function countRouterProposals(router) {
  if (!router || typeof router !== 'object') return 0;
  if (Array.isArray(router.proposed_ids)) return router.proposed_ids.length;
  if (Array.isArray(router.proposedIds)) return router.proposedIds.length;
  return 0;
}

function classifyRouterQuality(row) {
  const router = summarizeRouterDecision(row.decision_summary) || {};
  const selected = Number(row.selected_count || 0);
  const hard = Number(row.referenced_count || 0);
  const soft = Number(row.soft_referenced_count || 0);
  const signalGateDropped = Number(row.signal_gate_dropped || 0);
  const strictGuardDropped = Number(router.strict_guard_dropped || 0);
  const latency = numericOrNull(row.latency_ms);
  const routerLatency = numericOrNull(parseJsonMaybe(row.decision_summary, {})?.router?.latency_ms);
  const proposed = countRouterProposals(router);
  const scored = row.scored_at !== null && row.scored_at !== undefined;
  const warnings = [];

  if (latency !== null && latency >= 3000) warnings.push('slow_total_latency');
  if (routerLatency !== null && routerLatency >= 2500) warnings.push('slow_router_latency');
  if (strictGuardDropped > 0) warnings.push('strict_guard_dropped');
  if (signalGateDropped > 0) warnings.push('signal_gate_dropped');

  if (router.error || router.fail_closed) {
    return { quality: 'router-error', warnings };
  }
  if (selected === 0 && (proposed > 0 || strictGuardDropped > 0 || signalGateDropped > 0)) {
    return { quality: 'safe-empty', warnings };
  }
  if (selected > 0 && (hard > 0 || soft > 0)) {
    return { quality: 'good', warnings };
  }
  if (selected > 0 && scored && hard === 0 && soft === 0) {
    return { quality: 'weak', warnings };
  }
  if (selected > 0 && !scored) {
    return { quality: 'pending-score', warnings };
  }
  return { quality: 'no-selection', warnings };
}

async function cmdRouterQuality(args, deps = {}) {
  const json = args.json === true || args.json === 'true';
  const window = buildRuntimeWindowWhere(args);
  const dbApi = getDb(deps);
  const io = getIo(deps);
  const limit = parseIntArg(args.limit, 100);
  const agent = getArg(args, 'agent');
  const surface = getArg(args, 'surface');

  const clauses = [window.whereSql, `decision_summary->'router' IS NOT NULL`];
  const params = [...window.params];
  if (agent !== undefined) {
    params.push(agent);
    clauses.push(`agent = $${params.length}`);
  }
  if (surface !== undefined) {
    params.push(surface);
    clauses.push(`surface = $${params.length}`);
  }
  const where = clauses.join(' AND ');
  const limitParam = params.length + 1;

  const [overallRes, byAgentRes, bySurfaceRes, recentRes] = await Promise.all([
    dbApi.query(
      `SELECT
         COUNT(*)::int AS router_events,
         COUNT(*) FILTER (WHERE decision_summary->'router'->>'applied' = 'true')::int AS applied,
         COUNT(*) FILTER (WHERE decision_summary->'router'->>'error' IS NOT NULL AND decision_summary->'router'->>'error' <> '')::int AS errors,
         COUNT(*) FILTER (WHERE decision_summary->'router'->>'fail_closed' = 'true')::int AS fail_closed,
         COALESCE(SUM(selected_count), 0)::int AS selected,
         COALESCE(SUM(referenced_count), 0)::int AS hard_referenced,
         COALESCE(SUM(soft_referenced_count), 0)::int AS soft_referenced,
         COALESCE(SUM(signal_gate_dropped), 0)::int AS signal_gate_dropped,
         COALESCE(SUM(near_dup_dropped), 0)::int AS near_dup_dropped,
         COALESCE(SUM(COALESCE((decision_summary->'router'->>'strict_guard_dropped')::int, 0)), 0)::int AS strict_guard_dropped,
         COALESCE(SUM(jsonb_array_length(COALESCE(decision_summary->'router'->'proposed_ids', '[]'::jsonb))), 0)::int AS proposed_ids,
         COALESCE(SUM(COALESCE((decision_summary->'router'->>'selected_overlap')::int, 0)), 0)::int AS selected_overlap,
         ROUND(AVG(latency_ms)::numeric, 1) AS avg_total_latency_ms,
         ROUND(AVG(NULLIF(decision_summary#>>'{router,latency_ms}', '')::numeric), 1) AS avg_router_latency_ms,
         ROUND(COALESCE(SUM(referenced_count), 0)::numeric / NULLIF(SUM(selected_count), 0) * 100, 1) AS hard_signal_ratio_pct,
         ROUND(COALESCE(SUM(soft_referenced_count), 0)::numeric / NULLIF(SUM(selected_count), 0) * 100, 1) AS soft_signal_ratio_pct
       FROM brainx_runtime_injections
       WHERE ${where}`,
      params
    ),
    dbApi.query(
      `SELECT
         COALESCE(agent, '(unknown)') AS agent,
         COUNT(*)::int AS router_events,
         COALESCE(SUM(selected_count), 0)::int AS selected,
         COALESCE(SUM(referenced_count), 0)::int AS hard_referenced,
         COALESCE(SUM(soft_referenced_count), 0)::int AS soft_referenced,
         COALESCE(SUM(signal_gate_dropped), 0)::int AS signal_gate_dropped,
         COALESCE(SUM(COALESCE((decision_summary->'router'->>'strict_guard_dropped')::int, 0)), 0)::int AS strict_guard_dropped,
         COALESCE(SUM(jsonb_array_length(COALESCE(decision_summary->'router'->'proposed_ids', '[]'::jsonb))), 0)::int AS proposed_ids,
         ROUND(AVG(latency_ms)::numeric, 1) AS avg_total_latency_ms,
         ROUND(AVG(NULLIF(decision_summary#>>'{router,latency_ms}', '')::numeric), 1) AS avg_router_latency_ms,
         ROUND(COALESCE(SUM(soft_referenced_count), 0)::numeric / NULLIF(SUM(selected_count), 0) * 100, 1) AS soft_signal_ratio_pct
       FROM brainx_runtime_injections
       WHERE ${where}
       GROUP BY 1
       ORDER BY router_events DESC, agent ASC
       LIMIT 30`,
      params
    ),
    dbApi.query(
      `SELECT
         surface,
         COUNT(*)::int AS router_events,
         COALESCE(SUM(selected_count), 0)::int AS selected,
         COALESCE(SUM(referenced_count), 0)::int AS hard_referenced,
         COALESCE(SUM(soft_referenced_count), 0)::int AS soft_referenced,
         COALESCE(SUM(signal_gate_dropped), 0)::int AS signal_gate_dropped,
         COALESCE(SUM(COALESCE((decision_summary->'router'->>'strict_guard_dropped')::int, 0)), 0)::int AS strict_guard_dropped,
         COALESCE(SUM(jsonb_array_length(COALESCE(decision_summary->'router'->'proposed_ids', '[]'::jsonb))), 0)::int AS proposed_ids,
         ROUND(AVG(latency_ms)::numeric, 1) AS avg_total_latency_ms,
         ROUND(AVG(NULLIF(decision_summary#>>'{router,latency_ms}', '')::numeric), 1) AS avg_router_latency_ms,
         ROUND(COALESCE(SUM(soft_referenced_count), 0)::numeric / NULLIF(SUM(selected_count), 0) * 100, 1) AS soft_signal_ratio_pct
       FROM brainx_runtime_injections
       WHERE ${where}
       GROUP BY 1
       ORDER BY router_events DESC, surface ASC`,
      params
    ),
    dbApi.query(
      `SELECT id, agent, session_key, surface, selected_count, referenced_count,
              soft_referenced_count, signal_gate_dropped, near_dup_dropped,
              latency_ms, injected_at, scored_at, prompt_sha, prompt_preview,
              decision_summary, top_candidates, memory_ids
       FROM brainx_runtime_injections
       WHERE ${where}
       ORDER BY injected_at DESC
       LIMIT $${limitParam}`,
      [...params, limit]
    ),
  ]);

  const recent = recentRes.rows.map((row) => {
    const router = summarizeRouterDecision(row.decision_summary);
    const decision = parseJsonMaybe(row.decision_summary, {});
    const topCandidates = parseJsonMaybe(row.top_candidates, null);
    const classified = classifyRouterQuality(row);
    const proposedCount = countRouterProposals(router);
    const selectedOverlap = numericOrNull(decision?.router?.selected_overlap);
    return {
      id: row.id,
      agent: row.agent,
      session_key: row.session_key,
      surface: row.surface,
      injected_at: row.injected_at,
      scored_at: row.scored_at,
      quality: classified.quality,
      warnings: classified.warnings,
      selected_count: Number(row.selected_count || 0),
      hard_referenced: Number(row.referenced_count || 0),
      soft_referenced: Number(row.soft_referenced_count || 0),
      signal_gate_dropped: Number(row.signal_gate_dropped || 0),
      near_dup_dropped: Number(row.near_dup_dropped || 0),
      latency_ms: numericOrNull(row.latency_ms),
      router: router ? {
        mode: router.mode,
        applied: router.applied,
        model: router.model,
        proposed_count: proposedCount,
        latency_ms: numericOrNull(decision?.router?.latency_ms),
        selected_overlap: selectedOverlap,
        strict_guard_dropped: numericOrNull(router.strict_guard_dropped) || 0,
        fail_closed: router.fail_closed,
        error: router.error,
        reason: router.reason,
      } : null,
      prompt: {
        sha: row.prompt_sha,
        preview: row.prompt_preview,
      },
      selected_memory_ids: Array.isArray(row.memory_ids) ? row.memory_ids : [],
      top_candidate_ids: Array.isArray(topCandidates)
        ? topCandidates.slice(0, 5).map((candidate) => ({
          id: candidate.id,
          reason: candidate.reason,
          finalScore: candidate.finalScore,
          source_kind: candidate.source_kind,
          source_path: candidate.source_path,
        }))
        : [],
    };
  });

  const qualityCounts = recent.reduce((acc, row) => {
    acc[row.quality] = (acc[row.quality] || 0) + 1;
    return acc;
  }, {});

  const payload = {
    ok: true,
    generated_at: new Date().toISOString(),
    window_days: window.days,
    window_since: window.since,
    window_until: window.until,
    filters: {
      agent: agent ?? null,
      surface: surface ?? null,
      limit,
    },
    overall: overallRes.rows[0] || {},
    by_agent: byAgentRes.rows,
    by_surface: bySurfaceRes.rows,
    quality_counts_from_recent_sample: qualityCounts,
    recent,
  };

  if (json) {
    io.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  const windowLabel = payload.window_since
    ? `${payload.window_since}${payload.window_until ? ` → ${payload.window_until}` : ' → now'}`
    : `${payload.window_days}d`;
  const o = payload.overall;
  io.log(`BrainX Router Quality — ${windowLabel}`);
  io.log(`router_events=${o.router_events || 0} applied=${o.applied || 0} errors=${o.errors || 0} fail_closed=${o.fail_closed || 0}`);
  io.log(`selected=${o.selected || 0} hard=${o.hard_referenced || 0} soft=${o.soft_referenced || 0} hard_signal=${o.hard_signal_ratio_pct ?? '—'}% soft_signal=${o.soft_signal_ratio_pct ?? '—'}%`);
  io.log(`proposed=${o.proposed_ids || 0} selected_overlap=${o.selected_overlap || 0} strict_guard_dropped=${o.strict_guard_dropped || 0} signal_gate_dropped=${o.signal_gate_dropped || 0}`);
  io.log(`latency total/router avg=${o.avg_total_latency_ms ?? '—'}ms/${o.avg_router_latency_ms ?? '—'}ms`);
  io.log('');
  io.log('Por superficie:');
  for (const row of payload.by_surface) {
    io.log(`- ${row.surface}: events=${row.router_events} selected=${row.selected} soft=${row.soft_referenced} soft_signal=${row.soft_signal_ratio_pct ?? '—'}% router_lat=${row.avg_router_latency_ms ?? '—'}ms`);
  }
  io.log('');
  io.log('Por agente:');
  for (const row of payload.by_agent.slice(0, 12)) {
    io.log(`- ${row.agent}: events=${row.router_events} selected=${row.selected} soft=${row.soft_referenced} soft_signal=${row.soft_signal_ratio_pct ?? '—'}% router_lat=${row.avg_router_latency_ms ?? '—'}ms`);
  }
  io.log('');
  io.log('Calidad muestra reciente:');
  for (const [key, value] of Object.entries(qualityCounts)) {
    io.log(`- ${key}: ${value}`);
  }
  io.log('');
  io.log('Últimas decisiones:');
  for (const row of recent.slice(0, 10)) {
    const warnings = row.warnings.length ? ` warnings=${row.warnings.join(',')}` : '';
    io.log(`- #${row.id} ${row.agent || '?'} ${row.surface} ${row.quality} selected=${row.selected_count} soft=${row.soft_referenced} router_proposed=${row.router?.proposed_count ?? 0} overlap=${row.router?.selected_overlap ?? '—'} router_lat=${row.router?.latency_ms ?? '—'}ms total_lat=${row.latency_ms ?? '—'}ms${warnings}`);
  }
  return 0;
}

async function cmdRecallHealth(args, deps = {}) {
  const json = args.json === true || args.json === 'true';
  const dbApi = getDb(deps);
  const io = getIo(deps);
  const { collectRecallHealth, formatRecallHealth } = require('./recall-health');
  const payload = await collectRecallHealth(dbApi, args);

  if (json) {
    io.log(JSON.stringify(payload, null, 2));
  } else {
    io.log(formatRecallHealth(payload));
  }
  return payload.status === 'fail' ? 1 : 0;
}

async function cmdExplain(args, deps = {}) {
  const json = args.json === true || args.json === 'true';
  const id = getArg(args, 'id');
  const sessionId = getArg(args, 'session', 'sessionId', 'session-id');
  const sessionKey = getArg(args, 'sessionKey', 'session-key');
  const agent = getArg(args, 'agent');
  const limit = parseIntArg(args.limit, id ? 1 : 5);
  const dbApi = getDb(deps);
  const io = getIo(deps);

  const clauses = [];
  const params = [];
  if (id !== undefined) {
    params.push(id);
    clauses.push(`id = $${params.length}`);
  }
  if (sessionId !== undefined) {
    params.push(sessionId);
    clauses.push(`session_id = $${params.length}`);
  }
  if (sessionKey !== undefined) {
    params.push(sessionKey);
    clauses.push(`session_key = $${params.length}`);
  }
  if (agent !== undefined) {
    params.push(agent);
    clauses.push(`agent = $${params.length}`);
  }
  if (clauses.length === 0) {
    throw new Error('explain requires --id, --session, --sessionKey, or --agent');
  }
  params.push(limit);

  const rowsRes = await dbApi.query(
    `SELECT id, agent, session_id, session_key, surface, memory_ids, similarities,
            importances, raw_count, filtered_count, selected_count,
            near_dup_dropped, signal_gate_dropped, prompt_sha, prompt_preview,
            response_sha, referenced_count, referenced_ids,
            soft_referenced_count, soft_referenced_ids, latency_ms, injected_at,
            scored_at, decision_summary, top_candidates
       FROM brainx_runtime_injections
       WHERE ${clauses.join(' AND ')}
       ORDER BY injected_at DESC
       LIMIT $${params.length}`,
    params
  );

  const memoryIds = Array.from(new Set(
    rowsRes.rows.flatMap((row) => Array.isArray(row.memory_ids) ? row.memory_ids : [])
      .filter((memId) => typeof memId === 'string' && memId.length > 0)
  ));
  let memoryById = new Map();
  if (memoryIds.length > 0) {
    const memRes = await dbApi.query(
      `SELECT id, type, tier, importance, agent, source_kind, verification_state,
              source_path, sensitivity, content
       FROM brainx_memories
       WHERE id = ANY($1::text[])`,
      [memoryIds]
    );
    memoryById = new Map(memRes.rows.map((row) => [row.id, row]));
  }

  const explanations = rowsRes.rows.map((row) => {
    const ids = Array.isArray(row.memory_ids) ? row.memory_ids : [];
    const referenced = new Set(Array.isArray(row.referenced_ids) ? row.referenced_ids : []);
    const softReferenced = new Set(Array.isArray(row.soft_referenced_ids) ? row.soft_referenced_ids : []);
    return {
      id: row.id,
      agent: row.agent,
      session_id: row.session_id,
      session_key: row.session_key,
      surface: row.surface,
      injected_at: row.injected_at,
      scored_at: row.scored_at,
      latency_ms: row.latency_ms,
      counts: {
        raw: row.raw_count,
        filtered: row.filtered_count,
        selected: row.selected_count,
        signal_gate_dropped: row.signal_gate_dropped,
        near_dup_dropped: row.near_dup_dropped,
        hard_referenced: row.referenced_count,
        soft_referenced: row.soft_referenced_count,
      },
      prompt: {
        sha: row.prompt_sha,
        preview: row.prompt_preview,
      },
      response_sha: row.response_sha,
      router: summarizeRouterDecision(row.decision_summary),
      decision_summary: parseJsonMaybe(row.decision_summary, row.decision_summary || null),
      top_candidates: parseJsonMaybe(row.top_candidates, row.top_candidates || null),
      memories: ids.map((memId, index) => {
        const mem = memoryById.get(memId) || {};
        return {
          id: memId,
          similarity: Array.isArray(row.similarities) ? row.similarities[index] : null,
          importance: Array.isArray(row.importances) ? row.importances[index] : mem.importance ?? null,
          hard_referenced: referenced.has(memId),
          soft_referenced: softReferenced.has(memId),
          type: mem.type ?? null,
          tier: mem.tier ?? null,
          owner_agent: mem.agent ?? null,
          source_kind: mem.source_kind ?? null,
          verification_state: mem.verification_state ?? null,
          source_path: mem.source_path ?? null,
          sensitivity: mem.sensitivity ?? null,
          preview: String(mem.content || '').slice(0, 180),
        };
      }),
    };
  });

  const payload = {
    ok: true,
    count: explanations.length,
    filters: { id: id ?? null, session_id: sessionId ?? null, session_key: sessionKey ?? null, agent: agent ?? null, limit },
    results: explanations,
  };

  if (json) {
    io.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  io.log(`BrainX Explain — ${explanations.length} runtime injection(s)`);
  for (const item of explanations) {
    const hard = item.counts.selected ? ((Number(item.counts.hard_referenced || 0) / Number(item.counts.selected)) * 100).toFixed(1) : '—';
    const soft = item.counts.selected ? ((Number(item.counts.soft_referenced || 0) / Number(item.counts.selected)) * 100).toFixed(1) : '—';
    io.log(`- #${item.id} ${item.surface} agent=${item.agent || '?'} selected=${item.counts.selected} hard=${hard}% soft=${soft}% latency=${item.latency_ms ?? '—'}ms`);
    if (item.router) {
      io.log(`  router: mode=${item.router.mode || '—'} applied=${item.router.applied ?? '—'} model=${item.router.model || '—'} proposed=${Array.isArray(item.router.proposed_ids) ? item.router.proposed_ids.length : 0} dropped=${item.router.strict_guard_dropped ?? 0} fail_closed=${item.router.fail_closed ?? false}`);
      if (item.router.reason) io.log(`  reason: ${item.router.reason}`);
      if (item.router.error) io.log(`  error: ${item.router.error}`);
    }
    if (item.prompt.preview) io.log(`  prompt: ${item.prompt.preview}`);
    for (const mem of item.memories.slice(0, 5)) {
      io.log(`  mem ${mem.id}: hard=${mem.hard_referenced} soft=${mem.soft_referenced} sim=${mem.similarity ?? '—'} ${mem.type || '?'} ${mem.tier || '?'} ${mem.preview}`);
    }
  }
  return 0;
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
    query_performance: queryPerf.rows,
    live_capture: summarizeLiveCapture({ days })
  };

  const io = getIo(deps);
  io.log(JSON.stringify(payload, null, 2));
}

// BRAINX_COST_TRACKING_20260608
async function cmdCostReport(args, deps = {}) {
  const days = parseIntArg(args.days, 7);
  const agentFilter = args.agent || null;
  const opFilter = args.operation || null;
  const modelFilter = args.model || null;
  const jsonOutput = !!args.json;
  const groupBy = args['group-by'] || args.groupBy || null;
  const dbApi = getDb(deps);
  const io = getIo(deps);

  // Check if the table exists; if not, return a helpful message.
  const tableCheck = await dbApi.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'brainx_cost_events' LIMIT 1`
  );
  if (tableCheck.rows.length === 0) {
    const msg = 'brainx_cost_events table not found — run: brainx migrate (migration 017_brainx_cost_events.sql)';
    if (jsonOutput) { io.log(JSON.stringify({ ok: false, error: msg })); }
    else { io.log(msg); }
    return 0;
  }

  const baseWhere = `
    occurred_at >= NOW() - ($1 || ' days')::interval
    AND ($2::text IS NULL OR agent_id = $2)
    AND ($3::text IS NULL OR operation_type = $3)
    AND ($4::text IS NULL OR model = $4)
  `;
  const baseParams = [String(days), agentFilter, opFilter, modelFilter];

  const [totalRow, byAgent, byOperation] = await Promise.all([
    dbApi.query(
      `SELECT
         COUNT(*)::int AS calls,
         COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
         COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
         COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
         ROUND(COALESCE(SUM(cost_usd), 0), 6) AS cost_usd
       FROM brainx_cost_events WHERE ${baseWhere}`,
      baseParams
    ),
    dbApi.query(
      `SELECT
         COALESCE(agent_id, '(system)') AS agent,
         COUNT(*)::int AS calls,
         COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
         ROUND(COALESCE(SUM(cost_usd), 0), 6) AS cost_usd
       FROM brainx_cost_events WHERE ${baseWhere}
       GROUP BY COALESCE(agent_id, '(system)')
       ORDER BY cost_usd DESC`,
      baseParams
    ),
    dbApi.query(
      `SELECT
         operation_type,
         COUNT(*)::int AS calls,
         COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
         ROUND(COALESCE(SUM(cost_usd), 0), 6) AS cost_usd
       FROM brainx_cost_events WHERE ${baseWhere}
       GROUP BY operation_type
       ORDER BY cost_usd DESC`,
      baseParams
    ),
  ]);

  const total = totalRow.rows[0] || { calls: 0, total_tokens: 0, cost_usd: '0' };

  if (jsonOutput) {
    io.log(JSON.stringify({
      ok: true,
      window_days: days,
      filters: { agent: agentFilter, operation: opFilter, model: modelFilter },
      total,
      by_agent: byAgent.rows,
      by_operation: byOperation.rows,
    }, null, 2));
    return 0;
  }

  const now = new Date();
  const since = new Date(now - days * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const pct = (n, t) => t > 0 ? `${Math.round(parseFloat(n) / parseFloat(t) * 100)}%` : '0%';

  io.log(`Periodo: ${fmt(since)} → ${fmt(now)} (${days}d)`);
  io.log(`Total: $${total.cost_usd}  |  ${Number(total.total_tokens).toLocaleString()} tokens  |  ${total.calls} calls`);

  if (byAgent.rows.length > 0) {
    io.log('\nPor agent_id:');
    for (const r of byAgent.rows) {
      io.log(`  ${r.agent.padEnd(20)} $${String(r.cost_usd).padStart(10)}  (${pct(r.cost_usd, total.cost_usd)})  ${String(Number(r.total_tokens).toLocaleString()).padStart(12)} tok  ${r.calls} calls`);
    }
  }

  if (byOperation.rows.length > 0) {
    io.log('\nPor operation_type:');
    for (const r of byOperation.rows) {
      io.log(`  ${r.operation_type.padEnd(22)} $${String(r.cost_usd).padStart(10)}  ${String(Number(r.total_tokens).toLocaleString()).padStart(12)} tok  ${r.calls} calls`);
    }
  }

  return 0;
}

async function cmdFeedback(args, deps = {}) {
  const id = args.id;
  if (!id) throw new Error('--id is required');
  const supersededBy = getArg(args, 'supersededBy', 'superseded-by') || null;

  const isUseful = !!args.useful;
  const isUseless = !!args.useless;
  const isIncorrect = !!args.incorrect;
  const isDoubtful = !!args.doubtful;
  const actions = [isUseful, isUseless, isIncorrect, isDoubtful].filter(Boolean).length;
  if (actions !== 1) {
    throw new Error('exactly one of --useful, --useless, --doubtful, or --incorrect is required');
  }

  const dbApi = getDb(deps);
  const io = getIo(deps);
  const jsonOutput = !!args.json;

  const check = await dbApi.query(
    'SELECT id, importance, access_count, feedback_score, superseded_by, verification_state FROM brainx_memories WHERE id = $1',
    [id]
  );
  if (check.rows.length === 0) {
    throw new Error(`Memory ${id} not found`);
  }

  const mem = check.rows[0];
  if (mem.superseded_by) {
    throw new Error(`Memory ${id} is already superseded`);
  }
  if (isIncorrect && supersededBy) {
    if (supersededBy === id) {
      throw new Error('--supersededBy must point to a different memory id');
    }
    const replacement = await dbApi.query(
      'SELECT id FROM brainx_memories WHERE id = $1',
      [supersededBy]
    );
    if (replacement.rows.length === 0) {
      throw new Error(`Replacement memory ${supersededBy} not found`);
    }
  }

  let result;
  let action;

  if (isUseful) {
    action = 'useful';
    result = await dbApi.query(
      `UPDATE brainx_memories
       SET access_count = COALESCE(access_count, 0) + 1,
           importance = LEAST(COALESCE(importance, 5) + 1, 10),
           feedback_score = COALESCE(feedback_score, 0) + 1,
           verification_state = CASE
             WHEN COALESCE(verification_state, 'hypothesis') = 'hypothesis'
                  AND COALESCE(confidence_score, 0.7) >= 0.85
                  AND type IN ('fact', 'decision', 'gotcha')
               THEN 'verified'
             ELSE verification_state
           END,
           last_accessed = NOW()
       WHERE id = $1
       RETURNING id, importance, access_count, feedback_score, verification_state`,
      [id]
    );
  } else if (isUseless) {
    action = 'useless';
    result = await dbApi.query(
       `UPDATE brainx_memories
        SET importance = GREATEST(COALESCE(importance, 5) - 1, 1),
           feedback_score = COALESCE(feedback_score, 0) - 1,
           verification_state = CASE
             WHEN COALESCE(verification_state, 'hypothesis') = 'verified' THEN 'hypothesis'
             ELSE verification_state
           END
       WHERE id = $1
       RETURNING id, importance, access_count, feedback_score, verification_state`,
      [id]
    );
  } else if (isDoubtful) {
    action = 'doubtful';
    result = await dbApi.query(
      `UPDATE brainx_memories
       SET importance = GREATEST(COALESCE(importance, 5) - 2, 1),
           feedback_score = COALESCE(feedback_score, 0) - 3,
           verification_state = 'hypothesis',
           resolution_notes = CONCAT(COALESCE(resolution_notes || E'\n', ''), 'Marked doubtful via feedback at ', NOW()::text)
       WHERE id = $1
       RETURNING id, importance, feedback_score, verification_state`,
      [id]
    );
  } else {
    action = 'incorrect';
    result = await dbApi.query(
      `UPDATE brainx_memories
       SET superseded_by = COALESCE($2, superseded_by),
           feedback_score = COALESCE(feedback_score, 0) - 5,
           verification_state = 'obsolete',
           resolution_notes = CONCAT(COALESCE(resolution_notes || E'\n', ''), 'Marked incorrect via feedback at ', NOW()::text,
             CASE WHEN $2::text IS NULL THEN '' ELSE CONCAT(' superseded_by=', $2::text) END)
       WHERE id = $1
       RETURNING id, superseded_by, feedback_score, verification_state`,
      [id, supersededBy]
    );
  }

  const payload = { ok: true, action, memory: result.rows[0] };
  if (jsonOutput) {
    io.log(JSON.stringify(payload, null, 2));
  } else {
    io.log(`Feedback recorded: ${action} -> ${id}`);
  }
}

// BRAINX_SKILL_LOAD_TRACKING_20260608: closes Spec 2 gap #3 by letting the
// host agent (or operator) report whether a loaded skill was helpful, wrong,
// or ignored. We pick the most recent unrated load for the skill (in the
// current session or a session passed via --session) and stamp its outcome.
// The plugin (bridge.ts) is the primary writer of brainx_skill_loads; this
// CLI is the explicit-feedback channel.
async function cmdSkillFeedback(args, deps = {}) {
  const positional = Array.isArray(args._) ? args._ : [];
  const skillName = positional[0] || args.skill || args.name || null;
  const outcome = positional[1] || args.outcome || null;

  if (!skillName) {
    throw new Error('usage: brainx skill-feedback <skill-name> <helpful|wrong|ignored> [--session <key>]');
  }
  const allowed = ['helpful', 'wrong', 'ignored'];
  if (!allowed.includes(outcome)) {
    throw new Error(`outcome must be one of: ${allowed.join(', ')}`);
  }
  const sessionKey = args.session || args['session-key'] || args.sessionKey || null;

  const dbApi = getDb(deps);
  const io = getIo(deps);
  const jsonOutput = !!args.json;
  const skillTracker = require('./skill-tracker');

  // 1) Make sure the table exists so we can return a friendly error if the
  //    operator forgot to run the migration.
  const tableCheck = await dbApi.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'brainx_skill_loads' LIMIT 1`,
  );
  if (tableCheck.rows.length === 0) {
    const msg = 'brainx_skill_loads table not found — run: brainx migrate (migration 018_brainx_skill_loads.sql)';
    if (jsonOutput) { io.log(JSON.stringify({ ok: false, error: msg })); }
    else { io.log(msg); }
    return 1;
  }

  let loadRow;
  if (sessionKey) {
    // Explicit session: pick the most recent unrated load for that skill.
    const res = await dbApi.query(
      `SELECT id, session_key, skill_name, loaded_at, outcome
       FROM brainx_skill_loads
       WHERE skill_name = $1 AND session_key = $2 AND outcome IS NULL
       ORDER BY loaded_at DESC
       LIMIT 1`,
      [skillName, sessionKey],
    );
    loadRow = res.rows[0] || null;
    if (!loadRow) {
      // Fall back to any recent load in that session, even if already rated,
      // so the operator can override the latest record.
      const fallback = await dbApi.query(
        `SELECT id, session_key, skill_name, loaded_at, outcome
         FROM brainx_skill_loads
         WHERE skill_name = $1 AND session_key = $2
         ORDER BY loaded_at DESC
         LIMIT 1`,
        [skillName, sessionKey],
      );
      loadRow = fallback.rows[0] || null;
    }
  } else {
    // No session: pick the most recent unrated load for the skill globally.
    const res = await dbApi.query(
      `SELECT id, session_key, skill_name, loaded_at, outcome
       FROM brainx_skill_loads
       WHERE skill_name = $1 AND outcome IS NULL
       ORDER BY loaded_at DESC
       LIMIT 1`,
      [skillName],
    );
    loadRow = res.rows[0] || null;
    if (!loadRow) {
      const fallback = await dbApi.query(
        `SELECT id, session_key, skill_name, loaded_at, outcome
         FROM brainx_skill_loads
         WHERE skill_name = $1
         ORDER BY loaded_at DESC
         LIMIT 1`,
        [skillName],
      );
      loadRow = fallback.rows[0] || null;
    }
  }

  if (!loadRow) {
    const msg = `No brainx_skill_loads row found for skill='${skillName}'${sessionKey ? ` session='${sessionKey}'` : ''}. The bridge must record a load first.`;
    if (jsonOutput) { io.log(JSON.stringify({ ok: false, error: msg })); }
    else { io.log(msg); }
    return 1;
  }

  const updated = await skillTracker.recordOutcome(loadRow.id, outcome);
  const payload = {
    ok: true,
    action: outcome,
    load: updated || { ...loadRow, outcome },
  };
  if (jsonOutput) {
    io.log(JSON.stringify(payload, null, 2));
  } else {
    io.log(`Skill feedback recorded: ${outcome} -> ${skillName} (load ${loadRow.id}, session ${loadRow.session_key})`);
  }
  return 0;
}

async function cmdSkillStats(args, deps = {}) {
  const skillName = (Array.isArray(args._) ? args._ : [])[0] || args.skill || args.name || null;
  if (!skillName) {
    throw new Error('usage: brainx skill-stats <skill-name> [--json]');
  }
  const dbApi = getDb(deps);
  const io = getIo(deps);
  const jsonOutput = !!args.json;

  const tableCheck = await dbApi.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'brainx_skill_loads' LIMIT 1`,
  );
  if (tableCheck.rows.length === 0) {
    const msg = 'brainx_skill_loads table not found — run migration 018_brainx_skill_loads.sql first.';
    if (jsonOutput) { io.log(JSON.stringify({ ok: false, error: msg })); }
    else { io.log(msg); }
    return 1;
  }

  const skillTracker = require('./skill-tracker');
  const stats = await skillTracker.getSkillStats(skillName);
  if (jsonOutput) {
    io.log(JSON.stringify({ ok: true, ...stats }, null, 2));
    return 0;
  }
  io.log(`Skill: ${stats.skill_name}`);
  io.log(`  total loads : ${stats.total_loads}`);
  io.log(`  reported    : ${stats.reported}`);
  io.log(`  helpful     : ${stats.helpful}`);
  io.log(`  wrong       : ${stats.wrong}`);
  io.log(`  ignored     : ${stats.ignored}`);
  return 0;
}

async function cmdFact(args, deps = {}) {
  // Shortcut: brainx fact "..." → add --type fact --tier hot --category infrastructure
  const content = args.content || args._[0] || null;
  if (!content) throw new Error('--content is required (or pass as positional argument)');
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
      AND COALESCE(status, 'pending') NOT IN ('resolved', 'wont_fix')
      AND (expires_at IS NULL OR expires_at > NOW())
      AND COALESCE(verification_state, 'hypothesis') != 'obsolete'
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

async function cmdFeature(args, deps = {}) {
  // Shortcut: brainx feature "..." → add --type feature_request --tier warm --category feature_request
  const content = args.content || args._[0] || null;
  if (!content) throw new Error('--content is required (or pass as positional argument)');
  return cmdAdd({
    ...args,
    type: 'feature_request',
    tier: args.tier || 'warm',
    importance: args.importance || '6',
    category: args.category || 'feature_request',
    status: args.status || 'pending',
  }, deps);
}

async function cmdFeatures(args, deps = {}) {
  const dbApi = getDb(deps);
  const limit = parseIntArg(args.limit, 30);
  const contextFilter = args.context || null;
  const statusFilter = args.status || null;

  let sql = `
    SELECT id, content, tier, importance, context, category, tags, status, created_at, last_seen
    FROM brainx_memories
    WHERE type = 'feature_request'
      AND superseded_by IS NULL
      AND COALESCE(status, 'pending') NOT IN ('wont_fix')
      AND (expires_at IS NULL OR expires_at > NOW())
      AND COALESCE(verification_state, 'hypothesis') != 'obsolete'
  `;
  const params = [];
  let i = 1;

  if (contextFilter) {
    sql += ` AND context = $${i}`;
    params.push(contextFilter);
    i++;
  }
  if (statusFilter) {
    sql += ` AND status = $${i}`;
    params.push(statusFilter);
    i++;
  }

  sql += ` ORDER BY importance DESC, created_at DESC LIMIT $${i}`;
  params.push(limit);

  const res = await dbApi.query(sql, params);
  const io = getIo(deps);
  io.log(JSON.stringify({ ok: true, count: res.rows.length, features: res.rows }, null, 2));
}

async function cmdLifecycleRun(args, deps = {}) {
  const dbApi = getDb(deps);
  const promoteMinRecurrence = parseIntArg(getArg(args, 'promoteMinRecurrence', 'promote-min-recurrence'), parseInt(process.env.BRAINX_LIFECYCLE_PROMOTE_MIN_RECURRENCE || '3', 10));
  const promoteDays = parseIntArg(getArg(args, 'promoteDays', 'promote-days'), parseInt(process.env.BRAINX_LIFECYCLE_PROMOTE_DAYS || '30', 10));
  const degradeDays = parseIntArg(getArg(args, 'degradeDays', 'degrade-days'), parseInt(process.env.BRAINX_LIFECYCLE_DEGRADE_DAYS || '45', 10));
  const lowImportanceMax = parseIntArg(getArg(args, 'lowImportanceMax', 'low-importance-max'), parseInt(process.env.BRAINX_LIFECYCLE_LOW_IMPORTANCE_MAX || '3', 10));
  const lowAccessMax = parseIntArg(getArg(args, 'lowAccessMax', 'low-access-max'), parseInt(process.env.BRAINX_LIFECYCLE_LOW_ACCESS_MAX || '1', 10));
  // Hysteresis: promote at importance >= promoteImportanceMin, demote below demoteImportanceMax
  // The gap prevents oscillation (a memory won't bounce between promoted/demoted states)
  const promoteImportanceMin = parseIntArg(getArg(args, 'promoteImportanceMin', 'promote-importance-min'), parseInt(process.env.BRAINX_LIFECYCLE_PROMOTE_IMPORTANCE_MIN || '7', 10));
  const demoteImportanceMax = parseIntArg(getArg(args, 'demoteImportanceMax', 'demote-importance-max'), parseInt(process.env.BRAINX_LIFECYCLE_DEMOTE_IMPORTANCE_MAX || '4', 10));
  const dryRun = !!getArg(args, 'dryRun', 'dry-run');

  const promotedPreview = await dbApi.query(
    `SELECT id, pattern_key, status, recurrence_count, last_seen, access_count, importance
     FROM brainx_memories
     WHERE COALESCE(status, 'pending') IN ('pending', 'in_progress')
       AND recurrence_count >= $1
       AND last_seen >= NOW() - make_interval(days => $2)
       AND importance >= $3`,
    [promoteMinRecurrence, promoteDays, promoteImportanceMin]
  );

  const degradedPreview = await dbApi.query(
    `SELECT id, pattern_key, status, recurrence_count, last_seen, access_count, importance
     FROM brainx_memories
     WHERE COALESCE(status, 'pending') IN ('pending', 'in_progress')
       AND last_seen < NOW() - make_interval(days => $1)
       AND importance <= $2`,
    [degradeDays, demoteImportanceMax]
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
           AND importance >= $3
       )
       RETURNING id, pattern_key, status, recurrence_count, last_seen, access_count, importance`,
      [promoteMinRecurrence, promoteDays, promoteImportanceMin]
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
           AND importance <= $4
       )
       RETURNING id, pattern_key, status, recurrence_count, last_seen, access_count, importance`,
      [degradeDays, lowImportanceMax, lowAccessMax, demoteImportanceMax]
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
    thresholds: { promoteMinRecurrence, promoteDays, degradeDays, lowImportanceMax, lowAccessMax, promoteImportanceMin, demoteImportanceMax },
    candidates: { promote: promotedPreview.rows || [], degrade: degradedPreview.rows || [] },
    updated: dryRun ? { promoted: 0, degraded: 0 } : { promoted: promoted.rowCount || 0, degraded: degraded.rowCount || 0 },
    results: dryRun ? null : { promoted: promoted.rows || [], degraded: degraded.rows || [] }
  }, null, 2));
}

// ── V5: Advisory System ─────────────────────────────
async function cmdAdvisory(args, deps = {}) {
  const tool = args.tool;
  if (!tool) throw new Error('--tool is required\n  Usage: brainx advisory --tool <tool_name> [--agent <agent>] [--project <project>] [--json]');
  const argsJson = args.args || '{}';
  const agent = args.agent || process.env.OPENCLAW_AGENT || 'unknown';
  const project = args.project || null;
  const jsonOutput = !!args.json;

  const { getAdvisory } = require('./advisory');
  const result = await getAdvisory({ tool, args: argsJson, agent, project });

  const io = getIo(deps);
  if (jsonOutput) {
    io.log(JSON.stringify(result, null, 2));
  } else if (result.on_cooldown) {
    io.log('Advisory on cooldown for this agent+tool combination.');
  } else if (!result.advisory_text) {
    io.log('No relevant advisories found.');
  } else {
    io.log(`🔮 Advisory (confidence: ${result.confidence.toFixed(2)}, id: ${result.id}):\n\n${result.advisory_text}`);
  }
}

async function cmdAdvisoryFeedback(args, deps = {}) {
  const id = args.id;
  if (!id) throw new Error('--id is required');
  const followed = args.followed;
  if (!followed) throw new Error('--followed is required (yes|no)');
  const wasFollowed = followed === 'yes' || followed === 'true';
  const outcome = args.outcome || null;
  const jsonOutput = !!args.json;

  const { advisoryFeedback } = require('./advisory');
  const result = await advisoryFeedback(id, wasFollowed, outcome);

  const io = getIo(deps);
  if (jsonOutput) {
    io.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } else {
    io.log(`Advisory ${id} updated: followed=${wasFollowed}, outcome=${outcome || 'N/A'}`);
  }
}

// ── V5: EIDOS Loop ──────────────────────────────────
async function cmdEidos(args, deps = {}) {
  const subCmd = args._[0];
  if (!subCmd) throw new Error('eidos subcommand required: predict|evaluate|distill|stats\n  Usage:\n    brainx eidos predict --prediction "..." [--tool <t>] [--project <p>]\n    brainx eidos evaluate --id <id> --outcome "..." --accuracy <0-1>\n    brainx eidos distill --id <id>\n    brainx eidos stats [--agent <a>] [--json]');

  const eidos = require('./eidos');
  const io = getIo(deps);
  const jsonOutput = !!args.json;

  if (subCmd === 'predict') {
    const agent = args.agent || process.env.OPENCLAW_AGENT || 'unknown';
    const tool = args.tool || null;
    const prediction = args.prediction;
    if (!prediction) throw new Error('--prediction is required');
    const project = args.project || null;
    const context = args.context || null;

    const result = await eidos.predict({ agent, tool, project, prediction, context });
    if (jsonOutput) {
      io.log(JSON.stringify({ ok: true, ...result }, null, 2));
    } else {
      io.log(`✅ Prediction recorded: ${result.id}`);
    }
  } else if (subCmd === 'evaluate') {
    const id = args.id;
    if (!id) throw new Error('--id is required');
    const outcome = args.outcome;
    if (!outcome) throw new Error('--outcome is required');
    const accuracy = args.accuracy;
    if (accuracy === undefined) throw new Error('--accuracy is required (0-1)');
    const notes = args.notes || null;

    const result = await eidos.evaluate({ id, actualOutcome: outcome, accuracy, notes });
    if (jsonOutput) {
      io.log(JSON.stringify({ ok: true, ...result }, null, 2));
    } else {
      io.log(`✅ Evaluation recorded: ${id} → accuracy: ${accuracy}`);
    }
  } else if (subCmd === 'distill') {
    const id = args.id;
    if (!id) throw new Error('--id is required');

    const result = await eidos.distillLearning({ id });
    if (jsonOutput) {
      io.log(JSON.stringify({ ok: true, ...result }, null, 2));
    } else {
      io.log(`✅ Distilled learning from ${id} → memory: ${result.learning_memory_id}`);
    }
  } else if (subCmd === 'stats') {
    const agent = args.agent || null;
    const days = args.days || 30;

    const result = await eidos.stats({ agent, days });
    if (jsonOutput) {
      io.log(JSON.stringify({ ok: true, ...result }, null, 2));
    } else {
      io.log(`📊 EIDOS Stats (${result.window_days}d, agent: ${result.agent}):`);
      const c = result.counts;
      io.log(`  Total: ${c.total} | Pending: ${c.pending} | Evaluated: ${c.evaluated} | Distilled: ${c.distilled}`);
      if (result.accuracy) {
        io.log(`  Accuracy: avg=${result.accuracy.overall_accuracy ?? 'N/A'} min=${result.accuracy.min_accuracy ?? 'N/A'} max=${result.accuracy.max_accuracy ?? 'N/A'}`);
      }
      if (result.by_tool.length > 0) {
        io.log(`  By tool:`);
        for (const t of result.by_tool) {
          io.log(`    ${t.tool || 'unknown'}: ${t.total} predictions, avg_accuracy=${t.avg_accuracy ?? 'N/A'}`);
        }
      }
    }
  } else {
    throw new Error(`Unknown eidos subcommand: ${subCmd}. Use: predict|evaluate|distill|stats`);
  }
}

async function cmdWiki(args, deps = {}) {
  const wiki = require("./wiki");
  const io = getIo(deps);
  const jsonOutput = !!args.json;
  const subCmd = args._[0] || "status";
  const options = {
    vaultDir: getArg(args, "vault", "vaultDir", "vault-dir"),
    knowledgeRoot: getArg(args, "knowledgeRoot", "knowledge-root"),
    maxMemories: getArg(args, "maxMemories", "max-memories"),
    minMemoryImportance: getArg(args, "minMemoryImportance", "min-memory-importance"),
    digestMaxItems: getArg(args, "digestMaxItems", "digest-max-items"),
    staleDays: getArg(args, "staleDays", "stale-days"),
  };

  if (subCmd === "status") {
    const status = await wiki.getWikiStatus(options);
    if (jsonOutput) io.log(JSON.stringify(status, null, 2));
    else {
      io.log(`BrainX Wiki: ${status.compiled ? "compiled" : "not compiled"}`);
      io.log(`- vault: ${status.vaultDir}`);
      io.log(`- generatedAt: ${status.generatedAt || "n/a"}`);
      if (status.counts) io.log(`- counts: ${JSON.stringify(status.counts)}`);
      io.log(`- obsidian: enabled=${status.obsidian.enabled} cli=${status.obsidian.cliAvailable} xdg-open=${status.obsidian.xdgOpenAvailable}`);
    }
    return;
  }

  if (subCmd === "init") {
    await wiki.ensureWikiVault(wiki.resolveWikiConfig(options));
    const status = await wiki.getWikiStatus(options);
    if (jsonOutput) io.log(JSON.stringify({ ok: true, ...status }, null, 2));
    else {
      io.log(`BrainX Wiki initialized: ${status.vaultDir}`);
      io.log(`- obsidian: enabled=${status.obsidian.enabled} cli=${status.obsidian.cliAvailable} xdg-open=${status.obsidian.xdgOpenAvailable}`);
    }
    return;
  }

  if (subCmd === "compile") {
    const result = await wiki.compileWiki({
      ...options,
      dryRun: !!args["dry-run"] || !!args.dryRun,
    });
    if (jsonOutput) io.log(JSON.stringify(result, null, 2));
    else {
      io.log(`BrainX Wiki compiled: ${result.vaultDir}`);
      io.log(`- generatedAt: ${result.generatedAt}`);
      io.log(`- counts: ${JSON.stringify(result.counts)}`);
    }
    return;
  }

  if (subCmd === "lint") {
    const result = await wiki.lintWiki(options);
    if (jsonOutput) io.log(JSON.stringify(result, null, 2));
    else {
      io.log(`BrainX Wiki lint: ${result.ok ? "ok" : "issues"}`);
      for (const issue of result.issues) {
        io.log(`- ${issue.level}: ${issue.code} | ${issue.message}`);
      }
    }
    return;
  }

  if (subCmd === "digest") {
    const result = await wiki.readAgentDigest(args.agent || null, options);
    if (jsonOutput) io.log(JSON.stringify(result, null, 2));
    else {
      if (!result.ok) {
        io.log(`BrainX Wiki digest unavailable: ${result.reason}`);
        return;
      }
      io.stdout.write(String(result.digest?.promptBlock || ""));
    }
    return;
  }

  if (subCmd === "obsidian") {
    const action = args._[1] || "status";
    if (action === "status") {
      const status = await wiki.getWikiStatus(options);
      if (jsonOutput) io.log(JSON.stringify(status.obsidian, null, 2));
      else io.log(`Obsidian: enabled=${status.obsidian.enabled} cli=${status.obsidian.cliAvailable} xdg-open=${status.obsidian.xdgOpenAvailable} vault=${status.vaultDir}`);
      return;
    }
    if (action === "open") {
      const result = await wiki.openObsidian(options);
      if (jsonOutput) io.log(JSON.stringify(result, null, 2));
      else io.log(`Obsidian open: ${result.ok ? "launched" : "not launched"} (${result.method}) vault=${result.vaultDir}`);
      return;
    }
    throw new Error(`Unknown wiki obsidian subcommand: ${action}. Use: status|open`);
  }

  throw new Error(`Unknown wiki subcommand: ${subCmd}. Use: status|init|compile|lint|digest|obsidian`);
}

async function main(argvIn = process.argv.slice(2), deps = {}) {
  const argv = argvIn;
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!cmd || cmd === '--help' || cmd === '-h') {
    usage();
    return 0;
  }
  if (args.help || args.h) {
    usage();
    return 0;
  }

  if (cmd === 'doctor') {
    const { cmdDoctor } = require('./doctor');
    return cmdDoctor(args, deps);
  }
  if (cmd === 'fix' || cmd === '--fix') {
    const { cmdFix } = require('./fix');
    return cmdFix(args, deps);
  }
  if (cmd === 'health') return cmdHealth(args, deps);
  if (cmd === 'add') return cmdAdd(args, deps);
  if (cmd === 'fact') return cmdFact(args, deps);
  if (cmd === 'facts') return cmdFacts(args, deps);
  if (cmd === 'feature') return cmdFeature(args, deps);
  if (cmd === 'features') return cmdFeatures(args, deps);
  if (cmd === 'search') return cmdSearch(args, deps);
  if (cmd === 'inject') return cmdInject(args, deps);
  if (cmd === 'feedback') return cmdFeedback(args, deps);
  if (cmd === 'skill-feedback') return cmdSkillFeedback(args, deps);
  if (cmd === 'skill-stats') return cmdSkillStats(args, deps);
  if (cmd === 'resolve') return cmdResolve(args, deps);
  if (cmd === 'promote-candidates') return cmdPromoteCandidates(args, deps);
  if (cmd === 'lifecycle-run') return cmdLifecycleRun(args, deps);
  if (cmd === 'metrics') return cmdMetrics(args, deps);
  if (cmd === 'runtime-report') return cmdRuntimeReport(args, deps);
  if (cmd === 'agent-metrics') return cmdAgentMetrics(args, deps);
  if (cmd === 'router-quality') return cmdRouterQuality(args, deps);
  if (cmd === 'recall-health') return cmdRecallHealth(args, deps);
  if (cmd === 'explain') return cmdExplain(args, deps);
  if (cmd === 'wiki') return cmdWiki(args, deps);
  if (cmd === 'cost-report') return cmdCostReport(args, deps);

  // V5: Advisory System
  if (cmd === 'advisory') return cmdAdvisory(args, deps);
  if (cmd === 'advisory-feedback') return cmdAdvisoryFeedback(args, deps);

  // V5: EIDOS Loop
  if (cmd === 'eidos') return cmdEidos(args, deps);

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
  cmdFeedback,
  cmdSkillFeedback,
  cmdSkillStats,
  cmdResolve,
  cmdPromoteCandidates,
  cmdLifecycleRun,
  cmdMetrics,
  cmdRuntimeReport,
  cmdAgentMetrics,
  cmdRouterQuality,
  cmdRecallHealth,
  cmdExplain,
  cmdWiki,
  cmdAdvisory,
  cmdAdvisoryFeedback,
  cmdEidos,
  cmdCostReport,
  main
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
