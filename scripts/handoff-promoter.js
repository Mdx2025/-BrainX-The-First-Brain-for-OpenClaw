#!/usr/bin/env node
/**
 * BrainX V5 — Handoff Promoter
 *
 * Promotes high-signal session snapshots into durable memories and artifact
 * ledger rows. Session snapshots are useful for handoff, but they are not a
 * strong long-term memory surface by themselves; this script extracts the
 * stable user-facing facts from recent snapshots.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const crypto = require('crypto');
const os = require('os');
const db = require('../lib/db');
const { embed } = require('../lib/embedding-client');
const { OPS_AGENT_PATTERN_SOURCE, EXTRA_OPS_AGENTS } = require('../lib/ops-agents');

const DEFAULT_HOURS = 24;
const DEFAULT_LIMIT = 30;
const MAX_MEMORY_CHARS = 900;

function parseArgs() {
  const args = {
    hours: DEFAULT_HOURS,
    limit: DEFAULT_LIMIT,
    dryRun: false,
    json: false,
    verbose: false,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--hours') args.hours = parseInt(argv[++i], 10) || DEFAULT_HOURS;
    else if (arg === '--limit') args.limit = parseInt(argv[++i], 10) || DEFAULT_LIMIT;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--verbose') args.verbose = true;
    else if (arg === '-h' || arg === '--help') {
      console.log(`Usage: node scripts/handoff-promoter.js [--hours 24] [--limit 30] [--dry-run] [--json] [--verbose]`);
      process.exit(0);
    }
  }
  return args;
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function truncate(text, max = MAX_MEMORY_CHARS) {
  const normalized = normalizeText(text);
  if (normalized.length <= max) return normalized;
  return normalized.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripInternalNoise(text) {
  let out = normalizeText(text);
  out = out.replace(/OpenClaw runtime context for the immediately preceding user message[\s\S]*?Keep internal details private\./gi, '');
  out = out.replace(/BrainX mandatory recovery preflight[\s\S]*?(?=\n\n[A-ZÁÉÍÓÚÑa-záéíóúñ¿¡]|$)/gi, '');
  out = out.replace(/\bAgent\s+\w+\s+session\s+with\s+\d+\s+turns\.\s*/gi, '');
  out = out.replace(/\bstatus=(?:blocked|completed|in_progress|paused)\b/gi, '');
  out = out.replace(/\b\d+\s+turns?\b/gi, '');
  out = out.replace(/<\/?think>/gi, '');
  return normalizeText(out);
}

function hasSecretSignal(text) {
  return /\b(password|passwd|contrase(?:ñ|n)a|credenciales?|secret|api[_-]?key|token|bearer|private[_-]?key)\b/i.test(text);
}

function redactSensitiveText(text) {
  return normalizeText(text)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]');
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function artifactKindForPath(filePath) {
  const ext = String(filePath || '').toLowerCase().match(/\.([a-z0-9]{2,8})(?:$|[?#])/i)?.[1] || '';
  if (!ext) return null;
  if (['doc', 'docx', 'pdf', 'ppt', 'pptx', 'xls', 'xlsx', 'csv'].includes(ext)) return 'document';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'webm', 'm4v'].includes(ext)) return 'video';
  if (['zip', 'tar', 'gz'].includes(ext)) return 'archive';
  if (['html', 'txt', 'md'].includes(ext)) return 'deliverable';
  return null;
}

function isDurableArtifactPath(filePath) {
  const p = normalizeText(filePath);
  if (!p || p.length > 220) return false;
  if (p.includes('/node_modules/')) return false;
  if (p.startsWith(path.join(os.homedir(), '.openclaw', 'media'))) return true;
  if (new RegExp('^' + os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/[^/\\s]+\\.[a-zA-Z0-9]{2,8}$').test(p)) return true;
  return false;
}

function extractPaths(text) {
  const matches = [];
  const re = /\/(?:home|tmp)\/[^\s"'`<>),;:]+?\.[a-zA-Z0-9]{2,8}/g;
  for (const match of String(text || '').matchAll(re)) {
    const cleaned = match[0].replace(/[).,;:]+$/, '');
    if (isDurableArtifactPath(cleaned) && artifactKindForPath(cleaned)) matches.push(cleaned);
  }
  return Array.from(new Set(matches)).slice(0, 8);
}

function classifyProjectContext(project) {
  const p = normalizeText(project || 'general').toLowerCase();
  return p && p !== 'unknown' ? `project:${p}` : 'handoff';
}

function buildArtifactFact(snapshot, artifactPath) {
  const cleanSummary = stripInternalNoise(snapshot.summary);
  const publicSummary = hasSecretSignal(cleanSummary) ? '' : redactSensitiveText(cleanSummary);
  const kind = artifactKindForPath(artifactPath) || 'artifact';
  const project = snapshot.project || 'general';
  const agent = snapshot.agent || 'unknown';
  const content = [
    `Handoff artifact for ${agent}/${project}: ${kind} at ${artifactPath}.`,
    publicSummary ? `Relevant session notes: ${truncate(publicSummary, 520)}` : '',
    'Use this path as the durable artifact candidate when the user asks for the prior/final document or file.',
  ].filter(Boolean).join(' ');
  return {
    id: `handoff_artifact_${sha(`${agent}|${project}|${artifactPath}`).slice(0, 24)}`,
    type: 'fact',
    content: truncate(content),
    context: classifyProjectContext(project),
    tier: 'hot',
    agent,
    importance: 9,
    category: 'context',
    tags: ['handoff', 'artifact', `agent:${agent}`, `project:${project}`],
    source_session: snapshot.id,
    source_kind: 'summary_derived',
    source_path: `brainx_session_snapshots:${snapshot.id}`,
    confidence_score: 0.9,
    verification_state: 'verified',
    status: 'promoted',
  };
}

function buildPendingMemory(snapshot, pendingItems) {
  const agent = snapshot.agent || 'unknown';
  const project = snapshot.project || 'general';
  const items = pendingItems
    .map((item) => stripInternalNoise(item))
    .filter((item) => !hasSecretSignal(item))
    .map((item) => redactSensitiveText(item))
    .filter((item) => item.length >= 12)
    .slice(0, 5);
  if (items.length === 0) return null;
  return {
    id: `handoff_pending_${sha(`${agent}|${project}|${items.join('|')}`).slice(0, 24)}`,
    type: 'action',
    content: truncate(`Handoff pending items for ${agent}/${project}: ${items.join('; ')}`),
    context: classifyProjectContext(project),
    tier: 'hot',
    agent,
    importance: 8,
    category: 'context',
    tags: ['handoff', 'pending', `agent:${agent}`, `project:${project}`],
    source_session: snapshot.id,
    source_kind: 'summary_derived',
    source_path: `brainx_session_snapshots:${snapshot.id}`,
    confidence_score: 0.82,
    verification_state: 'verified',
    status: 'in_progress',
  };
}

function summaryHasDecisionSignal(summary) {
  return /\b(decid(?:i[oó]|imos|ed)|decision|se queda|qued[oó]|final|aprobad|actualizad|reemplaz|eliminad|added|removed|updated|pricing|precios?|tiers?|link|calendly|schedule)\b/i.test(summary);
}

function buildSummaryMemory(snapshot) {
  const cleanSummary = stripInternalNoise(snapshot.summary);
  if (cleanSummary.length < 120) return null;
  if (hasSecretSignal(cleanSummary)) return null;
  const publicSummary = redactSensitiveText(cleanSummary);
  if (!summaryHasDecisionSignal(publicSummary) && !snapshot.last_file_touched) return null;
  const agent = snapshot.agent || 'unknown';
  const project = snapshot.project || 'general';
  return {
    id: `handoff_summary_${sha(`${agent}|${project}|${publicSummary.slice(0, 420)}`).slice(0, 24)}`,
    type: 'fact',
    content: truncate(`Handoff summary for ${agent}/${project}: ${publicSummary}`),
    context: classifyProjectContext(project),
    tier: 'hot',
    agent,
    importance: snapshot.last_file_touched ? 8 : 7,
    category: 'context',
    tags: ['handoff', 'summary', `agent:${agent}`, `project:${project}`],
    source_session: snapshot.id,
    source_kind: 'summary_derived',
    source_path: `brainx_session_snapshots:${snapshot.id}`,
    confidence_score: 0.82,
    verification_state: 'verified',
    status: 'promoted',
  };
}

async function insertMemory(memory, dryRun) {
  if (dryRun) return { id: memory.id, dryRun: true };
  const existing = await db.query(
    `SELECT content FROM brainx_memories WHERE id = $1 LIMIT 1`,
    [memory.id],
  );
  if (existing.rows?.[0]?.content === memory.content) {
    await db.query(
      `UPDATE brainx_memories
          SET importance = GREATEST(importance, $2),
              tags = (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags, ARRAY[]::text[]) || $3::text[]))),
              last_seen = NOW()
        WHERE id = $1`,
      [memory.id, memory.importance, memory.tags],
    );
    return { id: memory.id, dryRun: false, reused: true };
  }
  const embedding = await embed(memory.content);
  // BRAINX_DEDUP_NULL_EMBED_GUARD_20260702: write the ACTIVE calibration column —
  // this INSERT hardcoded the legacy `embedding` column, so since the Gemini switch
  // (embedding_v2 active) handoff rows were recall-invisible AND, worse, poisoned the
  // dedup probes (NULL similarity sorts FIRST under ORDER BY ... DESC in Postgres).
  const embedCol = require('../lib/recall-calibration').activeColumn();
  await db.query(
    `INSERT INTO brainx_memories (
       id, type, content, context, tier, agent, importance, ${embedCol}, tags,
       status, category, source_session, source_kind, source_path,
       confidence_score, sensitivity, verification_state, first_seen, last_seen
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),NOW())
     ON CONFLICT (id) DO UPDATE SET
       content = EXCLUDED.content,
       tier = EXCLUDED.tier,
       importance = GREATEST(brainx_memories.importance, EXCLUDED.importance),
       tags = (SELECT ARRAY(SELECT DISTINCT unnest(brainx_memories.tags || EXCLUDED.tags))),
       status = EXCLUDED.status,
       category = EXCLUDED.category,
       source_session = COALESCE(brainx_memories.source_session, EXCLUDED.source_session),
       source_kind = COALESCE(EXCLUDED.source_kind, brainx_memories.source_kind),
       source_path = COALESCE(EXCLUDED.source_path, brainx_memories.source_path),
       confidence_score = GREATEST(COALESCE(brainx_memories.confidence_score, 0), COALESCE(EXCLUDED.confidence_score, 0)),
       verification_state = COALESCE(EXCLUDED.verification_state, brainx_memories.verification_state),
       last_seen = NOW()`,
    [
      memory.id,
      memory.type,
      memory.content,
      memory.context,
      memory.tier,
      memory.agent,
      memory.importance,
      JSON.stringify(embedding),
      memory.tags,
      memory.status,
      memory.category,
      memory.source_session,
      memory.source_kind,
      memory.source_path,
      memory.confidence_score,
      'normal',
      memory.verification_state,
    ],
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  return { id: memory.id, dryRun: false };
}

async function ensureArtifactLedger() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS brainx_artifact_ledger (
      id TEXT PRIMARY KEY,
      agent TEXT,
      session_key TEXT,
      session_id TEXT,
      artifact_path TEXT NOT NULL,
      artifact_kind TEXT,
      artifact_role TEXT DEFAULT 'artifact',
      summary TEXT,
      source TEXT,
      project_key TEXT,
      provenance TEXT,
      finality_score REAL DEFAULT 0.5,
      metadata JSONB DEFAULT '{}'::jsonb,
      seen_count INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (agent, session_key, artifact_path)
    )
  `);
  await db.query(`ALTER TABLE brainx_artifact_ledger ADD COLUMN IF NOT EXISTS artifact_role TEXT DEFAULT 'artifact'`);
  await db.query(`ALTER TABLE brainx_artifact_ledger ADD COLUMN IF NOT EXISTS project_key TEXT`);
  await db.query(`ALTER TABLE brainx_artifact_ledger ADD COLUMN IF NOT EXISTS provenance TEXT`);
  await db.query(`ALTER TABLE brainx_artifact_ledger ADD COLUMN IF NOT EXISTS finality_score REAL DEFAULT 0.5`);
  await db.query(`ALTER TABLE brainx_artifact_ledger ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb`);
}

async function upsertArtifact(snapshot, artifactPath, dryRun) {
  const agent = snapshot.agent || null;
  const id = `handoff_art_${sha(`${agent || ''}|${artifactPath}`).slice(0, 24)}`;
  const summary = truncate(stripInternalNoise(snapshot.summary), 300);
  if (dryRun) return { id, artifactPath, dryRun: true };
  await ensureArtifactLedger();
  await db.query(
    `INSERT INTO brainx_artifact_ledger
       (id, agent, session_key, session_id, artifact_path, artifact_kind, artifact_role, summary, source, provenance, finality_score, metadata)
     VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       artifact_kind = EXCLUDED.artifact_kind,
       artifact_role = EXCLUDED.artifact_role,
       summary = EXCLUDED.summary,
       source = EXCLUDED.source,
       provenance = EXCLUDED.provenance,
       finality_score = GREATEST(COALESCE(brainx_artifact_ledger.finality_score, 0), EXCLUDED.finality_score),
       metadata = COALESCE(brainx_artifact_ledger.metadata, '{}'::jsonb) || EXCLUDED.metadata,
       seen_count = brainx_artifact_ledger.seen_count + 1,
       last_seen = NOW()`,
    [
      id,
      agent,
      snapshot.id,
      artifactPath,
      artifactKindForPath(artifactPath),
      'final_deliverable',
      summary,
      'handoff-promoter',
      'promoted_handoff',
      0.95,
      JSON.stringify({ promoted_from_snapshot: snapshot.id, project: snapshot.project || null }),
    ],
  );
  return { id, artifactPath, dryRun: false };
}

async function loadSnapshots(args) {
  // OPS_PATTERN_20260503: exclude ops agents by regex + the env-supplied extra
  // list, plus the local 'heartbeat' override that handoff-promoter has always
  // skipped. Pattern source is empty-safe: `^$` matches only the empty string,
  // so disabling the pattern still leaves the extra-list filter active.
  const pattern = OPS_AGENT_PATTERN_SOURCE || '^$';
  const extraOps = [...EXTRA_OPS_AGENTS, 'heartbeat'];
  const result = await db.query(
    `SELECT id, project, agent, summary, status, pending_items, blockers,
            last_file_touched, last_error, key_urls, session_start, session_end, turn_count
       FROM brainx_session_snapshots
     WHERE session_end > NOW() - ($1::text)::interval
        AND NOT (agent ~* $3)
        AND agent <> ALL($4::text[])
      ORDER BY session_end DESC
      LIMIT $2`,
    [`${Math.max(1, args.hours)} hours`, Math.max(1, args.limit), pattern, extraOps],
  );
  return result.rows || [];
}

function buildPromotionPlan(snapshot) {
  const cleanSummary = stripInternalNoise(snapshot.summary);
  const paths = new Set();
  if (isDurableArtifactPath(snapshot.last_file_touched || '') && artifactKindForPath(snapshot.last_file_touched)) {
    paths.add(snapshot.last_file_touched);
  }
  for (const p of extractPaths(cleanSummary)) paths.add(p);

  const memories = [];
  for (const artifactPath of paths) {
    memories.push(buildArtifactFact(snapshot, artifactPath));
  }
  const pending = buildPendingMemory(snapshot, asArray(snapshot.pending_items));
  if (pending) memories.push(pending);
  const summaryMemory = buildSummaryMemory({ ...snapshot, summary: cleanSummary });
  if (summaryMemory) memories.push(summaryMemory);

  return {
    artifacts: Array.from(paths),
    memories: dedupeMemories(memories),
  };
}

function dedupeMemories(memories) {
  const seen = new Set();
  const out = [];
  for (const memory of memories.filter(Boolean)) {
    if (seen.has(memory.id)) continue;
    seen.add(memory.id);
    out.push(memory);
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const snapshots = await loadSnapshots(args);
  const output = {
    ok: true,
    dryRun: args.dryRun,
    scanned: snapshots.length,
    promotedMemories: 0,
    upsertedArtifacts: 0,
    skipped: 0,
    errors: [],
    items: [],
  };

  for (const snapshot of snapshots) {
    try {
      const plan = buildPromotionPlan(snapshot);
      if (plan.artifacts.length === 0 && plan.memories.length === 0) {
        output.skipped++;
        continue;
      }

      for (const artifactPath of plan.artifacts) {
        const artifact = await upsertArtifact(snapshot, artifactPath, args.dryRun);
        output.upsertedArtifacts++;
        if (args.verbose) output.items.push({ kind: 'artifact', snapshot: snapshot.id, id: artifact.id, path: artifactPath });
      }

      for (const memory of plan.memories) {
        const inserted = await insertMemory(memory, args.dryRun);
        output.promotedMemories++;
        if (args.verbose) output.items.push({ kind: 'memory', snapshot: snapshot.id, id: inserted.id, type: memory.type, content: memory.content.slice(0, 160) });
      }
    } catch (error) {
      output.errors.push({ snapshot: snapshot.id, error: (error.message || String(error)).slice(0, 240) });
    }
  }

  if (output.errors.length > 0) output.ok = false;
  await db.pool.end();

  console.log(JSON.stringify(output, null, 2));
  if (output.errors.length > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  try { await db.pool.end(); } catch {}
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
