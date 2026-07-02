#!/usr/bin/env node
'use strict';
// BRAINX_TURN_HARVESTER_20260609
// BRAINX_TURN_HARVESTER_LOAD_GUARD_20260611
// BRAINX_TURN_HARVESTER_CONVERSATION_SCOPE_20260619
// Per-turn session capture: reads new JSONL turns since last checkpoint,
// extracts memory-worthy insights via LLM, routes to three destinations:
//   1. brainx_memories DB   — facts, decisions, gotchas (long-term recall)
//   2. memory/YYYY-MM-DD.md — daily narrative (workspace operational log)
//   3. WORKING_STATE.md     — active task state (conditional, anti-hallucination)
//
// Architecture:
//   - No daemon thread; runs as a cron step inside brainx-review-loop-cron.sh
//   - Checkpoint per session: processes only new turns, never re-reads
//   - LLM routed through brainx-reviewer (ChatGPT OAuth, no metered cost)
//   - Writes are fire-and-forget for memory/WORKING_STATE; DB writes are awaited

require('dotenv').config({
  path: require('path').join(__dirname, '..', '.env'),
  quiet: true,
});

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../lib/db');
const { embed } = require('../lib/embedding-client');
const { callAgentLLM } = require('../lib/agent-llm');
const { isOpsAgent } = require('../lib/ops-agents');
const { normalizeTranscriptRecord, findAcpSessions } = require('../lib/session-sources');
const { storeMemory } = require('../lib/openai-rag');

// BRAINX_TURN_HARVEST_GATE_20260613: when set, route inserts through the shared
// quality gate + semantic dedup (lib/openai-rag.storeMemory) instead of a raw
// INSERT, so low-signal / near-duplicate extractions are skipped/downgraded/merged
// at the source. Default off = legacy raw INSERT (behavior preserved).
const TURN_HARVEST_GATE = /^(1|true|on|yes)$/i.test(process.env.BRAINX_TURN_HARVEST_GATE || '');

// ── Config ────────────────────────────────────────────────────────────────────

const HOME = process.env.HOME || '/home/clawd';
const OPENCLAW_DIR = path.join(HOME, '.openclaw');
const AGENTS_DIR = path.join(OPENCLAW_DIR, 'agents');
const DATA_DIR = path.join(__dirname, '..', 'data');

const DEFAULT_HOURS = parseInt(process.env.TURN_HARVESTER_HOURS || '1', 10);
const BATCH_SIZE = parseInt(process.env.TURN_HARVESTER_BATCH_SIZE || '8', 10);
const MAX_SESSIONS = parseInt(process.env.TURN_HARVESTER_MAX_SESSIONS || '8', 10);
const MIN_SESSION_AGE_MS = parseInt(process.env.TURN_HARVESTER_MIN_SESSION_AGE_MS || String(5 * 60 * 1000), 10);
const MAX_LLM_CALLS_PER_RUN = parseInt(process.env.TURN_HARVESTER_MAX_LLM_CALLS || '2', 10);
const MAX_BATCHES_PER_SESSION = parseInt(process.env.TURN_HARVESTER_MAX_BATCHES_PER_SESSION || '1', 10);
// BRAINX_TURN_HARVESTER_FIDELITY_THROUGHPUT_20260620: raise caps so load-bearing
// detail (amounts, dates, URLs, IDs) is not truncated before reaching the reviewer.
// All env-overridable. MAX_TURN_CHARS=1000 covers figures/IDs at the end of a turn;
// MAX_BATCH_CHARS=12000 fits the full 8-turn batch (~1000 chars/turn) without
// dropping later domains; TOOL_OUTPUT_CHARS bounds tool_result excerpts (see parse).
const MAX_TURN_CHARS = parseInt(process.env.TURN_HARVESTER_MAX_TURN_CHARS || '1000', 10); // per turn before truncation
const MAX_BATCH_CHARS = parseInt(process.env.TURN_HARVESTER_MAX_BATCH_CHARS || '12000', 10); // guard against huge batches
const TOOL_OUTPUT_CHARS = parseInt(process.env.TURN_HARVESTER_TOOL_OUTPUT_CHARS || '800', 10); // tool_result excerpt cap
// brainx-reviewer resolves to openai-metered/gpt-5-nano (openclaw.json agents[brainx-reviewer]
// + lib/agent-llm.js). gpt-5-nano is metered (cheap) and fast; keep a generous timeout for
// API/portal latency. NOTE: MiniMax-M3 is the LCM summarizer (LCM_SUMMARY_MODEL), a different
// subsystem — NOT this harvester. env-overridable.
const LLM_TIMEOUT_MS = parseInt(process.env.TURN_HARVESTER_LLM_TIMEOUT_MS || '240000', 10);
// BRAINX_TURN_HARVESTER_CONCURRENCY_20260621: process independent sessions concurrently.
// Each session owns its own per-session checkpoint, and the global LLM budget is enforced by
// the synchronous check+increment of report.llmCallsAttempted (no await between them), so
// single-threaded JS guarantees the budget is never over-shot under concurrency. This collapses
// N sequential ~90s gpt-5-nano calls into ceil(N/CONCURRENCY) waves, cutting the 679-in/32-out
// backlog without any batch/fidelity change. Revert to the old behavior with CONCURRENCY=1.
// Default 3 (not higher) because each LLM call spawns an `openclaw agent` subprocess, so
// concurrency multiplies host load on a box already running ~16 ACP agents; the cron's
// review-loop-load-gate (exit 75) is the upstream guard that skips the run when the gateway is
// busy. Measured at concurrency 4: 8 calls in 101s wall-clock (~7x vs sequential).
const HARVEST_CONCURRENCY = Math.max(1, parseInt(process.env.TURN_HARVESTER_CONCURRENCY || '3', 10));
// BRAINX_QUALITY_MACHINE_JSON_REJECT_20260702: the semantic reviewer's sessions are
// extraction jobs — harvesting them fed BrainX its own JSON exhaust as "memories".
const DEFAULT_EXCLUDED_AGENTS = ['brainx-reviewer', 'brainx-semantic-reviewer'];
const EXCLUDED_AGENT_IDS = new Set([
  ...DEFAULT_EXCLUDED_AGENTS,
  ...parseEnvList(process.env.TURN_HARVESTER_EXCLUDE_AGENTS),
]);

function parsePositiveInt(raw, fallback) {
  const value = parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseNonNegativeInt(raw, fallback) {
  const value = parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseEnvList(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeAgentId(agentId) {
  return String(agentId || '').trim().toLowerCase();
}

function normalizeScopeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]/g, '');
}

function addConversationScopeAliases(keys, platform, kind, id) {
  const normalizedId = normalizeScopeToken(id).replace(/[^a-z0-9_-]/g, '');
  if (!normalizedId || normalizedId.length < 4) return;
  const normalizedKind = normalizeScopeToken(kind) || 'channel';
  const kindKey = /thread/.test(normalizedKind)
    ? 'thread'
    : /(?:dm|direct|peer)/.test(normalizedKind)
      ? 'dm'
      : 'channel';
  const normalizedPlatform = normalizeScopeToken(platform).replace(/[^a-z0-9_-]/g, '');
  keys.add(`conversation:${kindKey}:${normalizedId}`);
  keys.add(`${kindKey}:${normalizedId}`);
  if (normalizedPlatform) {
    keys.add(`conversation:${normalizedPlatform}:${kindKey}:${normalizedId}`);
    keys.add(`${normalizedPlatform}:${kindKey}:${normalizedId}`);
  }
}

function conversationScopeFromText(text) {
  const value = String(text || '');
  if (!value.trim()) return [];
  const keys = new Set();
  for (const match of value.matchAll(/\bconversation:([a-z0-9_-]+):(?:channel|thread|dm):([a-z0-9_-]{4,})\b/gi)) {
    const full = normalizeScopeToken(match[0]);
    if (full) keys.add(full);
    addConversationScopeAliases(keys, match[1], full.includes(':thread:') ? 'thread' : full.includes(':dm:') ? 'dm' : 'channel', match[2]);
  }
  for (const match of value.matchAll(/\b(?:conversation:)?(channel|thread|dm):([a-z0-9_-]{4,})\b/gi)) {
    addConversationScopeAliases(keys, '', match[1], match[2]);
  }
  for (const match of value.matchAll(/\b(discord|slack|telegram|whatsapp)\b[^\]\n]{0,140}?\b(channel|thread|conversation|chat|dm|direct message)\s*(?:id)?\s*[:=#]?\s*([a-z0-9_-]{4,})/gi)) {
    addConversationScopeAliases(keys, match[1], match[2], match[3]);
  }
  return Array.from(keys);
}

function deriveConversationScopeFromTurns(turns) {
  const keys = new Set();
  for (const turn of turns || []) {
    for (const key of conversationScopeFromText(turn && turn.text)) keys.add(key);
    if (keys.size >= 8) break;
  }
  return Array.from(keys).slice(0, 8);
}

function isExcludedAgent(agentId) {
  const key = normalizeAgentId(agentId);
  if (!key) return false;
  if (process.env.TURN_HARVESTER_INCLUDE_REVIEWER === '1' && key === 'brainx-reviewer') return false;
  return isOpsAgent(key) || EXCLUDED_AGENT_IDS.has(key);
}

// ── Args ──────────────────────────────────────────────────────────────────────

function parseArgs() {
  const argv = process.argv.slice(2);
  const args = {
    hours: DEFAULT_HOURS,
    dryRun: false,
    verbose: false,
    json: false,
    agent: null,
    session: null,
    maxSessions: MAX_SESSIONS,
    minSessionAgeMs: MIN_SESSION_AGE_MS,
    maxLlmCalls: MAX_LLM_CALLS_PER_RUN,
    maxBatchesPerSession: MAX_BATCHES_PER_SESSION,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hours') args.hours = parseInt(argv[++i], 10) || DEFAULT_HOURS;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--json') args.json = true;
    else if (a === '--agent') args.agent = argv[++i];
    // BRAINX_TURN_HARVESTER_FIDELITY_THROUGHPUT_20260620 (R1): targeted single-session flush.
    // When set, only this session is processed and the freshness/window filters are relaxed so
    // a session that just rotated (and is therefore very recent) is flushed to memory now.
    else if (a === '--session') args.session = argv[++i];
    else if (a === '--max-sessions') args.maxSessions = parsePositiveInt(argv[++i], MAX_SESSIONS);
    else if (a === '--min-age-minutes') args.minSessionAgeMs = parseNonNegativeInt(argv[++i], Math.ceil(MIN_SESSION_AGE_MS / 60000)) * 60 * 1000;
    else if (a === '--min-session-age-ms') args.minSessionAgeMs = parseNonNegativeInt(argv[++i], MIN_SESSION_AGE_MS);
    else if (a === '--max-llm-calls') args.maxLlmCalls = parsePositiveInt(argv[++i], MAX_LLM_CALLS_PER_RUN);
    else if (a === '--max-batches-per-session') args.maxBatchesPerSession = parsePositiveInt(argv[++i], MAX_BATCHES_PER_SESSION);
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node scripts/turn-harvester.js [--hours 1] [--dry-run] [--verbose] [--json] [--agent <id>] [--session <id>] [--max-sessions 8] [--min-age-minutes 5] [--max-llm-calls 2] [--max-batches-per-session 1]');
      process.exit(0);
    }
  }
  return args;
}

// ── Checkpoint ────────────────────────────────────────────────────────────────

function getCheckpointFile() {
  const d = new Date();
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return path.join(DATA_DIR, `turn-harvester-ckpt-${key}.json`);
}

function loadCheckpoint() {
  const file = getCheckpointFile();
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {}
  return {};
}

function saveCheckpoint(ckpt) {
  const file = getCheckpointFile();
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ckpt, null, 2));
}

// ── Session Discovery ─────────────────────────────────────────────────────────

function findRecentSessions(hoursAgo, agentFilter, options = {}) {
  const cutoff = Date.now() - hoursAgo * 3600 * 1000;
  const now = Date.now();
  const maxSessions = parsePositiveInt(options.maxSessions, MAX_SESSIONS);
  const minSessionAgeMs = parseNonNegativeInt(options.minSessionAgeMs, MIN_SESSION_AGE_MS);
  // BRAINX_TURN_HARVESTER_FIDELITY_THROUGHPUT_20260620 (R1): single-session flush target.
  const sessionFilter = options.sessionFilter ? String(options.sessionFilter) : null;
  const matchesTarget = (sid) => !!sessionFilter && (sid === sessionFilter || sid.startsWith(sessionFilter));
  const stats = options.stats || {};
  stats.excludedAgents = stats.excludedAgents || 0;
  stats.tooFresh = stats.tooFresh || 0;
  stats.tooSmall = stats.tooSmall || 0;
  stats.outsideWindow = stats.outsideWindow || 0;
  const sessions = [];
  if (!fs.existsSync(AGENTS_DIR)) return sessions;

  for (const agent of fs.readdirSync(AGENTS_DIR)) {
    if (agentFilter && agent !== agentFilter) continue;
    if (isExcludedAgent(agent)) {
      stats.excludedAgents++;
      continue;
    }
    const sessDir = path.join(AGENTS_DIR, agent, 'sessions');
    if (!fs.existsSync(sessDir)) continue;
    for (const f of fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl') && !f.includes('.trajectory'))) {
      const full = path.join(sessDir, f);
      const sid = f.replace('.jsonl', '');
      const isTarget = matchesTarget(sid);
      // When a specific session is targeted, skip everything that is not it.
      if (sessionFilter && !isTarget) continue;
      let stat;
      try { stat = fs.statSync(full); } catch (_) { continue; }
      if (stat.size <= 200) {
        stats.tooSmall++;
        continue;
      }
      // The window/freshness filters are bypassed for an explicit flush target so a
      // just-rotated (very recent) session can be captured immediately.
      if (!isTarget && stat.mtimeMs < cutoff) {
        stats.outsideWindow++;
        continue;
      }
      if (!isTarget && minSessionAgeMs > 0 && now - stat.mtimeMs < minSessionAgeMs) {
        stats.tooFresh++;
        continue;
      }
      sessions.push({
        agent,
        sessionId: sid,
        filePath: full,
        mtimeMs: stat.mtimeMs,
      });
    }
  }
  // BRAINX_ACP_TRANSCRIPT_HARVEST_20260612 + BRAINX_ACP_HARVEST_FILECAP_RAISE_20260621:
  // The old 12MB per-file cap silently SKIPPED the busiest ACP agents' main sessions
  // (parker's live session was 12.5MB, blade's 11-22MB) — so blade got only ~5 harvester
  // memories/24h and the promised "daily distiller backstop" only sweeps 3 sessions/day,
  // never reliably reaching them. Raise to 32MB so active ACP main transcripts are included.
  // Safe within the 600s step timeout: per-run work is still bounded by --max-llm-calls 4 and
  // --max-batches-per-session 3 (~24 turns/session/run); only the file read grows, and the
  // daily distiller already reads these same files uncapped (128MB) without timing out.
  for (const s of findAcpSessions(hoursAgo, { agentFilter, maxFileBytes: 32 * 1024 * 1024 })) {
    if (isExcludedAgent(s.agent)) { stats.excludedAgents++; continue; }
    const acpTarget = matchesTarget(s.sessionId);
    if (sessionFilter && !acpTarget) continue;
    if (!acpTarget && minSessionAgeMs > 0 && now - s.modified < minSessionAgeMs) { stats.tooFresh++; continue; }
    sessions.push({ agent: s.agent, sessionId: s.sessionId, filePath: s.path, mtimeMs: s.modified });
  }
  const ordered = sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  // For a targeted flush, return only the matching session(s), ignoring maxSessions.
  return sessionFilter ? ordered.filter((s) => matchesTarget(s.sessionId)) : ordered.slice(0, maxSessions);
}

// ── JSONL Parse ───────────────────────────────────────────────────────────────

function parseSessionTurns(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (_) { return []; }
  const turns = [];
  for (const line of raw.split('\n').filter(Boolean)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const rec = normalizeTranscriptRecord(entry);
    if (!rec) continue;
    const role = rec.role;
    const content = rec.content;
    const texts = [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          texts.push(block.text);
        } else if (block.type === 'tool_use') {
          // Tool invocation: keep just the name (the args are usually low-signal).
          const name = block.name || block.tool_use_id || '';
          if (name) texts.push(`[tool:${name}]`);
        } else if (block.type === 'tool_result') {
          // BRAINX_TURN_HARVESTER_FIDELITY_THROUGHPUT_20260620: include a bounded excerpt
          // of the tool OUTPUT (config values, error lines, URLs, query results) instead of
          // only the placeholder — this was the #1 cause of lost facts that live only in a
          // tool result. Secrets are scrubbed BEFORE the excerpt ever reaches the reviewer.
          const name = block.name || block.tool_use_id || 'tool';
          const c = block.content;
          let out = '';
          if (typeof c === 'string') out = c;
          else if (Array.isArray(c)) out = c.map((b) => (b && b.type === 'text' && typeof b.text === 'string') ? b.text : (typeof b === 'string' ? b : '')).join(' ');
          else if (c && typeof c === 'object' && typeof c.text === 'string') out = c.text;
          out = out.replace(/\s+/g, ' ').trim();
          if (out) {
            if (/\b(password|secret|api[_-]?key|bearer|private[_-]?key|token=)\b/i.test(out)) out = '[redacted-possible-secret]';
            texts.push(`[tool:${name}] ${out.slice(0, TOOL_OUTPUT_CHARS)}`);
          } else if (name) {
            texts.push(`[tool:${name}]`);
          }
        }
      }
    } else if (typeof content === 'string') {
      texts.push(content);
    }
    if (!texts.length) continue;
    const ts = rec.timestamp;
    turns.push({ role, text: texts.join(' ').slice(0, MAX_TURN_CHARS * 2), ts });
  }
  return turns;
}

// ── Workspace Mapping ─────────────────────────────────────────────────────────
// Maps agent ID → workspace directory (for memory + WORKING_STATE writes)

function agentWorkspaceDir(agentId) {
  // main is the only special case (workspace, not workspace-main)
  const wsName = agentId === 'main' ? 'workspace' : `workspace-${agentId}`;
  const wsDir = path.join(OPENCLAW_DIR, wsName);
  return fs.existsSync(wsDir) ? wsDir : null;
}

function todayMemoryFile(workspaceDir) {
  const d = new Date();
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const memDir = path.join(workspaceDir, 'memory');
  if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });
  return path.join(memDir, `${key}.md`);
}

// ── LLM Extraction ────────────────────────────────────────────────────────────

// BRAINX_TURN_HARVESTER_FIDELITY_THROUGHPUT_20260620: domain-aware extraction that
// preserves LOAD-BEARING detail (amounts/dates/URLs/IDs) verbatim instead of
// compressing it away into a vague summary. Same JSON key shape as before (parser
// unchanged), content cap raised 180 -> 280, context normalized to a closed domain set.
const EXTRACT_SYSTEM = `You are BrainX's memory extraction engine. You receive raw conversation turns from an AI agent session (turns may include short excerpts of tool outputs prefixed with [tool:NAME]).

Your job: extract ONLY what is worth remembering long-term, and preserve LOAD-BEARING DETAIL EXACTLY. Be selective about WHICH facts to keep, but NEVER paraphrase away a number, date, amount, URL, or identifier — copy those verbatim.

CRITICAL PRESERVATION RULE (do not violate):
When a memory references any of the following, reproduce them VERBATIM, never rounded, summarized, or replaced with vague words ("several", "some", "a few", "around"):
- Money/amounts and currency (e.g. "USD 4,250.00", "$1.2M", "12.5% fee")
- Dates, deadlines, times (e.g. "2026-06-20", "due Fri Jun 27", invoice/quote dates)
- URLs and domains (keep the full URL; if there are many, list each one you can)
- Identifiers: PR#, issue#, branch names, commit SHAs, file paths, env var names, config keys, ticket IDs, order/invoice numbers, client/company names, email addresses
- Exact metric/KPI values, version strings, error codes/exit codes
If a fact's value is its precision (an amount, an ID, a URL), a vague summary is WORSE than omitting it — keep the exact value or drop the memory.

DOMAIN AWARENESS:
Classify each memory into exactly one domain and put it in "context" as "domain:<one-of>":
- finance   — invoices, amounts, payments, billing, budgets, client money
- dev       — code, bugs, fixes, diffs, configs, infra, runtime, errors
- marketing — campaigns, KPIs, analytics, ads, content strategy
- seo       — keyword/URL research, rankings, audits, link lists, metrics
- proposals — client/sponsor proposals, pricing offers, contract revisions, emails
- personal  — user preferences, casual/personal context, non-work facts
- ops       — scheduling, process, account/auth, deployment, cron, ops decisions
- session   — only if it genuinely fits no domain above
Use the domain to decide what detail matters: for finance/proposals keep amounts+clients+dates; for seo keep every URL+metric; for dev keep error codes+IDs+paths.

DO NOT CAPTURE (Hermes-style — these harden into self-imposed constraints that bite you later when the environment changes; an empty "memories" list is the correct output when only these are present):
- Environment-dependent failures: missing binaries, "command not found", fresh-install errors, unconfigured credentials, uninstalled packages, post-migration path mismatches. The user can fix these — they are NOT durable rules. If a tool failed because of setup state, capture the FIX (the install command, config step, env var) under dev/ops — never "this tool does not work".
- Negative claims about tools or features ("X tool is broken", "browser tools do not work", "cannot use Y"). These harden into refusals the agent cites against itself for months after the actual problem was fixed. Do not store them.
- Session-specific transient errors that resolved before the turn ended. If a retry worked, the lesson is the retry pattern, not the original failure.
- One-off task narratives ("summarize today's market", "analyze this PR", "se respondió con X"). A single task is not a reusable class of work.
- Trivial turns: greetings, acknowledgements, "ok"/"listo"/"done"/"PONG"/"hey", status pings, or any turn with no decision, fact, ID, preference, or reusable technique. Return "memories": [] and an empty "narrative" for these — never store "user greeted" / "responded with X".

Capturing is still the default when there IS a durable fact, decision, gotcha, preference, or reusable technique — be selective about junk, not stingy about real signal.

Return a JSON object with these keys (no markdown, no explanation):
{
  "memories": [
    {
      "content": "concise fact/decision/gotcha, max 280 chars, with all numbers/dates/URLs/IDs verbatim",
      "type": "fact|decision|gotcha|learning",
      "tier": "hot|warm|cold",
      "importance": 1-10,
      "tags": ["tag1", "tag2"],
      "context": "domain:finance|domain:dev|domain:marketing|domain:seo|domain:proposals|domain:personal|domain:ops|domain:session"
    }
  ],
  "narrative": "1-2 sentence summary of what happened (for daily log). Empty string if nothing notable.",
  "active_state": {
    "current": "what is being actively worked on right now (1 sentence)",
    "open_threads": ["thread1", "thread2"],
    "ids": ["PR#123", "branch: feature/x", "SHA: abc123", "invoice 2026-0042: USD 4,250 due 2026-06-27", "https://example.com/page"],
    "next_steps": "what should happen next"
  }
}

Rules:
- "memories": only include if genuinely reusable across future sessions. Max 6 per batch. When a single domain has many discrete exact values (a list of URLs, several invoice amounts), prefer ONE memory that lists them all verbatim over dropping them.
- "content": max 280 chars. Keep exact values even if it costs characters; trim prose, not data.
- "narrative": max 3 sentences. Empty string if the turns are just boilerplate/noise.
- "active_state": populate "ids" with EVERY actionable exact reference seen (PRs, branches, SHAs, URLs, amounts+dates, paths). This is the recovery anchor after a session rotation — missing IDs here means they are lost. Set active_state to null only if there is no active task at all.
- Never include secrets, API keys, tokens, passwords, bearer/credentials in any field.
- Never fabricate. If uncertain about a value, omit that memory rather than guessing.`;

// Retry transient LLM failures (MiniMax-M3 portal latency/load can exceed the
// per-call timeout). A persistent transient failure still throws after the
// retries are exhausted, so the caller opens a checkpoint gap and retries the
// batch next run. Terminal extraction-shape failures are not retried forever.
const DEFAULT_LLM_RETRY_BACKOFF_MS = [3000, 8000];
const LLM_RETRY_BACKOFF_MS = DEFAULT_LLM_RETRY_BACKOFF_MS.slice(
  0,
  Math.min(2, parseNonNegativeInt(process.env.TURN_HARVESTER_LLM_RETRIES, 0)),
);

function isTerminalExtractionError(err) {
  return /LLM_NO_JSON|LLM_JSON_PARSE/.test(err?.message || '');
}

async function withLlmRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const transient = /AGENT_LLM_TIMEOUT|AGENT_LLM_FAIL|AGENT_LLM_STATUS|LLM_CALL_FAILED/.test(err.message || '');
      if (!transient || attempt >= LLM_RETRY_BACKOFF_MS.length) throw err;
      await new Promise((r) => setTimeout(r, LLM_RETRY_BACKOFF_MS[attempt]));
    }
  }
}

// BRAINX_TURN_HARVESTER_FIDELITY_THROUGHPUT_20260620: pure helper that decides how many
// turns of a batch fit within MAX_BATCH_CHARS. The FIRST turn is always included even if it
// alone exceeds the budget, so the per-session watermark always advances ≥1 turn and never
// infinite-loops on an oversized leading turn. Exported for unit testing without an LLM.
function buildBatchChunks(turns) {
  const chunks = [];
  let totalChars = 0;
  let consumedTurns = 0;
  for (const turn of turns) {
    const snippet = `[${turn.role}]: ${String(turn.text || '').slice(0, MAX_TURN_CHARS)}`;
    if (chunks.length && totalChars + snippet.length > MAX_BATCH_CHARS) break;
    chunks.push(snippet);
    totalChars += snippet.length;
    consumedTurns++;
  }
  return { chunks, consumedTurns };
}

// BRAINX_TURN_HARVESTER_SIGNAL_GATE_20260628: cheap pre-LLM gate. The harvester runs every
// 20 min over ~10 sessions and was spending one gpt-5-nano call per batch even on trivial
// turns (greetings / acks / "PONG" / status pings) that yield useless memories like
// "User said hey; no tasks started". This skips the LLM call for batches with NO signal.
// CONSERVATIVE: any signal keyword OR >= SIGNAL_MIN_CHARS of prose => process (bias to
// capture, never drop real content). Default ON; kill with BRAINX_TURN_HARVESTER_SIGNAL_GATE=0.
// No data loss: consumedTurns still advances so trivial turns are checkpointed (not re-read),
// and any real follow-up turn is processed normally on the next run.
const SIGNAL_GATE = !/^(0|false|off|no)$/i.test(process.env.BRAINX_TURN_HARVESTER_SIGNAL_GATE || '1');
const SIGNAL_MIN_CHARS = parseInt(process.env.BRAINX_TURN_HARVESTER_SIGNAL_MIN_CHARS || '200', 10);
const SIGNAL_RE = /\b(error|bug|fix|fail|issue|warn|deploy|auth|token|api|key|config|cron|memor|context|decid|decision|prefer|prefier|debe|must|should|usar|evitar|avoid|because|porque|root ?cause|ra[ií]z|branch|commit|PR|merge|https?:|password|secret|client|cliente|propuesta|proposal|email|correo|deadline|invoice|factura|amount|monto|schedul|agend|remember|record|importante|important|gotcha|workaround|install|migrat|schema|database|query|endpoint|webhook|quiero|necesito|always|never|siempre|nunca|implement|refactor|build|test|verif|audit|review|blocker|bloque|pend)/i;

// Returns true when a batch is worth an LLM call. Exported for unit testing without an LLM.
function batchHasSignal(chunks) {
  const prose = chunks.map((c) => c.replace(/^\[[^\]]*\]:\s*/, '')).join(' ');
  if (SIGNAL_RE.test(prose)) return true;
  return prose.replace(/\s+/g, ' ').trim().length >= SIGNAL_MIN_CHARS;
}

// Returns { insights, consumedTurns }. consumedTurns is how many turns of the batch were
// actually sent to the reviewer; the caller advances the checkpoint by exactly this many so
// turns dropped by the char-budget are retried next run instead of being silently lost.
async function extractInsights(turns, agentId, sessionId) {
  if (!turns.length) return { insights: null, consumedTurns: 0 };

  const { chunks, consumedTurns } = buildBatchChunks(turns);
  if (!chunks.length) return { insights: null, consumedTurns: 0 };

  // Pre-LLM signal gate: skip the gpt-5-nano call for trivial batches (greetings/acks).
  if (SIGNAL_GATE && !batchHasSignal(chunks)) {
    return { insights: null, consumedTurns, skippedNoSignal: true };
  }

  const userMsg = `Agent: ${agentId}\nSession: ${sessionId}\n\nTurns:\n${chunks.join('\n\n')}`;

  let raw;
  try {
    const result = await callAgentLLM({
      system: EXTRACT_SYSTEM,
      user: userMsg,
      label: 'turn-harvest',
      timeoutMs: LLM_TIMEOUT_MS,
    });
    raw = result.text;
  } catch (err) {
    throw new Error(`LLM_CALL_FAILED: ${err.message}`);
  }

  // Parse JSON from response
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`LLM_NO_JSON: ${raw.slice(0, 200)}`);
  try {
    return { insights: JSON.parse(match[0]), consumedTurns };
  } catch (err) {
    throw new Error(`LLM_JSON_PARSE: ${err.message}`);
  }
}

// ── Memory Insertion ──────────────────────────────────────────────────────────

function memoryId(content, agentId, sessionId) {
  return crypto.createHash('sha256')
    .update(`turn-harvester:${agentId}:${sessionId}:${content}`)
    .digest('hex')
    .slice(0, 32);
}

async function insertMemory(item, agentId, sessionId, dryRun, conversationScope = []) {
  const content = String(item.content || '').trim().slice(0, 900);
  if (!content || content.length < 10) return null;

  // Basic secret guard
  if (/\b(password|secret|api[_-]?key|bearer|private[_-]?key|token=)\b/i.test(content)) return null;

  const id = memoryId(content, agentId, sessionId);
  const type = ['fact', 'decision', 'gotcha', 'learning'].includes(item.type) ? item.type : 'fact';
  const tier = ['hot', 'warm', 'cold'].includes(item.tier) ? item.tier : 'warm';
  const importance = Math.min(10, Math.max(1, parseInt(item.importance, 10) || 5));
  const scopeKeys = Array.isArray(conversationScope) ? conversationScope.filter(Boolean).slice(0, 8) : [];
  const tags = ['turn_harvester', ...(scopeKeys.length ? ['conversation_scoped'] : []), ...(Array.isArray(item.tags) ? item.tags.slice(0, 7) : [])];
  const context = String(item.context || 'openclaw:session').slice(0, 80);
  const sourcePath = ['session:' + sessionId, ...scopeKeys].join('|');

  if (dryRun) return { id, content, type, tier, importance, tags, context, dryRun: true };

  // Gated path: shared quality gate + semantic dedup. Preserves turn-harvester
  // provenance (agent_inference / hypothesis / conservative 0.75 confidence);
  // low-signal rows are skipped or downgraded, near-dups merged, not duplicated.
  if (TURN_HARVEST_GATE) {
    const res = await storeMemory({
      id, type, content, context, tier, agent: agentId, importance, tags,
      status: 'pending',
      source_kind: 'agent_inference',
      source_path: sourcePath,
      confidence_score: 0.75,
      verification_state: 'hypothesis',
    });
    if (res && res.skipped) return { id: null, skipped: true, reason: res.reason };
    return { id: (res && res.id) || id, content, type, tier, importance, merged: !!(res && res.dedupe_merged), quality: res && res.quality_action };
  }

  const embedding = await embed(content);
  // BRAINX_DEDUP_NULL_EMBED_GUARD_20260702: write the ACTIVE calibration column
  // (this INSERT hardcoded legacy `embedding` — recall-invisible rows + dedup poison
  // since the Gemini switch; see handoff-promoter.js for the full story).
  const embedCol = require('../lib/recall-calibration').activeColumn();
  await db.query(
    `INSERT INTO brainx_memories (
       id, type, content, context, tier, agent, importance, ${embedCol}, tags,
       status, category, source_session, source_kind, source_path,
       confidence_score, sensitivity, verification_state, first_seen, last_seen
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),NOW())
     ON CONFLICT (id) DO UPDATE SET
       last_seen = NOW(),
       importance = GREATEST(brainx_memories.importance, EXCLUDED.importance),
       source_path = COALESCE(brainx_memories.source_path, EXCLUDED.source_path)`,
    [
      id, type, content, context, tier, agentId, importance,
      JSON.stringify(embedding), tags,
      'pending', null, sessionId, 'agent_inference', sourcePath,
      0.75, 'normal', 'hypothesis',
    ],
  );
  return { id, content, type, tier, importance };
}

// ── Daily Memory Write ────────────────────────────────────────────────────────

function appendToMemoryFile(workspaceDir, agentId, sessionId, narrative, dryRun) {
  if (!narrative || !narrative.trim()) return false;
  const memFile = todayMemoryFile(workspaceDir);
  const ts = new Date().toISOString();
  const marker = `turn-harvester:${agentId}:${sessionId.slice(0, 8)}:${ts}`;
  const block = [
    ``,
    `<!-- session-memory:${marker}:start -->`,
    `## ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })} — Session ${sessionId.slice(0, 8)} (${agentId})`,
    ``,
    narrative.trim(),
    ``,
    `<!-- session-memory:${marker}:end -->`,
    ``,
  ].join('\n');

  if (dryRun) return true;
  fs.appendFileSync(memFile, block);
  return true;
}

// ── WORKING_STATE Update ──────────────────────────────────────────────────────

// BRAINX_WORKING_STATE_REFRESH_20260613: keep a harvester-owned "freshest detected task"
// block at the TOP of WORKING_STATE.md, ALWAYS refreshed.
//
// Root cause this fixes (cowboy + echo amnesia, 2026-06-13): the previous design wrote
// "## Current" only ONCE (when the file was still the default seed) and then skipped
// forever as "human-managed state". That fossilized the state — cowboy stayed pinned to a
// Mapitt task from 2026-06-11, echo's custom doc stayed pinned to an Agripure task from
// another session/agent. When a turn was cut (rotation / native auto-compact / gateway
// restart / 401) and resumed in a fresh session with a scopeless prompt like "como vas",
// the agent reconstructed from that fossil and confidently answered about the WRONG project.
//
// New behavior: a marker-delimited block (idempotently replaced each run) holds the freshest
// task the harvester detected, plus a hard scope-verification warning. It is inserted ABOVE
// any human-authored sections and never clobbers them — so the first thing the agent reads
// on resume is current, and it is explicitly told the sections below may be from another
// session/project and must be verified against the live channel/transcript before claiming.
function buildCurrentBlock(activeState, ts) {
  const BEGIN = '<!-- brainx-current:begin -->';
  const END = '<!-- brainx-current:end -->';
  const threads = Array.isArray(activeState.open_threads) && activeState.open_threads.length
    ? activeState.open_threads.map((t) => `  - ${t}`).join('\n')
    : '  - (none)';
  const ids = Array.isArray(activeState.ids) && activeState.ids.length
    ? activeState.ids.map((id) => `  - ${id}`).join('\n')
    : '  - (none)';
  const body =
    `${BEGIN}\n` +
    `## ⚡ Estado actual (auto-detectado por turn-harvester)\n\n` +
    `- ${activeState.current} _(${ts})_\n` +
    `- Hilos abiertos:\n${threads}\n` +
    `- IDs / refs:\n${ids}\n` +
    `- ⚠️ Esto es lo MÁS reciente que el harvester detectó para este agente. Si difiere de las ` +
    `secciones de abajo, esas pueden ser de OTRA sesión o proyecto — verificá el canal/transcript ` +
    `actual y el repo/runtime ANTES de afirmar "estábamos en X". No asumas que el estado durable es la tarea actual.\n` +
    `${END}`;
  return { BEGIN, END, body };
}

// BRAINX_TURN_HARVESTER_FIDELITY_THROUGHPUT_20260620: WORKING_STATE.md has no size cap and the
// machine-generated "COMPACTION (auto) ... [OPENCLAW_PRECOMPACT_WORKING_STATE_...]" breadcrumb
// lines accumulate unbounded (Claude ACP @imports the WHOLE file every turn → expensive). Collapse
// those breadcrumbs to the most recent N. ONLY removes lines matching the precompact marker — it
// never touches human-authored content or the brainx-current / brainx-failsafe marker blocks.
const WORKING_STATE_MAX_COMPACTION_LINES = parseInt(process.env.TURN_HARVESTER_WS_MAX_COMPACTION_LINES || '3', 10);
function pruneWorkingStateBloat(content) {
  const isBreadcrumb = (l) => /COMPACTION \((?:auto|manual)\).*OPENCLAW_PRECOMPACT_WORKING_STATE/.test(l);
  const lines = content.split('\n');
  const total = lines.reduce((n, l) => n + (isBreadcrumb(l) ? 1 : 0), 0);
  if (total <= WORKING_STATE_MAX_COMPACTION_LINES) return content;
  const dropOldest = total - WORKING_STATE_MAX_COMPACTION_LINES;
  let seen = 0;
  const out = [];
  for (const l of lines) {
    if (isBreadcrumb(l)) {
      seen++;
      if (seen <= dropOldest) continue; // drop the oldest breadcrumbs, keep the most recent N
    }
    out.push(l);
  }
  return out.join('\n');
}

// BRAINX_TURN_HARVESTER_WS_LEGACY_ARCHIVE_20260626: the harvester-owned legacy "## Current"
// section (the pre-marker-block format) is never rewritten, so across task switches it
// fossilizes and grows UNBOUNDED — writer hit 35KB / 39 bullets across 9 projects; media-gen-2
// froze 16 days at a dead task; coder froze at a different-domain audit. Once the live
// <!-- brainx-current --> block carries the fresh task, that legacy body is redundant + stale,
// and for embedded runtimes (Kimi/GPT-5.5 — LCM never fires, compactionCount=0) WORKING_STATE
// is the ONLY continuity surface, so the fossil actively misleads recovery. When enabled, roll
// the legacy body off to memory/YYYY-MM-DD.md (NON-destructive) and leave a one-line breadcrumb.
// Default OFF + min-body gate so it only ever touches real fossils; NEVER touches the marker
// block, a human "## Tarea actual"/custom section, or "## Protocol".
function archiveStaleLegacyCurrent(content, workspaceDir, agentId, dryRun) {
  // Read flags at call time (each cron run is a fresh process; also keeps it unit-testable).
  if (process.env.TURN_HARVESTER_WS_LEGACY_ARCHIVE !== '1') return content;
  const WS_LEGACY_MIN_BODY_CHARS = parseInt(process.env.TURN_HARVESTER_WS_LEGACY_MIN_CHARS || '1500', 10);
  // Only roll off once the fresh marker block exists — it holds the current task.
  if (!content.includes('<!-- brainx-current:begin -->')) return content;
  // Legacy harvester "## Current" body only: header -> next "## " / marker / EOF.
  const m = content.match(/(\n## Current[^\n]*\n)([\s\S]*?)(?=\n## |\n<!-- |\s*$)/);
  if (!m) return content;
  const header = m[1];
  const body = m[2];
  if (body.replace(/\s+/g, '').length < WS_LEGACY_MIN_BODY_CHARS) return content; // small/recent -> leave it
  if (/BRAINX_TURN_HARVESTER_WS_LEGACY_ARCHIVE_20260626/.test(body)) return content; // idempotent
  const day = new Date().toISOString().slice(0, 10);
  const narrative =
    `🗄️ turn-harvester rolled off a stale legacy WORKING_STATE "## Current" section ` +
    `(superseded by the live ⚡ brainx-current block). Archived original:\n\n${body.trim()}`;
  if (!dryRun) {
    try { appendToMemoryFile(workspaceDir, agentId, `wslegacy${day.replace(/-/g, '')}`, narrative, false); } catch (_) {}
  }
  const breadcrumb =
    `\n- _(Entradas previas de esta sección archivadas a memory/${day}.md ` +
    `[BRAINX_TURN_HARVESTER_WS_LEGACY_ARCHIVE_20260626] — el bloque ⚡ "Estado actual" de arriba tiene la tarea vigente; verificá repo/runtime antes de afirmar.)_\n`;
  return content.slice(0, m.index) + header + breadcrumb + content.slice(m.index + m[0].length);
}

function updateWorkingState(workspaceDir, activeState, agentId, dryRun) {
  if (!activeState || !activeState.current) return false;
  const wsFile = path.join(workspaceDir, 'WORKING_STATE.md');
  if (!fs.existsSync(wsFile)) return false;

  let content;
  try { content = fs.readFileSync(wsFile, 'utf8'); } catch (_) { return false; }

  const ts = new Date().toISOString();
  const { BEGIN, END, body } = buildCurrentBlock(activeState, ts);

  let newContent;
  const blockRe = new RegExp(`${BEGIN}[\\s\\S]*?${END}`);
  if (blockRe.test(content)) {
    // Idempotent refresh of our own block (markers are unique → no fragile markdown parsing).
    newContent = content.replace(blockRe, body);
  } else {
    // First time on this doc: insert just before the first "## " section (after the title +
    // intro blockquote), or append if the doc has no sections. Never touches human content.
    const idx = content.indexOf('\n## ');
    if (idx === -1) {
      newContent = `${content.replace(/\s*$/, '')}\n\n${body}\n`;
    } else {
      newContent = `${content.slice(0, idx + 1)}\n${body}\n\n${content.slice(idx + 1)}`;
    }
  }

  // Collapse accumulated auto-compaction breadcrumbs (bounded growth) before writing.
  newContent = pruneWorkingStateBloat(newContent);

  // Roll off a stale, oversized legacy "## Current" fossil to daily memory (opt-in, gated).
  newContent = archiveStaleLegacyCurrent(newContent, workspaceDir, agentId, dryRun);

  if (newContent === content) return false;
  if (dryRun) return true;
  fs.writeFileSync(wsFile, newContent);
  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const ckpt = loadCheckpoint();
  const discoveryStats = {};
  const sessions = findRecentSessions(args.hours, args.agent, {
    maxSessions: args.maxSessions,
    minSessionAgeMs: args.minSessionAgeMs,
    sessionFilter: args.session,
    stats: discoveryStats,
  });

  const report = {
    ok: true,
    status: 'ok',
    job: 'brainx-turn-harvester',
    mode: 'turn_harvester',
    sessionsFound: sessions.length,
    sessionsProcessed: 0,
    turnsNew: 0,
    memoriesInserted: 0,
    memoriesSkipped: 0,
    narrativesWritten: 0,
    workingStateUpdated: 0,
    llmCallsAttempted: 0,
    batchesDeferred: 0,
    sessionsDeferred: 0,
    budgetExhausted: false,
    extractionSkipped: 0,
    charBudgetTruncated: 0,
    config: {
      hours: args.hours,
      maxSessions: args.maxSessions,
      minSessionAgeMs: args.minSessionAgeMs,
      maxLlmCalls: args.maxLlmCalls,
      maxBatchesPerSession: args.maxBatchesPerSession,
      batchSize: BATCH_SIZE,
      llmTimeoutMs: LLM_TIMEOUT_MS,
      llmRetries: LLM_RETRY_BACKOFF_MS.length,
      excludedAgents: [...EXCLUDED_AGENT_IDS],
    },
    discoverySkipped: discoveryStats,
    errors: [],
  };

  if (args.verbose) console.error(`[turn-harvester] sessions found: ${sessions.length}`);

  const budget = { exhausted: false };

  async function processSession(sess) {
    if (budget.exhausted) {
      report.sessionsDeferred++;
      return;
    }
    const { agent, sessionId, filePath } = sess;
    const ckptKey = `${agent}:${sessionId}`;
    const lastProcessed = ckpt[ckptKey]?.lastTurnIndex ?? -1;

    const allTurns = parseSessionTurns(filePath);
    const newTurns = allTurns.slice(lastProcessed + 1);

    if (!newTurns.length) {
      if (args.verbose) console.error(`[turn-harvester] ${ckptKey}: no new turns`);
      return;
    }

    report.turnsNew += newTurns.length;
    if (args.verbose) console.error(`[turn-harvester] ${ckptKey}: ${newTurns.length} new turns`);
    const conversationScope = deriveConversationScopeFromTurns(allTurns);

    // Process in batches. Track a CONTIGUOUS high-water mark (okThroughTurn): the
    // checkpoint may only advance over batches that all succeeded IN ORDER. The
    // first batch that fails (after retries) opens a gap — we stop advancing the
    // watermark so those turns are retried on the next run instead of being
    // silently skipped (the old code advanced past failed batches, losing them).
    let okThroughTurn = lastProcessed;
    let gapHit = false;
    let sessionTouched = false;
    let batchesForSession = 0;
    for (let i = 0; i < newTurns.length; i += BATCH_SIZE) {
      if (report.llmCallsAttempted >= args.maxLlmCalls) {
        budget.exhausted = true;
        report.budgetExhausted = true;
        report.batchesDeferred++;
        break;
      }
      if (batchesForSession >= args.maxBatchesPerSession) {
        report.batchesDeferred++;
        break;
      }
      const batch = newTurns.slice(i, i + BATCH_SIZE);
      // Absolute index of this batch's last turn (newTurns[0] === lastProcessed+1).
      const batchEnd = lastProcessed + Math.min(i + BATCH_SIZE, newTurns.length);
      let result;
      try {
        report.llmCallsAttempted++;
        batchesForSession++;
        sessionTouched = true;
        result = await withLlmRetry(() => extractInsights(batch, agent, sessionId));
      } catch (err) {
        report.errors.push({ session: ckptKey, error: err.message });
        if (args.verbose) console.error(`[turn-harvester] LLM error for ${ckptKey} (batch @${i}): ${err.message}`);
        if (isTerminalExtractionError(err)) {
          report.extractionSkipped++;
          okThroughTurn = batchEnd;
          continue;
        }
        gapHit = true; // open a gap — do not advance the watermark past here
        break;
      }

      const insights = result ? result.insights : null;
      const consumedTurns = result ? result.consumedTurns : 0;
      // BRAINX_TURN_HARVESTER_FIDELITY_THROUGHPUT_20260620: advance the watermark ONLY over
      // turns the reviewer actually consumed. If MAX_BATCH_CHARS truncated the batch
      // (consumedTurns < batch.length) the leftover turns were NOT extracted — record it and
      // stop so they are retried next run instead of being checkpointed and lost forever.
      const batchConsumedEnd = lastProcessed + i + consumedTurns;
      const charBudgetTruncated = consumedTurns < batch.length;

      // Empty extraction is a valid "nothing worth remembering" result, not a
      // failure: advance the watermark (still contiguous) and move on.
      if (!insights) {
        // Signal-gate skip: no LLM call happened, so correct the attempt counter and
        // track the saving for cost reporting.
        if (result && result.skippedNoSignal) {
          report.signalSkipped = (report.signalSkipped || 0) + 1;
          if (report.llmCallsAttempted > 0) report.llmCallsAttempted--;
        }
        if (!gapHit) okThroughTurn = batchConsumedEnd;
        if (charBudgetTruncated) { report.charBudgetTruncated++; break; }
        continue;
      }

      // 1. Insert memories into DB
      const mems = Array.isArray(insights.memories) ? insights.memories : [];
      for (const item of mems.slice(0, 6)) {
        try {
          const result = await insertMemory(item, agent, sessionId, args.dryRun, conversationScope);
          if (result && result.skipped) {
            report.memoriesGated = (report.memoriesGated || 0) + 1;
            if (args.verbose) console.error(`[turn-harvester] gated: ${result.reason || 'quality'}`);
          } else if (result) {
            report.memoriesInserted++;
            if (result.merged) report.memoriesMerged = (report.memoriesMerged || 0) + 1;
            if (args.verbose) console.error(`[turn-harvester] memory${result.merged ? ' (merged)' : ''}: ${result.content?.slice(0, 60)}...`);
          }
        } catch (err) {
          report.memoriesSkipped++;
          if (args.verbose) console.error(`[turn-harvester] memory insert error: ${err.message}`);
        }
      }

      // 2. Append narrative to memory/YYYY-MM-DD.md
      const wsDir = agentWorkspaceDir(agent);
      if (wsDir && insights.narrative) {
        try {
          const written = appendToMemoryFile(wsDir, agent, sessionId, insights.narrative, args.dryRun);
          if (written) report.narrativesWritten++;
        } catch (err) {
          if (args.verbose) console.error(`[turn-harvester] narrative write error: ${err.message}`);
        }
      }

      // 3. Update WORKING_STATE.md if active state found (only for first batch)
      if (i === 0 && wsDir && insights.active_state) {
        try {
          const updated = updateWorkingState(wsDir, insights.active_state, agent, args.dryRun);
          if (updated) report.workingStateUpdated++;
        } catch (err) {
          if (args.verbose) console.error(`[turn-harvester] working_state error: ${err.message}`);
        }
      }

      // Batch processed — advance the contiguous watermark only over consumed turns (DB
      // inserts are idempotent via memoryId + ON CONFLICT, so an item-level insert skip
      // above does not open a gap; only an LLM-extraction failure does). If the char-budget
      // truncated the batch, stop here so the unconsumed turns are retried next run.
      if (!gapHit) okThroughTurn = batchConsumedEnd;
      if (charBudgetTruncated) { report.charBudgetTruncated++; break; }
    }

    // Advance the checkpoint only over the contiguous successful prefix. Failed
    // batches (gapHit) stay un-checkpointed so the next run retries them instead
    // of losing their extractions.
    if (sessionTouched || okThroughTurn > lastProcessed) {
      ckpt[ckptKey] = {
        lastTurnIndex: okThroughTurn,
        lastProcessedAt: new Date().toISOString(),
      };
      report.sessionsProcessed++;
      // Persist progress per session so a mid-run kill (the 300s step timeout)
      // still advances the checkpoint instead of reprocessing the whole backlog
      // on the next loop.
      if (!args.dryRun) saveCheckpoint(ckpt);
    }
  }

  // BRAINX_TURN_HARVESTER_CONCURRENCY_20260621: bounded worker pool over independent
  // sessions. Workers pull the next session until the list drains or the global LLM budget
  // is exhausted; per-session checkpoints + synchronous budget accounting keep this correct
  // under concurrency. CONCURRENCY=1 reproduces the original strictly-sequential behavior.
  let sessionCursor = 0;
  async function worker() {
    while (!budget.exhausted) {
      const myIdx = sessionCursor++;
      if (myIdx >= sessions.length) break;
      await processSession(sessions[myIdx]);
    }
  }
  const workerCount = Math.max(1, Math.min(HARVEST_CONCURRENCY, sessions.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  // Sessions never claimed because the budget ran out count as deferred.
  for (let k = sessionCursor; k < sessions.length; k++) report.sessionsDeferred++;

  if (!args.dryRun) saveCheckpoint(ckpt);

  // Finalize report
  report.ok = report.errors.length === 0 || report.memoriesInserted > 0;
  if (report.errors.length > 0 && report.memoriesInserted === 0) {
    report.status = report.sessionsProcessed === 0 ? 'noop' : 'partial_error';
  } else if (report.budgetExhausted || report.batchesDeferred > 0 || report.sessionsDeferred > 0) {
    report.status = report.sessionsProcessed === 0 ? 'noop_budget_limited' : 'budget_limited';
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    // Human-readable summary (for cron log)
    const parts = [];
    if (report.sessionsProcessed > 0) parts.push(`${report.sessionsProcessed} sessions`);
    if (report.turnsNew > 0) parts.push(`${report.turnsNew} new turns`);
    if (report.memoriesInserted > 0) parts.push(`${report.memoriesInserted} memories`);
    if (report.narrativesWritten > 0) parts.push(`${report.narrativesWritten} narratives`);
    if (report.workingStateUpdated > 0) parts.push(`WORKING_STATE updated`);
    if (report.errors.length > 0) parts.push(`${report.errors.length} errors`);
    console.log(JSON.stringify({
      ok: report.ok,
      status: report.status,
      job: report.job,
      summary: parts.length ? parts.join(', ') : 'no new turns',
      errors: report.errors,
    }, null, 2));
  }

  await db.pool.end();
}

if (require.main === module) {
  main().catch(err => {
    console.error('[turn-harvester] fatal:', err.message);
    process.exit(1);
  });
}

module.exports = {
  findRecentSessions,
  isTerminalExtractionError,
  isExcludedAgent,
  parseArgs,
  parseSessionTurns,
  buildBatchChunks,
  batchHasSignal,
  updateWorkingState,
  pruneWorkingStateBloat,
  archiveStaleLegacyCurrent,
  buildCurrentBlock,
};
