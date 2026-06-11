/**
 * BrainX Live Capture Hook
 *
 * Runs on message:sent and captures high-signal outbound recommendations
 * into daily memory + BrainX with conservative provenance.
 */

import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
const BRAINX_DIR = path.join(STATE_DIR, "skills", "brainx");
const brainxRequire = createRequire(path.join(BRAINX_DIR, "package.json"));

const DEFAULTS = {
  minChars: 120,
  maxChars: 1200,
  maxBullets: 6,
  storeToBrainx: true,
  storeToDailyMemory: true,
  allowGroups: true
};

const EXCLUDED_AGENTS = new Set(["heartbeat", "monitor"]);
const SKIP_PATTERNS = [
  /^NO_REPLY$/i,
  /^HEARTBEAT_OK$/i,
  /session cleanup|health check|cron:|^\[[^\]]+\]\s*✅/i,
  /^(ok|listo|hecho|done|entendido|perfecto|claro)\.?$/i,
  /```[\s\S]{350,}```/,
  /^\s*(import|const|let|function|class|export|interface|type)\b/m,
  /Process exited with code|Successfully wrote \d+ bytes/i,
];
const STRONG_SIGNAL = /(?:stack recomendado|recommended stack|mi recomendaci[oó]n|recomiendo|recommend(?:ed|ation)?|mejor opci[oó]n|best option|go with|vamos con|vamos a usar|usar[ií]a|worth using|soluci[oó]n recomendada|framework recomendado|auth recomendad[ao])/i;
const DOMAIN_SIGNAL = /(?:stack|framework|backend|frontend|architecture|arquitectura|auth|authentication|oauth|jwt|rbac|security|rate limit|rate limiting|cors|csrf|database|postgres|postgresql|mysql|sqlite|prisma|drizzle|typeorm|nestjs|nest|fastify|express|nextjs|next|react|railway|redis|queue|worker|encryption|deploy)/i;
const TRADEOFF_SIGNAL = /(?:tradeoff|trade-off|why|porque|por qu[eé]|better than|mejor que|instead of|en vez de|pros?|cons?|ventaja|desventaja|worth|seguridad|boilerplate)/i;
const GOTCHA_SIGNAL = /(?:gotcha|cuidado|watch out|careful|trap|ojo con|avoid|no usar|nunca|prohibido)/i;
const SECURITY_SIGNAL = /(?:auth|authentication|oauth|jwt|rbac|security|rate limit|cors|csrf|encryption|helmet|xss|sensitive data|datos sensibles)/i;
const ARCH_SIGNAL = /(?:stack|framework|backend|frontend|architecture|arquitectura|database|orm|deploy|infraestructura|pipeline)/i;

let cachedConfig = null;
let cachedConfigMtimeMs = -1;
let cachedTelemetry = null;

function nowIso() {
  return new Date().toISOString();
}

function sha(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

async function logLine(message, extra = {}) {
  return logOutcome({ message, ...extra });
}

function boolOrDefault(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

async function readOpenClawConfig() {
  const configPath = path.join(STATE_DIR, "openclaw.json");
  const stat = await fs.stat(configPath);
  if (cachedConfig && cachedConfigMtimeMs === stat.mtimeMs) return cachedConfig;
  const raw = await fs.readFile(configPath, "utf8");
  cachedConfig = JSON.parse(raw);
  cachedConfigMtimeMs = stat.mtimeMs;
  return cachedConfig;
}

async function getHookOptions() {
  try {
    const cfg = await readOpenClawConfig();
    const entry = cfg?.hooks?.internal?.entries?.["brainx-live-capture"] || {};
    return {
      minChars: Number.parseInt(entry.minChars, 10) || DEFAULTS.minChars,
      maxChars: Number.parseInt(entry.maxChars, 10) || DEFAULTS.maxChars,
      maxBullets: Number.parseInt(entry.maxBullets, 10) || DEFAULTS.maxBullets,
      storeToBrainx: boolOrDefault(entry.storeToBrainx, DEFAULTS.storeToBrainx),
      storeToDailyMemory: boolOrDefault(entry.storeToDailyMemory, DEFAULTS.storeToDailyMemory),
      allowGroups: boolOrDefault(entry.allowGroups, DEFAULTS.allowGroups)
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function extractAgentId(sessionKey) {
  if (!sessionKey || typeof sessionKey !== "string") return "unknown";
  const parts = sessionKey.split(":");
  return parts.length >= 2 ? parts[1] : "unknown";
}

function getTelemetry() {
  if (cachedTelemetry) return cachedTelemetry;
  cachedTelemetry = brainxRequire(path.join(BRAINX_DIR, "lib", "live-capture-stats.js"));
  return cachedTelemetry;
}

async function logOutcome(payload) {
  try {
    const telemetry = getTelemetry();
    await telemetry.appendLiveCaptureEvent(payload, { stateDir: STATE_DIR });
  } catch {
    // Never fail the hook because telemetry logging failed.
  }
}

async function resolveWorkspaceDir(agentId) {
  try {
    const cfg = await readOpenClawConfig();
    const agents = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
    const exact = agents.find((entry) => entry?.id === agentId || entry?.name === agentId);
    if (typeof exact?.workspace === "string" && exact.workspace) return exact.workspace;
  } catch {
    // Fall through to filesystem guesses.
  }

  if (agentId === "main") return path.join(STATE_DIR, "workspace");
  const guessed = path.join(STATE_DIR, `workspace-${agentId}`);
  try {
    await fs.access(guessed);
    return guessed;
  } catch {
    return null;
  }
}

function stripCode(text) {
  return String(text || "").replace(/```[\s\S]*?```/g, " ");
}

function normalizeWhitespace(text) {
  return String(text || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function splitCandidateLines(text) {
  return normalizeWhitespace(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*•]\s+/, "").replace(/^\d+\.\s+/, "").replace(/^>\s+/, "").trim())
    .filter((line) => line.length >= 8)
    .filter((line) => !/^(import|const|let|function|class|export|interface|type|npm |node |git |curl |psql )\b/i.test(line));
}

function countBullets(text) {
  return String(text || "").split("\n").filter((line) => /^(\s*[-*•]|\s*\d+\.)\s+/.test(line)).length;
}

function firstSentences(text, limit = 3) {
  return normalizeWhitespace(text)
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function truncate(text, maxChars) {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars - 1).trimEnd() + "…";
}

function summarizeCapture(text, opts) {
  const cleaned = stripCode(text);
  const candidateLines = splitCandidateLines(cleaned);
  const priority = candidateLines.filter((line) => STRONG_SIGNAL.test(line) || DOMAIN_SIGNAL.test(line) || TRADEOFF_SIGNAL.test(line));
  const selected = [];
  for (const line of [...priority, ...candidateLines]) {
    if (selected.includes(line)) continue;
    selected.push(line);
    if (selected.length >= opts.maxBullets) break;
  }
  if (selected.length >= 2) return truncate(selected.join(" | "), opts.maxChars);
  return truncate(firstSentences(cleaned, 3).join(" "), opts.maxChars);
}

function classifyCapture(text, opts) {
  const cleaned = stripCode(text);
  const normalized = normalizeWhitespace(cleaned);
  if (!normalized || normalized.length < opts.minChars) return null;
  if (SKIP_PATTERNS.some((pattern) => pattern.test(normalized))) return null;

  const bulletCount = countBullets(text);
  const score =
    (STRONG_SIGNAL.test(normalized) ? 3 : 0) +
    (DOMAIN_SIGNAL.test(normalized) ? 2 : 0) +
    (TRADEOFF_SIGNAL.test(normalized) ? 1 : 0) +
    (bulletCount >= 2 ? 1 : 0);

  if (score < 4) return null;

  const summary = summarizeCapture(normalized, opts);
  if (!summary || summary.length < 40) return null;

  let type = "decision";
  let category = "best_practice";
  let importance = 7;
  let tier = "warm";
  const tags = ["live-capture", "outbound-recommendation"];

  if (GOTCHA_SIGNAL.test(normalized)) {
    type = "gotcha";
    category = "correction";
    importance = 8;
    tier = "hot";
    tags.push("gotcha");
  } else if (SECURITY_SIGNAL.test(normalized)) {
    type = "decision";
    category = "best_practice";
    importance = 8;
    tier = "hot";
    tags.push("security");
  } else if (ARCH_SIGNAL.test(normalized)) {
    type = "decision";
    category = "infrastructure";
    importance = 7;
    tier = "hot";
    tags.push("architecture");
  }

  if (/stack/i.test(normalized)) tags.push("stack");
  if (/auth|authentication|oauth|jwt|better auth|clerk|lucia/i.test(normalized)) tags.push("auth");
  if (/tradeoff|better than|instead of|en vez de|porque|por qu[eé]/i.test(normalized)) tags.push("tradeoff");

  return { summary, type, category, importance, tier, tags };
}

async function ensureProcessedMarker(key, payload) {
  const dir = path.join(STATE_DIR, "brainx-live-capture", "processed");
  await fs.mkdir(dir, { recursive: true });
  const markerPath = path.join(dir, `${key}.json`);
  try {
    await fs.access(markerPath);
    return true;
  } catch {
    await fs.writeFile(markerPath, JSON.stringify(payload, null, 2), "utf8");
    return false;
  }
}

async function writeDailyMemory(workspaceDir, entry) {
  const dateKey = entry.timestamp.slice(0, 10);
  const memoryDir = path.join(workspaceDir, "memory");
  const memoryPath = path.join(memoryDir, `${dateKey}.md`);
  const bullet = `- [live:${entry.key}] ${entry.timestamp} | agent=${entry.agentId} | type=${entry.type} | ${entry.summary}`;
  await fs.mkdir(memoryDir, { recursive: true });

  let current = "";
  try {
    current = await fs.readFile(memoryPath, "utf8");
  } catch {
    current = `# ${dateKey}\n\n## Near-Real-Time Captures\n\n`;
  }

  if (current.includes(`[live:${entry.key}]`)) return { ok: true, skipped: true, path: memoryPath };
  if (!current.includes("## Near-Real-Time Captures")) {
    current = current.trimEnd() + "\n\n## Near-Real-Time Captures\n\n";
  } else if (!/\n\n$/.test(current)) {
    current = current.trimEnd() + "\n\n";
  }

  const updated = current.trimEnd() + "\n" + bullet + "\n";
  await fs.writeFile(memoryPath, updated, "utf8");
  return { ok: true, skipped: false, path: memoryPath };
}

function loadEnv() {
  try {
    const dotenv = brainxRequire("dotenv");
    dotenv.config({ path: path.join(STATE_DIR, ".env"), quiet: true });
    dotenv.config({ path: path.join(BRAINX_DIR, ".env"), quiet: true, override: true });
  } catch {
    // Non-fatal.
  }
}

let cachedRag = null;
function getRag() {
  if (cachedRag) return cachedRag;
  cachedRag = brainxRequire(path.join(BRAINX_DIR, "lib", "openai-rag.js"));
  return cachedRag;
}

async function storeInBrainx(entry) {
  const rag = getRag();
  return rag.storeMemory({
    id: `m_live_${Date.now()}_${entry.key.slice(0, 8)}`,
    type: entry.type,
    content: entry.summary,
    context: `agent:${entry.agentId}`,
    tier: entry.tier,
    importance: entry.importance,
    agent: entry.agentId,
    tags: entry.tags,
    category: entry.category,
    sourceKind: "summary_derived",
    sourcePath: entry.sourcePath,
    confidence: 0.72,
    verificationState: "changelog"
  });
}

export default async function brainxLiveCapture(event) {
  const startedAtMs = Date.now();
  if (!event || event.type !== "message" || event.action !== "sent") return;

  const context = event.context && typeof event.context === "object" ? event.context : {};
  if (context.success !== true) return;
  const opts = await getHookOptions();
  if (!opts.allowGroups && context.isGroup) return;

  const agentId = extractAgentId(event.sessionKey);
  if (EXCLUDED_AGENTS.has(agentId)) return;

  const content = typeof context.content === "string" ? context.content : "";
  const capture = classifyCapture(content, opts);
  if (!capture) {
    await logOutcome({
      message: "processed",
      outcome: "low_signal",
      agentId,
      sessionKey: event.sessionKey || null,
      messageId: context.messageId || null,
      channelId: context.channelId || null,
      contentLength: content.length,
      latencyMs: Date.now() - startedAtMs
    });
    return;
  }

  loadEnv();

  const sourcePath = [
    `session:${typeof event.sessionKey === "string" ? event.sessionKey : "unknown"}`,
    `message:${context.messageId || "unknown"}`,
    `channel:${context.channelId || "unknown"}`
  ].join("|");
  const eventTimestamp = event.timestamp instanceof Date ? event.timestamp.toISOString() : nowIso();
  const key = sha(`${event.sessionKey}|${context.messageId || ""}|${capture.summary}`).slice(0, 16);
  const markerPayload = {
    key,
    sessionKey: event.sessionKey,
    agentId,
    createdAt: nowIso(),
    sourcePath,
    summary: capture.summary
  };

  const alreadyProcessed = await ensureProcessedMarker(key, markerPayload);
  if (alreadyProcessed) {
    await logOutcome({
      message: "processed",
      outcome: "duplicate",
      agentId,
      key,
      sessionKey: event.sessionKey || null,
      messageId: context.messageId || null,
      channelId: context.channelId || null,
      latencyMs: Date.now() - startedAtMs
    });
    return;
  }

  const workspaceDir = await resolveWorkspaceDir(agentId);
  const entry = {
    ...capture,
    key,
    agentId,
    timestamp: eventTimestamp,
    sourcePath,
    tags: [
      ...capture.tags,
      `agent:${agentId}`,
      `channel:${context.channelId || "unknown"}`
    ]
  };

  let memoryResult = null;
  let brainxResult = null;
  let brainxError = null;
  let dailyMemoryError = null;

  try {
    if (opts.storeToDailyMemory && workspaceDir) {
      memoryResult = await writeDailyMemory(workspaceDir, entry);
    }
  } catch (err) {
    dailyMemoryError = err?.message || String(err);
    await logLine("daily_memory_write_failed", {
      agentId,
      key,
      error: dailyMemoryError
    });
  }

  try {
    if (opts.storeToBrainx) {
      brainxResult = await storeInBrainx(entry);
    }
  } catch (err) {
    brainxError = err?.message || String(err);
    await logLine("brainx_store_failed", {
      agentId,
      key,
      error: brainxError
    });
  }

  if (!memoryResult && !brainxResult) {
    try {
      await fs.unlink(path.join(STATE_DIR, "brainx-live-capture", "processed", `${key}.json`));
    } catch {
      // Best effort.
    }
    await logOutcome({
      message: "processed",
      outcome: "capture_failed",
      agentId,
      key,
      sessionKey: event.sessionKey || null,
      messageId: context.messageId || null,
      channelId: context.channelId || null,
      workspaceDir: workspaceDir || null,
      storedDailyMemory: false,
      storedBrainx: false,
      brainxSkipped: Boolean(brainxResult?.skipped),
      dailyMemoryError,
      brainxError,
      error: dailyMemoryError || brainxError || "all stores failed",
      latencyMs: Date.now() - startedAtMs
    });
    return;
  }

  await logOutcome({
    message: "processed",
    outcome: "captured",
    agentId,
    key,
    sessionKey: event.sessionKey || null,
    messageId: context.messageId || null,
    channelId: context.channelId || null,
    workspaceDir: workspaceDir || null,
    storedDailyMemory: Boolean(memoryResult?.ok),
    storedBrainx: Boolean(brainxResult && !brainxResult.skipped),
    brainxSkipped: Boolean(brainxResult?.skipped),
    dailyMemoryError,
    brainxError,
    latencyMs: Date.now() - startedAtMs
  });
}
