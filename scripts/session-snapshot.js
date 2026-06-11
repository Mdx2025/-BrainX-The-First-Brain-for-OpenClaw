#!/usr/bin/env node
/**
 * BrainX V5 — Session Snapshot
 *
 * Captures snapshots of recently modified sessions and stores them
 * in brainx_session_snapshots with embeddings for semantic search.
 *
 * Usage:
 *   node scripts/session-snapshot.js [--hours 6] [--max-sessions 10] [--verbose]
 */

const argv = process.argv.slice(2);

function printUsage() {
  console.log(`Usage:
  node scripts/session-snapshot.js [--hours 6] [--max-sessions 10] [--verbose]

Options:
  --hours <n>         Look back this many hours for recently modified sessions
  --max-sessions <n>  Process at most this many sessions
  --verbose           Print progress to stderr
  -h, --help          Show this help message
`);
}

if (argv.includes('--help') || argv.includes('-h')) {
  printUsage();
  process.exit(0);
}

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { isOpsAgent } = require('../lib/ops-agents');

const AGENTS_DIR = path.join(process.env.HOME || '', '.openclaw', 'agents');
const DATA_DIR = path.join(__dirname, '..', 'data');
const TRACKER_FILE = path.join(DATA_DIR, 'snapshotted-sessions.json');

const DATABASE_URL = process.env.DATABASE_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
if (!OPENAI_API_KEY) { console.error('OPENAI_API_KEY is required'); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL });

// --- CLI args ---
function parseArgs() {
  const args = { hours: 6, maxSessions: 10, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--hours') args.hours = parseInt(argv[++i], 10) || 6;
    else if (argv[i] === '--max-sessions') args.maxSessions = parseInt(argv[++i], 10) || 10;
    else if (argv[i] === '--verbose') args.verbose = true;
  }
  return args;
}

// --- Tracker (rotate files monthly) ---
function getTrackerFile() {
  const date = new Date();
  const filename = `snapshots-${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}.json`;
  return path.join(DATA_DIR, filename);
}

function loadTracker() {
  const file = getTrackerFile();
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {}
  return {};
}

function saveTracker(tracker) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(getTrackerFile(), JSON.stringify(tracker, null, 2));
}

// Helper to archive old trackers (optional/manual)
function archiveOldTrackers() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('snapshots-') && f !== path.basename(getTrackerFile()));
  // Keep last 3 months, move others to backups/
  if (files.length > 3) {
    const backupDir = path.join(DATA_DIR, '..', 'backups', 'trackers');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    files.sort().slice(0, files.length - 3).forEach(f => {
      fs.renameSync(path.join(DATA_DIR, f), path.join(backupDir, f));
    });
  }
}

// --- Find recent JSONL session files ---
function findRecentSessions(hoursAgo, maxSessions) {
  const cutoff = Date.now() - hoursAgo * 3600 * 1000;
  const sessions = [];
  if (!fs.existsSync(AGENTS_DIR)) return sessions;

  for (const agent of fs.readdirSync(AGENTS_DIR)) {
    if (isOpsAgent(agent)) continue;
    const sessDir = path.join(AGENTS_DIR, agent, 'sessions');
    if (!fs.existsSync(sessDir)) continue;
    for (const f of fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'))) {
      const full = path.join(sessDir, f);
      const stat = fs.statSync(full);
      if (stat.mtimeMs >= cutoff && stat.size > 200) {
        sessions.push({ agent, sessionId: f.replace('.jsonl', ''), path: full, mtimeMs: stat.mtimeMs });
      }
    }
  }
  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxSessions);
}

// --- Parse a JSONL session file and extract structured info ---
function parseSession(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const info = {
    turnCount: 0,
    sessionStart: null,
    sessionEnd: null,
    project: 'unknown',
    files: new Set(),
    errors: [],
    urls: new Set(),
    blockers: [],
    pendingItems: [],
    assistantTexts: [],
    userTexts: [],
    directives: [],
  };

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    // Track timestamps
    const ts = entry.timestamp || entry.message?.timestamp;
    if (ts) {
      const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
      if (!info.sessionStart || d < info.sessionStart) info.sessionStart = d;
      if (!info.sessionEnd || d > info.sessionEnd) info.sessionEnd = d;
    }

    if (entry.type === 'message' && entry.message) {
      const role = entry.message.role;
      const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
      for (const block of blocks) {
        if (block.type !== 'text' || !block.text) continue;
        const text = block.text;

        if (role === 'assistant') {
          info.turnCount++;
          info.assistantTexts.push(text);
        } else if (role === 'user') {
          info.userTexts.push(text);
          // Capture decisive task directives (imperative orders) so post-rotation
          // recovery snapshots carry "what we were told to do", not just prose.
          // Mirrors the Tier-A imperative signal used by the ACP handoff scorer.
          if (text.length >= 8 && text.length < 600 && /(oculta|ocultar|muestra|mostrar|agrega|agregar|a[ñn]ad|elimina|eliminar|quita|quitar|borra|borrar|mueve|mover|cambia|cambiar|reemplaza|reemplazar|ajusta|ajustar|arregla|arreglar|corrige|corregir|implementa|implementar|crea\b|crear|revert|revierte|revertir|deploy|despliega|sube\b|subir|haz\b|pon\b|usa\b|deja\b|hide\b|show\b|add\b|remove\b|move\b|change\b|fix\b|build\b)/i.test(text)) {
            info.directives.push(text.replace(/\s+/g, ' ').trim().slice(0, 200));
          }
        }

        // Extract file paths (FIX_20260426: previous regex captured URLs like
        // `//127.0.0.1`, `//github.com/foo.git`, `//mintlify.com`, plus path
        // fragments inside URLs like `/Mdx2025/mdx-space.git` from a github
        // URL. Multi-layer filter:
        //   1. Regex: lookbehind no `/`, no `://` directly. Body allows `/`.
        //      Extension must START with a letter (rejects IPs `.0.0.1`,
        //      version tags `.1.2.3`).
        //   2. Reject match preceded (within 30 chars) by `://` — kills the
        //      `https://github.com/Mdx2025/mdx-space.git` case where regex
        //      catches `/Mdx2025/mdx-space.git` after the host.
        //   3. Reject single-segment matches (less than 2 `/`s) — those are
        //      typically host names that lost their protocol.
        const filePathMatches = [...text.matchAll(/(?<![\/])\/(?!\/)[\w./-]+\.[a-zA-Z][\w]{0,9}/g)];
        for (const m of filePathMatches) {
          const fp = m[0];
          if (fp.includes('node_modules') || fp.length > 120) continue;
          if ((fp.match(/\//g) || []).length < 2) continue;
          const prefix = m.index !== undefined && m.index > 0
            ? text.slice(Math.max(0, m.index - 30), m.index)
            : '';
          if (prefix.includes('://')) continue;
          info.files.add(fp);
        }

        // Extract URLs
        const urlMatches = text.match(/https?:\/\/[^\s"'<>\])+]+/g) || [];
        for (const u of urlMatches) info.urls.add(u.replace(/[.,;:)]+$/, ''));

        // Extract errors
        const errMatches = text.match(/(?:error|Error|ERROR|fail|FAIL|exception|Exception)[:\s].{10,120}/g) || [];
        for (const e of errMatches.slice(0, 5)) info.errors.push(e.trim());

        // Extract blockers
        if (/block(?:ed|er|ing)|can'?t proceed|stuck|waiting for/i.test(text)) {
          const snippet = text.slice(0, 200);
          info.blockers.push(snippet);
        }
      }
    }
  }

  // Detect project from content
  const allText = [...info.userTexts, ...info.assistantTexts].join(' ').slice(0, 5000);
  info.project = detectProject(allText);

  return info;
}

// --- Project detection heuristics ---
function detectProject(text) {
  const lower = text.toLowerCase();
  const patterns = [
    { match: /brainx/i, name: 'brainx' },
    { match: /openclaw|clawd|clawma/i, name: 'openclaw' },
    { match: /mdx|closer.?academy|edzaya/i, name: 'mdx' },
    { match: /emailbot|gmail.*autom/i, name: 'emailbot' },
    { match: /notion.*crm|lead.*gen/i, name: 'lead-gen' },
    { match: /railway|deploy/i, name: 'infrastructure' },
  ];
  for (const p of patterns) {
    if (p.match.test(text)) return p.name;
  }
  // Fallback: extract from repo paths
  const repoMatch = text.match(/\/(?:home\/clawd|workspace)[/-](\w[\w-]{2,20})/);
  if (repoMatch) return repoMatch[1];
  return 'general';
}

// --- Summarize a session into a short text ---
function buildSummary(info, agent) {
  const parts = [];
  parts.push(`Agent ${agent} session with ${info.turnCount} turns.`);

  // Front-load the most recent decisive directives so they survive the router's
  // ~360-char snapshot cap — post-rotation recovery needs the orders first.
  if (Array.isArray(info.directives) && info.directives.length > 0) {
    parts.push(`Recent directives: ${info.directives.slice(-3).join(' | ')}`);
  }

  // Use last few assistant texts as summary seed
  const relevant = info.assistantTexts
    .filter(t => t.length > 80 && t.length < 2000)
    .slice(-3);

  if (relevant.length > 0) {
    const combined = relevant.map(t => t.slice(0, 300)).join(' ');
    parts.push(combined.slice(0, 600));
  }

  if (info.errors.length > 0) parts.push(`Errors: ${info.errors.slice(0, 2).join('; ')}`);
  if (info.blockers.length > 0) parts.push(`Blockers: ${info.blockers.slice(0, 2).join('; ')}`);

  return parts.join(' ').slice(0, 1200);
}

// --- Determine session status ---
function detectStatus(info) {
  if (info.blockers.length > 0) return 'blocked';
  if (info.errors.length > 3) return 'blocked';
  if (info.turnCount < 3) return 'paused';
  // Check if the last assistant message signals completion
  const lastMsg = info.assistantTexts[info.assistantTexts.length - 1] || '';
  if (/(?:listo|done|complet|terminado|finished|deployed)/i.test(lastMsg.slice(0, 300))) return 'completed';
  return 'in_progress';
}

// --- Embedding via OpenAI ---
async function embed(text) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text.slice(0, 8000),
      dimensions: 1536,
    }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`Embedding failed: ${res.status} ${msg.slice(0, 200)}`);
  }
  const data = await res.json();
  const vec = data?.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new Error('Invalid embedding response');
  return vec;
}

// --- Insert snapshot into DB ---
async function insertSnapshot(snap) {
  const sql = `
    INSERT INTO brainx_session_snapshots
      (id, project, agent, summary, status, pending_items, blockers,
       last_file_touched, last_error, key_urls, embedding, session_start, session_end, turn_count)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector,$12,$13,$14)
    ON CONFLICT (id) DO UPDATE SET
      summary = EXCLUDED.summary,
      status = EXCLUDED.status,
      pending_items = EXCLUDED.pending_items,
      blockers = EXCLUDED.blockers,
      last_file_touched = EXCLUDED.last_file_touched,
      last_error = EXCLUDED.last_error,
      key_urls = EXCLUDED.key_urls,
      embedding = EXCLUDED.embedding,
      session_end = EXCLUDED.session_end,
      turn_count = EXCLUDED.turn_count
  `;
  await pool.query(sql, [
    snap.id,
    snap.project,
    snap.agent,
    snap.summary,
    snap.status,
    JSON.stringify(snap.pendingItems),
    JSON.stringify(snap.blockers),
    snap.lastFileTouched,
    snap.lastError,
    JSON.stringify(snap.keyUrls),
    JSON.stringify(snap.embedding),
    snap.sessionStart,
    snap.sessionEnd,
    snap.turnCount,
  ]);
}

// --- Main ---
async function main() {
  const args = parseArgs();
  const tracker = loadTracker();
  const sessions = findRecentSessions(args.hours, args.maxSessions);

  const result = { processed: 0, skipped: 0, stored: 0, errors: [] };

  for (const sess of sessions) {
    const trackKey = `${sess.agent}:${sess.sessionId}`;

    // Skip if already snapshotted at this mtime
    if (tracker[trackKey] && tracker[trackKey].mtimeMs >= sess.mtimeMs) {
      result.skipped++;
      continue;
    }

    try {
      const info = parseSession(sess.path);

      // QUALITY FILTERS (added 2026-04-26): the captura layer must reject
      // trivial sessions before they pollute brainx_session_snapshots. The
      // recall side (router LLM) cannot recover from "everything looks the
      // same" once the corpus is contaminated.
      // Three independent gates, any one can reject:
      //   1) Trivial turn count without compensating blocker/error signal.
      //   2) Thin summary (<200 chars after build).
      //   3) No state signal at all (no non-/tmp file, no blocker, no pending,
      //      no error). A session that didn't touch real files and didn't get
      //      blocked is operationally noise.
      const meaningfulErrors = info.errors.filter(e => e && e.length >= 30);
      const nonTmpFiles = [...info.files].filter(f => f && !f.startsWith('/tmp/') && !f.startsWith('/var/tmp/'));
      const hasStateSignal = info.blockers.length > 0
        || info.pendingItems.length > 0
        || meaningfulErrors.length > 0
        || nonTmpFiles.length > 0;

      if (info.turnCount < 5 && info.blockers.length === 0 && meaningfulErrors.length === 0) {
        if (args.verbose) process.stderr.write(`[${sess.agent}] ${sess.sessionId.slice(0, 8)}... skip:trivial_turns (${info.turnCount})\n`);
        result.skipped++;
        continue;
      }

      const summary = buildSummary(info, sess.agent);

      if (summary.length < 200) {
        if (args.verbose) process.stderr.write(`[${sess.agent}] ${sess.sessionId.slice(0, 8)}... skip:thin_summary (${summary.length} chars)\n`);
        result.skipped++;
        continue;
      }

      if (!hasStateSignal) {
        if (args.verbose) process.stderr.write(`[${sess.agent}] ${sess.sessionId.slice(0, 8)}... skip:no_state_signal\n`);
        result.skipped++;
        continue;
      }

      const status = detectStatus(info);
      const snapId = `snap_${Date.now()}_${crypto.createHash('sha256').update(trackKey).digest('hex').slice(0, 8)}`;

      if (args.verbose) process.stderr.write(`[${sess.agent}] ${sess.sessionId.slice(0, 8)}... ${info.turnCount} turns → ${status}\n`);

      // Generate embedding
      const embedding = await embed(summary);

      // Rate limit
      await new Promise(r => setTimeout(r, 300));

      const snapshot = {
        id: snapId,
        project: info.project,
        agent: sess.agent,
        summary,
        status,
        pendingItems: info.pendingItems.slice(0, 10),
        blockers: info.blockers.slice(0, 5),
        // Prefer non-/tmp file (signal); fall back to last seen if none. Filters
        // out PNGs in /tmp etc. that would otherwise become "last file touched".
        lastFileTouched: (nonTmpFiles[nonTmpFiles.length - 1]) || ([...info.files].filter(Boolean).pop()) || null,
        lastError: info.errors[info.errors.length - 1] || null,
        keyUrls: [...info.urls].slice(0, 10),
        embedding,
        sessionStart: info.sessionStart,
        sessionEnd: info.sessionEnd,
        turnCount: info.turnCount,
      };

      await insertSnapshot(snapshot);

      tracker[trackKey] = { mtimeMs: sess.mtimeMs, at: Date.now(), snapId };
      result.stored++;
      result.processed++;
    } catch (err) {
      result.processed++;
      result.errors.push({ session: trackKey, error: (err.message || String(err)).slice(0, 200) });
    }
  }

  saveTracker(tracker);
  await pool.end();

  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
