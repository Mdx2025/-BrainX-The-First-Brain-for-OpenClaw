#!/usr/bin/env node
/**
 * BrainX Event Ledger
 *
 * Deterministic forensic index for important fixes, incidents, decisions,
 * deployments, handoffs, and audits. This complements brainx_memories:
 * memories answer "what is semantically relevant?", events answer
 * "what happened, when, where, with which evidence?".
 */

require('dotenv').config({
  path: require('path').join(__dirname, '..', '.env'),
  override: true,
  quiet: true,
});

const crypto = require('crypto');
const db = require('../lib/db');
const { embed } = require('../lib/embedding-client');

const DEFAULT_LIMIT = 20;
const DEFAULT_CONFIDENCE = 0.75;
const VALID_TYPES = new Set(['fix', 'bug', 'decision', 'incident', 'handoff', 'deployment', 'audit', 'note']);
const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);
const VALID_STATUSES = new Set(['open', 'in_progress', 'fixed', 'validated', 'superseded', 'wont_fix']);

function usage() {
  console.log(`brainx event

Commands:
  event init [--json]
      Create/upgrade the brainx_event_ledger table.

  event add --type <fix|bug|decision|incident|handoff|deployment|audit|note> --title <text> --summary <text>
      [--occurred-at <iso>] [--project <key>] [--domain <name>] [--severity <level>]
      [--agent <name>] [--runtime-family <name>] [--session-key <key>] [--session-id <id>]
      [--root-cause <text>] [--action-taken <text>] [--outcome <text>]
      [--status <open|in_progress|fixed|validated|superseded|wont_fix>] [--confidence <0-1>]
      [--source-kind <kind>] [--source-path <path>] [--related-id <id>] [--file <path>]
      [--command <command>] [--tag <tag>] [--metadata <json>] [--id <id>] [--no-embed] [--json]

  event search [--query <text>] [--project <key>] [--domain <name>] [--type <type>]
      [--status <status>] [--agent <name>] [--tag <tag>] [--from <iso|date>] [--to <iso|date>]
      [--limit <n>] [--min-similarity <0-1>] [--no-semantic] [--json]

  event timeline [--project <key>] [--domain <name>] [--from <iso|date>] [--to <iso|date>]
      [--month <yyyy-mm>] [--type <type>] [--status <status>] [--limit <n>] [--json]

  event show --id <event_id> [--json]
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    const value = !next || next.startsWith('--') ? true : next;
    if (value !== true) i += 1;
    if (args[key] === undefined) args[key] = value;
    else if (Array.isArray(args[key])) args[key].push(value);
    else args[key] = [args[key], value];
  }
  return args;
}

function getArg(args, ...keys) {
  for (const key of keys) {
    if (args[key] !== undefined) return args[key];
  }
  return undefined;
}

function asArray(value) {
  if (value === undefined || value === null || value === true) return [];
  return Array.isArray(value) ? value : [value];
}

function splitList(value) {
  return asArray(value)
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}

function collectList(args, repeatedKey, csvKey) {
  return Array.from(new Set([...splitList(args[repeatedKey]), ...splitList(args[csvKey])]));
}

function parseJson(value, fallback, label) {
  if (value === undefined || value === null || value === true || value === '') return fallback;
  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new Error(`Invalid JSON for ${label}: ${error.message}`);
  }
}

function parseIntArg(value, fallback) {
  if (value === undefined || value === null || value === true || value === '') return fallback;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer: ${value}`);
  return n;
}

function parseFloatArg(value, fallback) {
  if (value === undefined || value === null || value === true || value === '') return fallback;
  const n = parseFloat(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid number: ${value}`);
  return n;
}

function parseTimestamp(value, fallback = null) {
  if (!value) return fallback;
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid timestamp: ${value}`);
  return date.toISOString();
}

function validateEnum(value, allowed, label) {
  if (!allowed.has(value)) {
    throw new Error(`Invalid ${label}: ${value}. Allowed: ${Array.from(allowed).join(', ')}`);
  }
  return value;
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function scrubText(value) {
  return normalizeText(value)
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [REDACTED]')
    .replace(/\b(api[_-]?key|token|secret|password|passwd)\b\s*[:=]\s*["']?[^"'\s,;]{6,}/gi, '$1=[REDACTED]');
}

function scrubList(values) {
  return values.map(scrubText).filter(Boolean);
}

function compactDateForId(iso) {
  return String(iso).replace(/[^\d]/g, '').slice(0, 14) || String(Date.now());
}

function buildId(event) {
  if (event.id) return event.id;
  const key = [
    event.occurred_at,
    event.event_type,
    event.project_key || '',
    event.domain || '',
    event.title,
  ].join('|');
  return `evt_${compactDateForId(event.occurred_at)}_${sha(key).slice(0, 12)}`;
}

function buildEmbeddingText(event) {
  return [
    `type: ${event.event_type}`,
    event.project_key ? `project: ${event.project_key}` : '',
    event.domain ? `domain: ${event.domain}` : '',
    event.agent ? `agent: ${event.agent}` : '',
    `title: ${event.title}`,
    `summary: ${event.summary}`,
    event.root_cause ? `root cause: ${event.root_cause}` : '',
    event.action_taken ? `action taken: ${event.action_taken}` : '',
    event.outcome ? `outcome: ${event.outcome}` : '',
    event.tags.length ? `tags: ${event.tags.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

function normalizeEvent(args) {
  const eventType = String(getArg(args, 'type') || '').trim().toLowerCase();
  const title = scrubText(getArg(args, 'title'));
  const summary = scrubText(getArg(args, 'summary'));
  if (!eventType) throw new Error('--type is required');
  if (!title) throw new Error('--title is required');
  if (!summary) throw new Error('--summary is required');

  const occurredAt = parseTimestamp(getArg(args, 'occurred-at', 'occurredAt'), new Date().toISOString());
  const severity = String(getArg(args, 'severity') || 'info').trim().toLowerCase();
  const status = String(getArg(args, 'status') || 'open').trim().toLowerCase();
  const confidence = parseFloatArg(getArg(args, 'confidence'), DEFAULT_CONFIDENCE);
  if (confidence < 0 || confidence > 1) throw new Error('--confidence must be between 0 and 1');

  const relatedIds = collectList(args, 'related-id', 'related-ids');
  const filesTouched = collectList(args, 'file', 'files');
  const commandsRun = collectList(args, 'command', 'commands');
  const tags = collectList(args, 'tag', 'tags')
    .map((tag) => tag.toLowerCase())
    .filter(Boolean);
  const metadata = parseJson(getArg(args, 'metadata'), {}, '--metadata');
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('--metadata must be a JSON object');
  }

  const event = {
    id: getArg(args, 'id') || null,
    occurred_at: occurredAt,
    event_type: validateEnum(eventType, VALID_TYPES, '--type'),
    severity: validateEnum(severity, VALID_SEVERITIES, '--severity'),
    project_key: scrubText(getArg(args, 'project', 'project-key', 'projectKey')) || null,
    domain: scrubText(getArg(args, 'domain')) || null,
    agent: scrubText(getArg(args, 'agent')) || null,
    runtime_family: scrubText(getArg(args, 'runtime-family', 'runtimeFamily')) || null,
    session_key: scrubText(getArg(args, 'session-key', 'sessionKey')) || null,
    session_id: scrubText(getArg(args, 'session-id', 'sessionId')) || null,
    title,
    summary,
    root_cause: scrubText(getArg(args, 'root-cause', 'rootCause')) || null,
    action_taken: scrubText(getArg(args, 'action-taken', 'actionTaken')) || null,
    outcome: scrubText(getArg(args, 'outcome')) || null,
    status: validateEnum(status, VALID_STATUSES, '--status'),
    confidence,
    source_kind: scrubText(getArg(args, 'source-kind', 'sourceKind')) || 'manual',
    source_path: scrubText(getArg(args, 'source-path', 'sourcePath')) || null,
    related_ids: scrubList(relatedIds),
    files_touched: scrubList(filesTouched),
    commands_run: scrubList(commandsRun),
    tags: Array.from(new Set(tags)),
    metadata,
  };
  event.id = buildId(event);
  return event;
}

async function ensureSchema() {
  await db.query('CREATE EXTENSION IF NOT EXISTS vector');
  await db.query(`
    CREATE TABLE IF NOT EXISTS brainx_event_ledger (
      id TEXT PRIMARY KEY,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      project_key TEXT,
      domain TEXT,
      agent TEXT,
      runtime_family TEXT,
      session_key TEXT,
      session_id TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      root_cause TEXT,
      action_taken TEXT,
      outcome TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      confidence REAL NOT NULL DEFAULT 0.75,
      source_kind TEXT NOT NULL DEFAULT 'manual',
      source_path TEXT,
      related_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      files_touched JSONB NOT NULL DEFAULT '[]'::jsonb,
      commands_run JSONB NOT NULL DEFAULT '[]'::jsonb,
      tags TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      embedding vector
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS brainx_event_ledger_occurred_idx ON brainx_event_ledger (occurred_at DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS brainx_event_ledger_project_domain_idx ON brainx_event_ledger (project_key, domain, occurred_at DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS brainx_event_ledger_type_status_idx ON brainx_event_ledger (event_type, status, occurred_at DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS brainx_event_ledger_agent_idx ON brainx_event_ledger (agent, occurred_at DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS brainx_event_ledger_tags_gin_idx ON brainx_event_ledger USING GIN (tags)');
  await db.query('CREATE INDEX IF NOT EXISTS brainx_event_ledger_metadata_gin_idx ON brainx_event_ledger USING GIN (metadata)');
}

async function maybeEmbedEvent(event, args) {
  if (args['no-embed'] || args.noEmbed) return { embedding: null, embedded: false, embedError: null };
  try {
    const vector = await embed(buildEmbeddingText(event));
    return { embedding: vector, embedded: true, embedError: null };
  } catch (error) {
    return { embedding: null, embedded: false, embedError: error.message || String(error) };
  }
}

async function cmdInit(args) {
  await ensureSchema();
  const result = await db.query(`SELECT COUNT(*)::int AS count FROM brainx_event_ledger`);
  const payload = { ok: true, table: 'brainx_event_ledger', count: result.rows[0]?.count ?? 0 };
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else console.log(`brainx_event_ledger ready (${payload.count} events)`);
}

async function cmdAdd(args) {
  await ensureSchema();
  const event = normalizeEvent(args);
  const embedded = await maybeEmbedEvent(event, args);

  await db.query(
    `INSERT INTO brainx_event_ledger (
       id, occurred_at, event_type, severity, project_key, domain, agent, runtime_family,
       session_key, session_id, title, summary, root_cause, action_taken, outcome,
       status, confidence, source_kind, source_path, related_ids, files_touched,
       commands_run, tags, metadata, embedding
     )
     VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
       $20::jsonb,$21::jsonb,$22::jsonb,$23::text[],$24::jsonb,$25::vector
     )
     ON CONFLICT (id) DO UPDATE SET
       occurred_at = EXCLUDED.occurred_at,
       recorded_at = NOW(),
       event_type = EXCLUDED.event_type,
       severity = EXCLUDED.severity,
       project_key = EXCLUDED.project_key,
       domain = EXCLUDED.domain,
       agent = EXCLUDED.agent,
       runtime_family = EXCLUDED.runtime_family,
       session_key = EXCLUDED.session_key,
       session_id = EXCLUDED.session_id,
       title = EXCLUDED.title,
       summary = EXCLUDED.summary,
       root_cause = EXCLUDED.root_cause,
       action_taken = EXCLUDED.action_taken,
       outcome = EXCLUDED.outcome,
       status = EXCLUDED.status,
       confidence = EXCLUDED.confidence,
       source_kind = EXCLUDED.source_kind,
       source_path = EXCLUDED.source_path,
       related_ids = EXCLUDED.related_ids,
       files_touched = EXCLUDED.files_touched,
       commands_run = EXCLUDED.commands_run,
       tags = EXCLUDED.tags,
       metadata = EXCLUDED.metadata,
       embedding = COALESCE(EXCLUDED.embedding, brainx_event_ledger.embedding)`,
    [
      event.id,
      event.occurred_at,
      event.event_type,
      event.severity,
      event.project_key,
      event.domain,
      event.agent,
      event.runtime_family,
      event.session_key,
      event.session_id,
      event.title,
      event.summary,
      event.root_cause,
      event.action_taken,
      event.outcome,
      event.status,
      event.confidence,
      event.source_kind,
      event.source_path,
      JSON.stringify(event.related_ids),
      JSON.stringify(event.files_touched),
      JSON.stringify(event.commands_run),
      event.tags,
      JSON.stringify(event.metadata),
      embedded.embedding ? JSON.stringify(embedded.embedding) : null,
    ],
  );

  const payload = {
    ok: true,
    id: event.id,
    embedded: embedded.embedded,
    embed_error: embedded.embedError ? embedded.embedError.slice(0, 160) : null,
  };
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`event stored: ${event.id}`);
    if (payload.embed_error) console.log(`embedding skipped: ${payload.embed_error}`);
  }
}

function appendFilter(where, params, sql, value, clause) {
  if (value === undefined || value === null || value === true || value === '') return;
  params.push(value);
  where.push(clause(params.length));
}

function dateRangeFromArgs(args) {
  const month = getArg(args, 'month');
  if (month) {
    if (!/^\d{4}-\d{2}$/.test(String(month))) throw new Error('--month must be YYYY-MM');
    const from = `${month}-01T00:00:00.000Z`;
    const d = new Date(from);
    if (!Number.isFinite(d.getTime())) throw new Error(`Invalid --month: ${month}`);
    const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
    return { from, to };
  }
  return {
    from: parseTimestamp(getArg(args, 'from'), null),
    to: parseTimestamp(getArg(args, 'to'), null),
  };
}

function eventTextExpression() {
  return `concat_ws(' ', title, summary, root_cause, action_taken, outcome, project_key, domain, agent, event_type, array_to_string(tags, ' '))`;
}

async function embedSearchQuery(query, args) {
  if (!query || args['no-semantic'] || args.noSemantic) return { embedding: null, error: null };
  try {
    return { embedding: await embed(query), error: null };
  } catch (error) {
    return { embedding: null, error: error.message || String(error) };
  }
}

async function loadRows(args, options = {}) {
  await ensureSchema();
  const params = [];
  const where = [];
  const query = scrubText(getArg(args, 'query')) || null;
  const semantic = await embedSearchQuery(query, args);
  const minSimilarity = parseFloatArg(getArg(args, 'min-similarity', 'minSimilarity'), 0.25);
  const textExpr = eventTextExpression();
  let similarityExpr = 'NULL::real';
  let similaritySelect = `${similarityExpr} AS similarity`;

  if (semantic.embedding) {
    params.push(JSON.stringify(semantic.embedding));
    const embParam = params.length;
    similarityExpr = `CASE WHEN embedding IS NULL THEN NULL ELSE 1 - (embedding <=> $${embParam}::vector) END`;
    similaritySelect = `${similarityExpr} AS similarity`;
    if (query) {
      params.push(`%${query}%`);
      const textParam = params.length;
      params.push(minSimilarity);
      const simParam = params.length;
      where.push(`(${textExpr} ILIKE $${textParam} OR (embedding IS NOT NULL AND 1 - (embedding <=> $${embParam}::vector) >= $${simParam}))`);
    }
  } else if (query) {
    params.push(`%${query}%`);
    where.push(`${textExpr} ILIKE $${params.length}`);
  }

  appendFilter(where, params, null, getArg(args, 'project', 'project-key', 'projectKey'), (i) => `project_key = $${i}`);
  appendFilter(where, params, null, getArg(args, 'domain'), (i) => `domain = $${i}`);
  appendFilter(where, params, null, getArg(args, 'type'), (i) => `event_type = $${i}`);
  appendFilter(where, params, null, getArg(args, 'status'), (i) => `status = $${i}`);
  appendFilter(where, params, null, getArg(args, 'agent'), (i) => `agent = $${i}`);
  appendFilter(where, params, null, getArg(args, 'id'), (i) => `id = $${i}`);

  const tag = getArg(args, 'tag');
  if (tag && tag !== true) {
    params.push(String(tag).toLowerCase());
    where.push(`$${params.length} = ANY(tags)`);
  }

  const { from, to } = dateRangeFromArgs(args);
  if (from) {
    params.push(from);
    where.push(`occurred_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`occurred_at < $${params.length}`);
  }

  const limit = Math.max(1, Math.min(parseIntArg(getArg(args, 'limit'), DEFAULT_LIMIT), 200));
  params.push(limit);
  const limitParam = params.length;
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql = semantic.embedding
    ? `ORDER BY COALESCE(${similarityExpr}, 0) DESC, occurred_at DESC`
    : 'ORDER BY occurred_at DESC, recorded_at DESC';

  const result = await db.query(
    `SELECT id, occurred_at, recorded_at, event_type, severity, project_key, domain,
            agent, runtime_family, title, summary, root_cause, action_taken, outcome,
            status, confidence, source_kind, source_path, related_ids, files_touched,
            commands_run, tags, metadata, ${similaritySelect}
       FROM brainx_event_ledger
       ${whereSql}
       ${options.timeline ? 'ORDER BY occurred_at DESC, recorded_at DESC' : orderSql}
       LIMIT $${limitParam}`,
    params,
  );

  return {
    rows: result.rows || [],
    semantic_error: semantic.error ? semantic.error.slice(0, 160) : null,
  };
}

function compactRow(row) {
  return {
    id: row.id,
    occurred_at: row.occurred_at,
    type: row.event_type,
    severity: row.severity,
    project: row.project_key,
    domain: row.domain,
    agent: row.agent,
    status: row.status,
    title: row.title,
    summary: row.summary,
    source_path: row.source_path,
    tags: row.tags,
    similarity: row.similarity === null || row.similarity === undefined ? null : Number(row.similarity),
  };
}

function printRows(rows, semanticError) {
  if (semanticError) console.log(`semantic search skipped: ${semanticError}`);
  if (rows.length === 0) {
    console.log('No events found.');
    return;
  }
  for (const row of rows) {
    const parts = [
      row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
      row.event_type,
      row.project_key || 'no-project',
      row.domain || 'no-domain',
      row.status,
    ];
    console.log(`- ${parts.join(' | ')} | ${row.id}`);
    console.log(`  ${row.title}`);
  }
}

async function cmdSearch(args) {
  const result = await loadRows(args);
  if (args.json) {
    console.log(JSON.stringify({
      ok: true,
      count: result.rows.length,
      semantic_error: result.semantic_error,
      results: result.rows.map(compactRow),
    }, null, 2));
  } else {
    printRows(result.rows, result.semantic_error);
  }
}

async function cmdTimeline(args) {
  const result = await loadRows(args, { timeline: true });
  if (args.json) {
    console.log(JSON.stringify({
      ok: true,
      count: result.rows.length,
      events: result.rows.map(compactRow),
    }, null, 2));
  } else {
    printRows(result.rows, null);
  }
}

async function cmdShow(args) {
  const id = getArg(args, 'id');
  if (!id || id === true) throw new Error('--id is required');
  const result = await loadRows({ ...args, id, limit: 1 }, { timeline: true });
  const row = result.rows[0] || null;
  if (args.json) console.log(JSON.stringify({ ok: !!row, event: row }, null, 2));
  else if (!row) console.log(`No event found: ${id}`);
  else console.log(JSON.stringify(row, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd === 'init') return cmdInit(args);
  if (cmd === 'add') return cmdAdd(args);
  if (cmd === 'search') return cmdSearch(args);
  if (cmd === 'timeline') return cmdTimeline(args);
  if (cmd === 'show') return cmdShow(args);
  throw new Error(`Unknown event command: ${cmd}`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error.stack || error.message || String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      try { await db.pool.end(); } catch {}
    });
}

module.exports = {
  parseArgs,
  normalizeEvent,
  buildEmbeddingText,
  ensureSchema,
};
