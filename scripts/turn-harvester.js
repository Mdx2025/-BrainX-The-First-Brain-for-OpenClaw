#!/usr/bin/env node
'use strict';
// BRAINX_TURN_HARVESTER_20260609
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

// ── Config ────────────────────────────────────────────────────────────────────

const HOME = process.env.HOME || '/home/clawd';
const OPENCLAW_DIR = path.join(HOME, '.openclaw');
const AGENTS_DIR = path.join(OPENCLAW_DIR, 'agents');
const DATA_DIR = path.join(__dirname, '..', 'data');

const DEFAULT_HOURS = parseInt(process.env.TURN_HARVESTER_HOURS || '1', 10);
const BATCH_SIZE = parseInt(process.env.TURN_HARVESTER_BATCH_SIZE || '8', 10);
const MAX_SESSIONS = parseInt(process.env.TURN_HARVESTER_MAX_SESSIONS || '15', 10);
const MAX_TURN_CHARS = 600; // per turn before truncation
const MAX_BATCH_CHARS = 6000; // guard against huge batches
// MiniMax-M3 (brainx-reviewer) measured at ~80-160s per extraction call, so the
// old fixed 120s killed the majority of calls. Floor at 240s; env-overridable.
const LLM_TIMEOUT_MS = parseInt(process.env.TURN_HARVESTER_LLM_TIMEOUT_MS || '240000', 10);

// ── Args ──────────────────────────────────────────────────────────────────────

function parseArgs() {
  const argv = process.argv.slice(2);
  const args = {
    hours: DEFAULT_HOURS,
    dryRun: false,
    verbose: false,
    json: false,
    agent: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hours') args.hours = parseInt(argv[++i], 10) || DEFAULT_HOURS;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--json') args.json = true;
    else if (a === '--agent') args.agent = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node scripts/turn-harvester.js [--hours 1] [--dry-run] [--verbose] [--json] [--agent <id>]');
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

function findRecentSessions(hoursAgo, agentFilter) {
  const cutoff = Date.now() - hoursAgo * 3600 * 1000;
  const sessions = [];
  if (!fs.existsSync(AGENTS_DIR)) return sessions;

  for (const agent of fs.readdirSync(AGENTS_DIR)) {
    if (isOpsAgent(agent)) continue;
    if (agentFilter && agent !== agentFilter) continue;
    const sessDir = path.join(AGENTS_DIR, agent, 'sessions');
    if (!fs.existsSync(sessDir)) continue;
    for (const f of fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl') && !f.includes('.trajectory'))) {
      const full = path.join(sessDir, f);
      let stat;
      try { stat = fs.statSync(full); } catch (_) { continue; }
      if (stat.mtimeMs >= cutoff && stat.size > 200) {
        sessions.push({
          agent,
          sessionId: f.replace('.jsonl', ''),
          filePath: full,
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  }
  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_SESSIONS);
}

// ── JSONL Parse ───────────────────────────────────────────────────────────────

function parseSessionTurns(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (_) { return []; }
  const turns = [];
  for (const line of raw.split('\n').filter(Boolean)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'message' || !entry.message) continue;
    const role = entry.message.role;
    if (!['user', 'assistant'].includes(role)) continue;
    const content = entry.message.content;
    const texts = [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          texts.push(block.text);
        } else if (block.type === 'tool_result' || block.type === 'tool_use') {
          // Capture tool names for context but not full output
          const name = block.name || block.tool_use_id || '';
          if (name) texts.push(`[tool:${name}]`);
        }
      }
    } else if (typeof content === 'string') {
      texts.push(content);
    }
    if (!texts.length) continue;
    const ts = entry.timestamp || null;
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

const EXTRACT_SYSTEM = `You are BrainX's memory extraction engine. You receive raw conversation turns from an AI agent session.

Your job: extract ONLY what is worth remembering long-term. Be conservative — not every turn is worth remembering.

Return a JSON object with these keys (no markdown, no explanation):
{
  "memories": [
    {
      "content": "concise fact/decision/gotcha (max 180 chars)",
      "type": "fact|decision|gotcha|learning",
      "tier": "hot|warm|cold",
      "importance": 1-10,
      "tags": ["tag1", "tag2"],
      "context": "openclaw:session|project:<slug>|<domain>"
    }
  ],
  "narrative": "1-2 sentence summary of what happened (for daily log). Empty string if nothing notable.",
  "active_state": {
    "current": "what is being actively worked on right now (1 sentence)",
    "open_threads": ["thread1", "thread2"],
    "ids": ["PR#123", "branch: feature/x", "SHA: abc123"],
    "next_steps": "what should happen next"
  }
}

Rules:
- "memories": only include if genuinely reusable across future sessions. Max 5 per batch.
- "narrative": max 3 sentences. Empty string if the turns are just boilerplate/noise.
- "active_state": only populate if there is a clearly ACTIVE task (a branch being worked, an open PR, a blocker).
  Set to null if no active task is evident.
- Never include secrets, API keys, tokens, passwords in any field.
- Never fabricate. If uncertain, omit.`;

// Retry transient LLM failures (MiniMax-M3 portal latency/load can exceed the
// per-call timeout). A persistent failure still throws after the retries are
// exhausted, so the caller opens a checkpoint gap and retries the batch next run.
const LLM_RETRY_BACKOFF_MS = [3000, 8000];
async function withLlmRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const transient = /AGENT_LLM_TIMEOUT|AGENT_LLM_FAIL|AGENT_LLM_STATUS|LLM_CALL_FAILED|LLM_NO_JSON|LLM_JSON_PARSE/.test(err.message || '');
      if (!transient || attempt >= LLM_RETRY_BACKOFF_MS.length) throw err;
      await new Promise((r) => setTimeout(r, LLM_RETRY_BACKOFF_MS[attempt]));
    }
  }
}

async function extractInsights(turns, agentId, sessionId) {
  if (!turns.length) return null;

  // Build the batch text
  const chunks = [];
  let totalChars = 0;
  for (const turn of turns) {
    const snippet = `[${turn.role}]: ${turn.text.slice(0, MAX_TURN_CHARS)}`;
    if (totalChars + snippet.length > MAX_BATCH_CHARS) break;
    chunks.push(snippet);
    totalChars += snippet.length;
  }
  if (!chunks.length) return null;

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
    return JSON.parse(match[0]);
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

async function insertMemory(item, agentId, sessionId, dryRun) {
  const content = String(item.content || '').trim().slice(0, 900);
  if (!content || content.length < 10) return null;

  // Basic secret guard
  if (/\b(password|secret|api[_-]?key|bearer|private[_-]?key|token=)\b/i.test(content)) return null;

  const id = memoryId(content, agentId, sessionId);
  const type = ['fact', 'decision', 'gotcha', 'learning'].includes(item.type) ? item.type : 'fact';
  const tier = ['hot', 'warm', 'cold'].includes(item.tier) ? item.tier : 'warm';
  const importance = Math.min(10, Math.max(1, parseInt(item.importance, 10) || 5));
  const tags = ['turn_harvester', ...(Array.isArray(item.tags) ? item.tags.slice(0, 7) : [])];
  const context = String(item.context || 'openclaw:session').slice(0, 80);

  if (dryRun) return { id, content, type, tier, importance, tags, context, dryRun: true };

  const embedding = await embed(content);
  await db.query(
    `INSERT INTO brainx_memories (
       id, type, content, context, tier, agent, importance, embedding, tags,
       status, category, source_session, source_kind,
       confidence_score, sensitivity, verification_state, first_seen, last_seen
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector,$9,$10,$11,$12,$13,$14,$15,$16,NOW(),NOW())
     ON CONFLICT (id) DO UPDATE SET
       last_seen = NOW(),
       importance = GREATEST(brainx_memories.importance, EXCLUDED.importance)`,
    [
      id, type, content, context, tier, agentId, importance,
      JSON.stringify(embedding), tags,
      'pending', null, sessionId, 'agent_inference',
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

function updateWorkingState(workspaceDir, activeState, agentId, dryRun) {
  if (!activeState || !activeState.current) return false;
  const wsFile = path.join(workspaceDir, 'WORKING_STATE.md');
  if (!fs.existsSync(wsFile)) return false;

  let content;
  try { content = fs.readFileSync(wsFile, 'utf8'); } catch (_) { return false; }

  const ts = new Date().toISOString();
  const ids = Array.isArray(activeState.ids) && activeState.ids.length
    ? activeState.ids.map(id => `- ${id}`).join('\n')
    : '- None';
  const threads = Array.isArray(activeState.open_threads) && activeState.open_threads.length
    ? activeState.open_threads.map(t => `- ${t}`).join('\n')
    : '- None';

  // Only update if the current state is essentially empty (don't overwrite manual updates)
  const isDefaultState = /No active durable task state recorded yet/.test(content) ||
    /Not verified yet/.test(content);
  if (!isDefaultState) return false; // human-managed state, skip

  const newContent = content
    .replace(/## Current[\s\S]*?(?=## Open Threads|## Decisions|## IDs|## Last Verified|## Protocol)/,
      `## Current\n\n- ${activeState.current} _(auto-captured by turn-harvester ${ts})_\n\n`)
    .replace(/## Open Threads[\s\S]*?(?=## Decisions|## IDs|## Last Verified|## Protocol)/,
      `## Open Threads\n\n${threads}\n\n`)
    .replace(/## IDs \/ Refs[\s\S]*?(?=## Last Verified|## Protocol)/,
      `## IDs / Refs\n\n${ids}\n\n`)
    .replace(/## Last Verified[\s\S]*?(?=## Protocol)/,
      `## Last Verified\n\n- ${ts} (turn-harvester auto-write)\n\n`);

  if (dryRun) return true;
  fs.writeFileSync(wsFile, newContent);
  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const ckpt = loadCheckpoint();
  const sessions = findRecentSessions(args.hours, args.agent);

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
    errors: [],
  };

  if (args.verbose) console.error(`[turn-harvester] sessions found: ${sessions.length}`);

  for (const sess of sessions) {
    const { agent, sessionId, filePath } = sess;
    const ckptKey = `${agent}:${sessionId}`;
    const lastProcessed = ckpt[ckptKey]?.lastTurnIndex ?? -1;

    const allTurns = parseSessionTurns(filePath);
    const newTurns = allTurns.slice(lastProcessed + 1);

    if (!newTurns.length) {
      if (args.verbose) console.error(`[turn-harvester] ${ckptKey}: no new turns`);
      continue;
    }

    report.turnsNew += newTurns.length;
    if (args.verbose) console.error(`[turn-harvester] ${ckptKey}: ${newTurns.length} new turns`);

    // Process in batches. Track a CONTIGUOUS high-water mark (okThroughTurn): the
    // checkpoint may only advance over batches that all succeeded IN ORDER. The
    // first batch that fails (after retries) opens a gap — we stop advancing the
    // watermark so those turns are retried on the next run instead of being
    // silently skipped (the old code advanced past failed batches, losing them).
    let okThroughTurn = lastProcessed;
    let gapHit = false;
    for (let i = 0; i < newTurns.length; i += BATCH_SIZE) {
      const batch = newTurns.slice(i, i + BATCH_SIZE);
      // Absolute index of this batch's last turn (newTurns[0] === lastProcessed+1).
      const batchEnd = lastProcessed + Math.min(i + BATCH_SIZE, newTurns.length);
      let insights;
      try {
        insights = await withLlmRetry(() => extractInsights(batch, agent, sessionId));
      } catch (err) {
        report.errors.push({ session: ckptKey, error: err.message });
        if (args.verbose) console.error(`[turn-harvester] LLM error for ${ckptKey} (batch @${i}): ${err.message}`);
        gapHit = true; // open a gap — do not advance the watermark past here
        continue;
      }

      // Empty extraction is a valid "nothing worth remembering" result, not a
      // failure: advance the watermark (still contiguous) and move on.
      if (!insights) {
        if (!gapHit) okThroughTurn = batchEnd;
        continue;
      }

      // 1. Insert memories into DB
      const mems = Array.isArray(insights.memories) ? insights.memories : [];
      for (const item of mems.slice(0, 5)) {
        try {
          const result = await insertMemory(item, agent, sessionId, args.dryRun);
          if (result) {
            report.memoriesInserted++;
            if (args.verbose) console.error(`[turn-harvester] memory: ${result.content?.slice(0, 60)}...`);
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

      // Batch fully processed — advance the contiguous watermark (DB inserts are
      // idempotent via memoryId + ON CONFLICT, so an item-level insert skip above
      // does not open a gap; only an LLM-extraction failure does).
      if (!gapHit) okThroughTurn = batchEnd;
    }

    // Advance the checkpoint only over the contiguous successful prefix. Failed
    // batches (gapHit) stay un-checkpointed so the next run retries them instead
    // of losing their extractions.
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

  if (!args.dryRun) saveCheckpoint(ckpt);

  // Finalize report
  report.ok = report.errors.length === 0 || report.memoriesInserted > 0;
  if (report.errors.length > 0 && report.memoriesInserted === 0) {
    report.status = report.sessionsProcessed === 0 ? 'noop' : 'partial_error';
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

main().catch(err => {
  console.error('[turn-harvester] fatal:', err.message);
  process.exit(1);
});
