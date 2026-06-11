#!/usr/bin/env node
// BrainX Review Loop Guardrails.
// Non-destructive 2h checks for recall quality, recoverability, privacy,
// artifact durability, duplicate handoffs, weak handoffs, and light staleness.

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../lib/db');
const { embed } = require('../lib/embedding-client');

const TODAY = new Date().toISOString().slice(0, 10);
const SECRET_PATTERNS = [
  ['openai_key', /\bsk-[A-Za-z0-9]{16,}\b/],
  ['github_token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/],
  ['github_pat', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['aws_access_key', /\bAKIA[0-9A-Z]{16}\b/],
  ['slack_token', /\bxox(?:b|p|a|r|s)-[A-Za-z0-9-]{10,}\b/],
  ['bearer_token', /\bBearer\s+[A-Za-z0-9._-]{16,}\b/i],
  ['jwt_token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['private_key_block', /-----BEGIN(?: RSA| EC| OPENSSH)? PRIVATE KEY-----[\s\S]*?-----END(?: RSA| EC| OPENSSH)? PRIVATE KEY-----/],
  ['api_key_assignment', /\b(?:api|access|secret|private)[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9._-]{12,}['"]?/i],
  ['password_inline', /(?:contraseña|password|passwd|pass|clave|secret)\s*(?:(?:es|is|actual|nueva|new|=|:)\s*){1,2}['"]?[^\s'",]{4,}['"]?/i],
];
const PII_PATTERNS = [
  ['email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ['phone', /(?<!\w)(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}(?!\w)/],
];
const URL_RE = /https?:\/\/[^\s"'<>]+/gi;
const PATH_RE = /\/(?:home|tmp|var\/tmp)\/[^\s"'<>),;:]+/g;
const TIER_STEP = { hot: 'warm', warm: 'cold', cold: 'archive', archive: 'archive' };

function parseArgs() {
  const out = { apply: false, hours: 2, amnesiaHours: 6, limit: 250, recallNoiseMin: 3, mode: 'full', alertAfter: 1, stateFile: '' };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--mode') out.mode = String(argv[++i] || 'full');
    else if (arg === '--hours') out.hours = parseInt(argv[++i], 10) || 2;
    else if (arg === '--amnesia-hours') out.amnesiaHours = parseInt(argv[++i], 10) || 6;
    else if (arg === '--limit') out.limit = parseInt(argv[++i], 10) || 250;
    else if (arg === '--recall-noise-min') out.recallNoiseMin = parseInt(argv[++i], 10) || 3;
    else if (arg === '--alert-after') out.alertAfter = parseInt(argv[++i], 10) || 1;
    else if (arg === '--state-file') out.stateFile = String(argv[++i] || '');
    else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/review-loop-guardrails.js [--apply] [--json] [--mode full|amnesia-smoke] [--hours N] [--amnesia-hours N] [--limit N]');
      process.exit(0);
    }
  }
  if (!['full', 'amnesia-smoke'].includes(out.mode)) out.mode = 'full';
  out.hours = Math.max(1, Math.min(out.hours, 24));
  out.amnesiaHours = Math.max(out.hours, Math.min(out.amnesiaHours, 24));
  out.limit = Math.max(10, Math.min(out.limit, 1000));
  out.recallNoiseMin = Math.max(2, Math.min(out.recallNoiseMin, 20));
  out.alertAfter = Math.max(1, Math.min(out.alertAfter, 12));
  return out;
}

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function safePreview(value, max) {
  let text = compact(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9._-]{24,}\b/g, '[token]');
  const limit = max || 140;
  if (text.length > limit) text = text.slice(0, limit - 3).trimEnd() + '...';
  return text;
}

function tags(value) {
  return Array.isArray(value) ? value.filter(Boolean).map(String) : [];
}

function withTags(existing, extra) {
  const out = tags(existing);
  const seen = new Set(out);
  for (const tag of extra.filter(Boolean).map(String)) {
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

function nextTier(tier) {
  return TIER_STEP[String(tier || '').toLowerCase()] || 'cold';
}

function extractUrls(text) {
  const out = [];
  for (const m of String(text || '').matchAll(URL_RE)) out.push(m[0].replace(/[.,;:)]+$/, ''));
  return out;
}

function extractPaths(text) {
  const out = [];
  for (const m of String(text || '').matchAll(PATH_RE)) out.push(m[0].replace(/[.,;:)]+$/, ''));
  return Array.from(new Set(out));
}

function isSensitiveUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return true;
    for (const key of parsed.searchParams.keys()) {
      if (/token|secret|password|passwd|key|code|auth|session|jwt/i.test(key)) return true;
    }
  } catch {}
  return false;
}

function isTempPath(p) {
  return p.startsWith('/tmp/') || p.startsWith('/var/tmp/') || /\/workspace-[^/]+\//.test(p);
}

function isSensitivePath(p) {
  return /(^|\/)\.env(?:\.|$)/.test(p) ||
    p.includes('/auth-profiles.json') ||
    p.includes('/gateway.env') ||
    p.includes('/browser-profiles/') ||
    /(?:cookie|cookies|token|secret|credential|password)/i.test(path.basename(p));
}

function isAllowedDurableArtifactPath(p) {
  if (!p || p.length > 260 || p.includes('/node_modules/')) return false;
  if (p.startsWith('/home/clawd/.openclaw/media/')) return true;
  if (p.startsWith('/home/clawd/.openclaw/sandboxes/')) return true;
  if (/^\/home\/clawd\/[^/\s]+\.[A-Za-z0-9]{2,8}$/.test(p)) return true;
  return false;
}

function classifyMemoryRisk(row) {
  const text = [row.content, row.context, row.source_path, tags(row.tags).join(' ')].filter(Boolean).join('\n');
  const reasons = [];
  for (const item of SECRET_PATTERNS) {
    item[1].lastIndex = 0;
    if (item[1].test(text)) reasons.push(item[0]);
  }
  for (const url of extractUrls(text)) {
    if (isSensitiveUrl(url)) reasons.push('sensitive_url');
  }
  for (const p of extractPaths(text)) {
    if (isSensitivePath(p)) reasons.push('sensitive_path');
    else if (isTempPath(p)) reasons.push('temporary_path');
  }
  const pii = [];
  for (const item of PII_PATTERNS) {
    item[1].lastIndex = 0;
    if (item[1].test(text)) pii.push(item[0]);
  }
  const hasSecret = reasons.some((r) => r !== 'temporary_path');
  if (hasSecret) return { action: 'quarantine', reasons: Array.from(new Set(reasons)) };
  if (reasons.includes('temporary_path')) return { action: 'degrade', reasons: ['temporary_path'] };
  if (pii.length) return { action: 'review_required', reasons: Array.from(new Set(pii)) };
  return { action: 'ok', reasons: [] };
}

async function loadRecentMemories(cfg) {
  const result = await db.query(
    "SELECT id, content, context, tier, importance, tags, status, source_kind, source_path, sensitivity, verification_state, created_at, last_seen, superseded_by FROM brainx_memories WHERE superseded_by IS NULL AND (created_at >= NOW() - ($1::int || ' hours')::interval OR last_seen >= NOW() - ($1::int || ' hours')::interval) ORDER BY GREATEST(COALESCE(last_seen, created_at), created_at) DESC LIMIT $2",
    [cfg.amnesiaHours, cfg.limit]
  );
  return result.rows || [];
}

async function applyMemoryAction(row, action, reasons, cfg) {
  const reasonTags = reasons.map((reason) => 'guardrail:' + reason);
  if (!cfg.apply) return;
  if (action === 'quarantine') {
    await db.query(
      "UPDATE brainx_memories SET tier = 'archive', importance = LEAST(COALESCE(importance, 5), 1), sensitivity = 'restricted', verification_state = 'obsolete', status = 'wont_fix', tags = $2::text[], resolution_notes = LEFT(CONCAT_WS(E'\\n', NULLIF(resolution_notes, ''), $3::text), 2000), last_seen = NOW() WHERE id = $1",
      [row.id, withTags(row.tags, ['guardrail:quarantined', 'guardrail:quarantined:' + TODAY].concat(reasonTags)), 'BrainX Review Loop ' + TODAY + ': quarantined from normal recall (' + reasons.join(', ') + ').']
    );
  } else if (action === 'degrade') {
    await db.query(
      "UPDATE brainx_memories SET tier = $2, importance = LEAST(COALESCE(importance, 5), 4), tags = $3::text[], last_seen = NOW() WHERE id = $1",
      [row.id, nextTier(row.tier), withTags(row.tags, ['guardrail:degraded', 'guardrail:degraded:' + TODAY].concat(reasonTags))]
    );
  } else if (action === 'review_required') {
    await db.query(
      "UPDATE brainx_memories SET sensitivity = CASE WHEN COALESCE(sensitivity, 'normal') = 'restricted' THEN 'restricted' ELSE 'sensitive' END, tags = $2::text[], last_seen = NOW() WHERE id = $1",
      [row.id, withTags(row.tags, ['guardrail:review_required', 'guardrail:review_required:' + TODAY].concat(reasonTags))]
    );
  }
}

async function runMemoryQuarantine(cfg, recentMemories) {
  const output = { scanned: recentMemories.length, quarantined: [], degraded: [], reviewRequired: [], ok: 0, errors: [] };
  for (const row of recentMemories) {
    const risk = classifyMemoryRisk(row);
    if (risk.action === 'ok') {
      output.ok++;
      continue;
    }
    try {
      await applyMemoryAction(row, risk.action, risk.reasons, cfg);
      const item = { id: row.id, action: risk.action, reasons: risk.reasons, tier: row.tier, preview: safePreview(row.content) };
      if (risk.action === 'quarantine') output.quarantined.push(item);
      else if (risk.action === 'degrade') output.degraded.push(item);
      else output.reviewRequired.push(item);
    } catch (error) {
      output.errors.push({ id: row.id, action: risk.action, error: String(error && error.message || error).slice(0, 220) });
    }
  }
  return output;
}

async function runAmnesiaSmoke(cfg) {
  const result = await db.query(
    "SELECT id, content FROM brainx_memories WHERE superseded_by IS NULL AND source_kind = 'summary_derived' AND COALESCE(verification_state, 'hypothesis') != 'obsolete' AND COALESCE(sensitivity, 'normal') = 'normal' AND (created_at >= NOW() - ($1::int || ' hours')::interval OR last_seen >= NOW() - ($1::int || ' hours')::interval) ORDER BY GREATEST(COALESCE(last_seen, created_at), created_at) DESC LIMIT 2",
    [cfg.amnesiaHours]
  );
  const checks = [];
  const errors = [];
  for (const row of result.rows || []) {
    try {
      const vector = await embed(compact(row.content).slice(0, 900));
      const search = await db.query(
        "SELECT id, 1 - (embedding <=> $1::vector) AS similarity FROM brainx_memories WHERE embedding IS NOT NULL AND superseded_by IS NULL AND COALESCE(verification_state, 'hypothesis') != 'obsolete' AND COALESCE(sensitivity, 'normal') = 'normal' ORDER BY embedding <=> $1::vector LIMIT 5",
        [JSON.stringify(vector)]
      );
      const ids = (search.rows || []).map((item) => item.id);
      const rank = ids.indexOf(row.id);
      checks.push({ id: row.id, recovered: rank !== -1, rank: rank === -1 ? null : rank + 1, topSimilarity: search.rows && search.rows[0] ? Number(search.rows[0].similarity) : null });
      await new Promise((resolve) => setTimeout(resolve, 150));
    } catch (error) {
      errors.push({ id: row.id, error: String(error && error.message || error).slice(0, 220) });
    }
  }
  return { checked: checks.length, recovered: checks.filter((item) => item.recovered).length, failed: checks.filter((item) => !item.recovered), checks, errors };
}

async function runArtifactLiveness(cfg) {
  const result = await db.query(
    "SELECT id, artifact_path, finality_score FROM brainx_artifact_ledger WHERE (last_seen >= NOW() - ($1::int || ' hours')::interval OR finality_score >= 0.9) AND artifact_role = 'final_deliverable' ORDER BY last_seen DESC LIMIT $2",
    [cfg.amnesiaHours, Math.min(cfg.limit, 200)]
  );
  const out = { scanned: 0, live: 0, degraded: [], errors: [] };
  for (const row of result.rows || []) {
    out.scanned++;
    const artifactPath = String(row.artifact_path || '');
    const durable = isAllowedDurableArtifactPath(artifactPath);
    const exists = artifactPath.startsWith('/') ? fs.existsSync(artifactPath) : false;
    const status = !durable ? 'not_durable' : (!exists ? 'missing' : 'ok');
    if (status === 'ok') {
      out.live++;
      if (cfg.apply) {
        await db.query("UPDATE brainx_artifact_ledger SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb WHERE id = $1", [row.id, JSON.stringify({ guardrails: { artifactLiveness: { status, checkedAt: new Date().toISOString() } } })]);
      }
      continue;
    }
    try {
      if (cfg.apply) {
        await db.query(
          "UPDATE brainx_artifact_ledger SET finality_score = LEAST(COALESCE(finality_score, 0.5), $2), metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb WHERE id = $1",
          [row.id, status === 'missing' ? 0.25 : 0.2, JSON.stringify({ guardrails: { artifactLiveness: { status, checkedAt: new Date().toISOString(), durable, exists } } })]
        );
      }
      out.degraded.push({ id: row.id, status, durable, exists, finalityScore: row.finality_score, pathPreview: safePreview(artifactPath, 120) });
    } catch (error) {
      out.errors.push({ id: row.id, error: String(error && error.message || error).slice(0, 220) });
    }
  }
  return out;
}

async function runRecallQualitySampler(cfg) {
  const aggregate = await db.query(
    "SELECT COUNT(*)::int AS injections, COALESCE(SUM(selected_count), 0)::int AS selected_total, COALESCE(SUM(referenced_count), 0)::int AS hard_referenced_total, COALESCE(SUM(soft_referenced_count), 0)::int AS soft_referenced_total, COUNT(*) FILTER (WHERE COALESCE(selected_count, 0) > 0 AND scored_at IS NOT NULL AND COALESCE(referenced_count, 0) = 0 AND COALESCE(soft_referenced_count, 0) = 0)::int AS selected_no_signal_calls FROM brainx_runtime_injections WHERE injected_at >= NOW() - ($1::int || ' hours')::interval",
    [cfg.hours]
  );
  const base = "WITH selected AS (SELECT mid, COUNT(*)::int AS selected_count, SUM(CASE WHEN mid = ANY(COALESCE(ri.referenced_ids, ARRAY[]::text[])) THEN 1 ELSE 0 END)::int AS hard_count, SUM(CASE WHEN mid = ANY(COALESCE(ri.soft_referenced_ids, ARRAY[]::text[])) THEN 1 ELSE 0 END)::int AS soft_count FROM brainx_runtime_injections ri, LATERAL unnest(COALESCE(ri.memory_ids, ARRAY[]::text[])) mid WHERE ri.injected_at >= NOW() - ($1::int || ' hours')::interval GROUP BY mid) SELECT s.mid AS id, s.selected_count, s.hard_count, s.soft_count, m.tier, m.importance, m.tags, LEFT(m.content, 180) AS preview FROM selected s JOIN brainx_memories m ON m.id = s.mid WHERE COALESCE(m.verification_state, 'hypothesis') != 'obsolete'";
  const noisy = await db.query(base + " AND s.selected_count >= $2 AND s.hard_count = 0 AND s.soft_count = 0 ORDER BY s.selected_count DESC LIMIT 12", [cfg.hours, cfg.recallNoiseMin]);
  const useful = await db.query(base + " AND s.hard_count + s.soft_count > 0 ORDER BY (s.hard_count + s.soft_count) DESC, s.selected_count DESC LIMIT 12", [cfg.hours]);
  const taggedNoise = [];
  const taggedUseful = [];
  if (cfg.apply) {
    for (const row of noisy.rows || []) {
      await db.query("UPDATE brainx_memories SET tier = $2, tags = $3::text[] WHERE id = $1", [row.id, nextTier(row.tier), withTags(row.tags, ['recall:ignored', 'recall:ignored:' + TODAY])]);
      taggedNoise.push(row.id);
    }
    for (const row of useful.rows || []) {
      await db.query("UPDATE brainx_memories SET tags = $2::text[] WHERE id = $1", [row.id, withTags(row.tags, ['recall:useful', 'recall:useful:' + TODAY])]);
      taggedUseful.push(row.id);
    }
  }
  return {
    summary: aggregate.rows && aggregate.rows[0] || {},
    noiseCandidates: (noisy.rows || []).map((row) => ({ id: row.id, selectedCount: row.selected_count, tier: row.tier, preview: safePreview(row.preview) })),
    usefulCandidates: (useful.rows || []).map((row) => ({ id: row.id, selectedCount: row.selected_count, hardCount: row.hard_count, softCount: row.soft_count, tier: row.tier, preview: safePreview(row.preview) })),
    taggedNoise,
    taggedUseful,
  };
}

async function runDuplicateCollapse(cfg, recentMemories) {
  const groups = new Map();
  for (const row of recentMemories.filter((m) => m.source_kind === 'summary_derived')) {
    const key = compact(row.content).replace(/^Handoff (?:summary|artifact|pending items) for [^:]{1,80}:\s*/i, '').replace(/Agent \w+ session with \d+ turns\.\s*/gi, '').toLowerCase();
    if (key.length < 120) continue;
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    if (!groups.has(hash)) groups.set(hash, []);
    groups.get(hash).push(row);
  }
  const collapsed = [];
  const errors = [];
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0) || String(b.last_seen || '').localeCompare(String(a.last_seen || '')));
    const keeper = rows[0];
    for (const duplicate of rows.slice(1)) {
      try {
        if (cfg.apply) {
          await db.query(
            "UPDATE brainx_memories SET tier = 'archive', status = 'wont_fix', verification_state = 'obsolete', superseded_by = $2, tags = $3::text[], resolution_notes = LEFT(CONCAT_WS(E'\\n', NULLIF(resolution_notes, ''), $4::text), 2000) WHERE id = $1",
            [duplicate.id, keeper.id, withTags(duplicate.tags, ['guardrail:duplicate', 'guardrail:duplicate:' + TODAY]), 'BrainX Review Loop ' + TODAY + ': exact normalized duplicate collapsed into ' + keeper.id + '.']
          );
        }
        collapsed.push({ duplicateId: duplicate.id, keeperId: keeper.id });
      } catch (error) {
        errors.push({ duplicateId: duplicate.id, keeperId: keeper.id, error: String(error && error.message || error).slice(0, 220) });
      }
    }
  }
  return { groups: Array.from(groups.values()).filter((rows) => rows.length > 1).length, collapsed, errors };
}

async function runHandoffCompleteness(cfg) {
  const result = await db.query(
    "SELECT id, project, agent, summary, status, pending_items, blockers, last_file_touched, last_error, turn_count, session_end FROM brainx_session_snapshots WHERE session_end >= NOW() - ($1::int || ' hours')::interval ORDER BY session_end DESC LIMIT $2",
    [cfg.amnesiaHours, Math.min(cfg.limit, 200)]
  );
  const weak = [];
  for (const row of result.rows || []) {
    const reasons = [];
    const summary = compact(row.summary);
    const pending = Array.isArray(row.pending_items) ? row.pending_items : [];
    const blockers = Array.isArray(row.blockers) ? row.blockers : [];
    if (summary.length < 260) reasons.push('thin_summary');
    if (!row.last_file_touched && !row.last_error && pending.length === 0 && blockers.length === 0) reasons.push('missing_state_signal');
    if (row.status === 'completed' && !/(validat|test|qa|verified|build|lint|screenshot|captura|evidencia|ok)/i.test(summary)) reasons.push('missing_validation_signal');
    if (row.status !== 'completed' && pending.length === 0 && blockers.length === 0 && !/(next|pendiente|falta|blocked|blocker|waiting|siguiente)/i.test(summary)) reasons.push('missing_next_step');
    if (reasons.length) weak.push({ id: row.id, agent: row.agent, project: row.project, status: row.status, reasons });
  }
  return { scanned: result.rowCount || 0, weak };
}

async function runStalenessDetector(cfg, recentMemories) {
  const out = { scanned: recentMemories.length, possiblyStale: [], errors: [] };
  for (const row of recentMemories) {
    const text = [row.content, row.source_path].filter(Boolean).join('\n');
    const paths = extractPaths(text).filter((p) => p.startsWith('/home/clawd/')).filter((p) => !isSensitivePath(p)).filter((p) => !isTempPath(p)).slice(0, 5);
    const missing = paths.filter((p) => !fs.existsSync(p));
    const hasEphemeralUrl = extractUrls(text).some((url) => /localhost|127\.0\.0\.1|0\.0\.0\.0|preview/i.test(url));
    if (!missing.length && !hasEphemeralUrl) continue;
    try {
      if (cfg.apply) {
        await db.query("UPDATE brainx_memories SET tags = $2::text[], tier = CASE WHEN tier = 'hot' THEN 'warm' ELSE tier END WHERE id = $1", [row.id, withTags(row.tags, ['guardrail:possibly_stale', 'guardrail:possibly_stale:' + TODAY])]);
      }
      out.possiblyStale.push({ id: row.id, reasons: [missing.length ? 'missing_path' : null, hasEphemeralUrl ? 'ephemeral_url' : null].filter(Boolean), missingCount: missing.length, preview: safePreview(row.content) });
    } catch (error) {
      out.errors.push({ id: row.id, error: String(error && error.message || error).slice(0, 220) });
    }
  }
  return out;
}

function loadJsonFile(file, fallback) {
  if (!file) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, payload) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

async function runAmnesiaSmokeMode(cfg) {
  const amnesia = await runAmnesiaSmoke(cfg);
  const rawFailed = amnesia.failed.length > 0 || amnesia.errors.length > 0;
  const previous = loadJsonFile(cfg.stateFile, {});
  const previousFailures = Number(previous.consecutiveFailures || 0);
  const consecutiveFailures = rawFailed ? previousFailures + 1 : 0;
  const alerting = rawFailed && consecutiveFailures >= cfg.alertAfter;
  const state = {
    lastRunAt: new Date().toISOString(),
    lastStatus: rawFailed ? 'failed' : 'ok',
    consecutiveFailures,
    alertAfter: cfg.alertAfter,
    lastFailureAt: rawFailed ? new Date().toISOString() : (previous.lastFailureAt || null),
    lastRecoveryAt: !rawFailed && previousFailures > 0 ? new Date().toISOString() : (previous.lastRecoveryAt || null),
    lastChecks: amnesia.checks,
  };
  writeJsonFile(cfg.stateFile, state);
  const summary = {
    amnesiaChecked: amnesia.checked,
    amnesiaRecovered: amnesia.recovered,
    amnesiaFailed: amnesia.failed.length,
    amnesiaErrors: amnesia.errors.length,
    consecutiveFailures,
    alertAfter: cfg.alertAfter,
  };
  const output = {
    ok: !alerting,
    status: alerting ? 'error' : (rawFailed ? 'warn' : 'ok'),
    mode: 'amnesia-smoke',
    job: 'brainx-amnesia-smoke',
    generatedAt: new Date().toISOString(),
    windowHours: cfg.hours,
    amnesiaHours: cfg.amnesiaHours,
    summary,
    amnesia,
    report: {
      shouldNotify: alerting,
      reasons: alerting ? ['amnesia_smoke_consecutive_failure'] : [],
    },
    stateFile: cfg.stateFile || null,
  };
  console.log(JSON.stringify(output, null, 2));
  process.exitCode = alerting ? 1 : 0;
}

async function main() {
  const cfg = parseArgs();
  if (cfg.mode === 'amnesia-smoke') {
    await runAmnesiaSmokeMode(cfg);
    return;
  }
  const recentMemories = await loadRecentMemories(cfg);
  const quarantine = await runMemoryQuarantine(cfg, recentMemories);
  const amnesia = await runAmnesiaSmoke(cfg);
  const artifacts = await runArtifactLiveness(cfg);
  const recall = await runRecallQualitySampler(cfg);
  const duplicates = await runDuplicateCollapse(cfg, recentMemories);
  const handoffs = await runHandoffCompleteness(cfg);
  const staleness = await runStalenessDetector(cfg, recentMemories);
  const summary = {
    quarantined: quarantine.quarantined.length,
    degradedMemories: quarantine.degraded.length,
    reviewRequired: quarantine.reviewRequired.length,
    amnesiaChecked: amnesia.checked,
    amnesiaRecovered: amnesia.recovered,
    amnesiaFailed: amnesia.failed.length,
    artifactsScanned: artifacts.scanned,
    artifactsDegraded: artifacts.degraded.length,
    recallNoiseCandidates: recall.noiseCandidates.length,
    recallUsefulCandidates: recall.usefulCandidates.length,
    duplicateCollapsed: duplicates.collapsed.length,
    weakHandoffs: handoffs.weak.length,
    possiblyStale: staleness.possiblyStale.length,
  };
  const errors = [].concat(quarantine.errors, amnesia.errors, artifacts.errors, duplicates.errors, staleness.errors);
  console.log(JSON.stringify({
    ok: errors.length === 0,
    status: errors.length ? 'warn' : 'ok',
    mode: cfg.apply ? 'apply' : 'dry-run',
    job: 'brainx-review-loop-guardrails',
    generatedAt: new Date().toISOString(),
    windowHours: cfg.hours,
    amnesiaHours: cfg.amnesiaHours,
    summary,
    quarantine,
    amnesia,
    artifacts,
    recall,
    duplicates,
    handoffs,
    staleness,
    errors,
  }, null, 2));
  process.exitCode = errors.length ? 1 : 0;
}

main().catch(async (error) => {
  try { await db.pool.end(); } catch {}
  console.error(error.stack || error.message || String(error));
  process.exit(1);
}).finally(async () => {
  try { await db.pool.end(); } catch {}
});
