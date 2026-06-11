#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const db = require("/home/clawd/.openclaw/skills/brainx/lib/db.js");

const STATE_DIR = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
const DEFAULT_ROOT = path.join(STATE_DIR, "state", "brainx", "acp-rotation-events");
const CONFIGURED_PENDING_DIR = process.env.OPENCLAW_BRAINX_ACP_ROTATION_EVENT_DIR?.trim();
const PENDING_DIR = CONFIGURED_PENDING_DIR || path.join(DEFAULT_ROOT, "pending");
const EVENT_ROOT = CONFIGURED_PENDING_DIR ? path.dirname(PENDING_DIR) : DEFAULT_ROOT;
const PROCESSED_DIR = path.join(EVENT_ROOT, "processed");
const FAILED_DIR = path.join(EVENT_ROOT, "failed");
const MARKER = "BRAINX_ACP_ROTATION_EVENT_INGEST_20260513";

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS brainx_session_rotation_events (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  session_key TEXT NOT NULL,
  previous_session_id TEXT NOT NULL,
  current_session_id TEXT NOT NULL,
  previous_updated_at TIMESTAMPTZ,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  trigger_reason TEXT,
  triggered_recovery BOOLEAN DEFAULT FALSE,
  injected_handoff BOOLEAN DEFAULT FALSE,
  missed_reason TEXT,
  prompt_sha CHAR(16),
  prompt_preview TEXT,
  runtime_family TEXT,
  metadata JSONB DEFAULT '{}'::jsonb
)`;

function sha(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function extractAgentId(sessionKey) {
  const parts = String(sessionKey || "").split(":");
  return parts[0] === "agent" && parts[1] ? parts[1] : "";
}

function bytesLabel(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return "unknown";
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

async function ensureTable() {
  await db.query(TABLE_SQL);
  await db.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_brainx_session_rotation_event_unique ON brainx_session_rotation_events (agent, session_key, previous_session_id, current_session_id, prompt_sha)");
  await db.query("CREATE INDEX IF NOT EXISTS idx_brainx_session_rotation_events_agent_detected ON brainx_session_rotation_events (agent, detected_at DESC)");
  await db.query("CREATE INDEX IF NOT EXISTS idx_brainx_session_rotation_events_session_key_detected ON brainx_session_rotation_events (session_key, detected_at DESC)");
}

async function listPendingFiles() {
  try {
    const entries = await fs.readdir(PENDING_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(PENDING_DIR, entry.name))
      .sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function moveFile(source, dir, suffix = "") {
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${path.basename(source)}${suffix}`);
  try {
    await fs.rename(source, target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return target;
}

async function ingestFile(file) {
  let payload;
  try {
    payload = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    await moveFile(file, FAILED_DIR, ".invalid");
    return { file, status: "failed", reason: `invalid-json:${error?.message || String(error)}` };
  }

  const sessionKey = normalizeString(payload.sessionKey);
  const previousSessionId = normalizeString(payload.previousSessionId);
  const currentSessionId = normalizeString(payload.currentSessionId);
  const agent = normalizeString(payload.agent) || extractAgentId(sessionKey);
  if (!agent || !sessionKey || !previousSessionId || !currentSessionId || previousSessionId === currentSessionId) {
    await moveFile(file, FAILED_DIR, ".invalid");
    return { file, status: "failed", reason: "missing-or-invalid-identity" };
  }

  const eventSeed = `${agent}:${sessionKey}:${previousSessionId}:${currentSessionId}:${payload.detectedAt || ""}`;
  const promptSha = sha(payload.eventId || eventSeed).slice(0, 16);
  const id = `rotation_${sha(`${agent}:${sessionKey}:${previousSessionId}:${currentSessionId}:${promptSha}`).slice(0, 24)}`;
  const triggerReason = normalizeString(payload.triggerReason) || "runtime-bloat-rotation";
  const promptPreview = `Claude ACP transcript rotation (${bytesLabel(payload.sizeBytes)} > ${bytesLabel(payload.thresholdBytes)})`;
  const metadata = {
    marker: MARKER,
    source: normalizeString(payload.source) || "openclaw-acp-manager",
    source_event_type: normalizeString(payload.eventType) || "claude-acp-runtime-bloat-rotation",
    source_marker: normalizeString(payload.marker) || null,
    runtime_marker: normalizeString(payload.runtimeMarker) || null,
    handoff_path: normalizeString(payload.handoffPath) || null,
    transcript_path: normalizeString(payload.transcriptPath) || null,
    size_bytes: Number(payload.sizeBytes || 0) || null,
    threshold_bytes: Number(payload.thresholdBytes || 0) || null,
    // Token-budget rotation level (context-budget guard). Queryable via
    // metadata->>'total_tokens'. Added 2026-05-31 so the ledger records at what
    // level each rotation fired, not just that it happened.
    total_tokens: Number(payload.totalTokens || 0) || null,
    context_tokens: Number(payload.contextTokens || 0) || null,
    threshold_tokens: Number(payload.threshold || 0) || null,
    ingested_at: new Date().toISOString(),
    source_file: file,
  };

  await db.query(
    `INSERT INTO brainx_session_rotation_events
       (id, agent, session_key, previous_session_id, current_session_id,
        previous_updated_at, detected_at, trigger_reason, triggered_recovery,
        injected_handoff, missed_reason, prompt_sha, prompt_preview, runtime_family, metadata)
     VALUES
       ($1,$2,$3,$4,$5,NULL,COALESCE($6::timestamptz, NOW()),$7,TRUE,$8,NULL,$9,$10,'acp',$11::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       detected_at = EXCLUDED.detected_at,
       trigger_reason = COALESCE(EXCLUDED.trigger_reason, brainx_session_rotation_events.trigger_reason),
       triggered_recovery = TRUE,
       injected_handoff = brainx_session_rotation_events.injected_handoff OR EXCLUDED.injected_handoff,
       missed_reason = NULL,
       runtime_family = 'acp',
       metadata = COALESCE(brainx_session_rotation_events.metadata, '{}'::jsonb) || EXCLUDED.metadata`,
    [
      id,
      agent,
      sessionKey,
      previousSessionId,
      currentSessionId,
      normalizeString(payload.detectedAt) || null,
      triggerReason,
      Boolean(payload.injectedHandoff || payload.handoffPath),
      promptSha,
      promptPreview.slice(0, 400),
      JSON.stringify(metadata),
    ],
  );

  await moveFile(file, PROCESSED_DIR);
  return { file, status: "ingested", id, agent, sessionKey, previousSessionId, currentSessionId };
}

async function main() {
  await ensureTable();
  const files = await listPendingFiles();
  const results = [];
  for (const file of files) {
    results.push(await ingestFile(file));
  }
  console.log(JSON.stringify({
    ok: true,
    marker: MARKER,
    pendingDir: PENDING_DIR,
    processedDir: PROCESSED_DIR,
    total: files.length,
    ingested: results.filter((row) => row.status === "ingested").length,
    failed: results.filter((row) => row.status === "failed").length,
    results,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, marker: MARKER, error: error?.message || String(error) }, null, 2));
    process.exit(1);
  })
  .finally(async () => {
    try {
      await db.close?.();
      await db.pool?.end?.();
    } catch {}
  });
