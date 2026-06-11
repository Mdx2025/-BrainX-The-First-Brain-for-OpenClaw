const fs = require('fs');
const os = require('os');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const TERMINAL_OUTCOMES = new Set(['captured', 'low_signal', 'duplicate', 'capture_failed']);

function getStateDir() {
  return process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), '.openclaw');
}

function getLiveCaptureLogPath(stateDir = getStateDir()) {
  return path.join(stateDir, 'logs', 'brainx-live-capture.log');
}

async function appendLiveCaptureEvent(payload, options = {}) {
  const stateDir = options.stateDir || getStateDir();
  const logPath = getLiveCaptureLogPath(stateDir);
  await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
  const entry = {
    timestamp: payload.timestamp || new Date().toISOString(),
    hook: 'brainx-live-capture',
    ...payload
  };
  await fs.promises.appendFile(logPath, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function toIsoOrNull(value) {
  if (!value) return null;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString();
}

function normalizeEntry(entry) {
  if (!entry || entry.hook !== 'brainx-live-capture') return null;

  let outcome = entry.outcome || null;
  if (!outcome) {
    switch (entry.message) {
      case 'captured':
        outcome = 'captured';
        break;
      case 'capture_failed':
        outcome = 'capture_failed';
        break;
      case 'low_signal_skip':
        outcome = 'low_signal';
        break;
      case 'dedupe_skip':
        outcome = 'duplicate';
        break;
      case 'brainx_store_failed':
        outcome = 'brainx_store_failed';
        break;
      case 'daily_memory_write_failed':
        outcome = 'daily_memory_failed';
        break;
      default:
        return null;
    }
  }

  const timestamp = toIsoOrNull(entry.timestamp);
  if (!timestamp) return null;
  const timestampMs = Date.parse(timestamp);

  const latencyMsRaw = Number(entry.latencyMs);
  const latencyMs = Number.isFinite(latencyMsRaw) ? latencyMsRaw : null;
  const dailyMemoryError = typeof entry.dailyMemoryError === 'string' && entry.dailyMemoryError ? entry.dailyMemoryError : null;
  const brainxError = typeof entry.brainxError === 'string' && entry.brainxError ? entry.brainxError : null;
  const genericError = typeof entry.error === 'string' && entry.error ? entry.error : null;

  const storedDailyMemory = entry.storedDailyMemory === true;
  const storedBrainx = entry.storedBrainx === true;
  const brainxSkipped = entry.brainxSkipped === true;

  const dailyMemoryFailed = outcome === 'daily_memory_failed' || Boolean(dailyMemoryError);
  const brainxStoreFailed = outcome === 'brainx_store_failed' || Boolean(brainxError);
  const captureFailed = outcome === 'capture_failed' || (!storedDailyMemory && !storedBrainx && (dailyMemoryFailed || brainxStoreFailed));
  const success = outcome === 'captured' && (storedDailyMemory || storedBrainx || brainxSkipped);
  const errorDetail = dailyMemoryError || brainxError || genericError || null;

  return {
    timestamp,
    timestampMs,
    outcome,
    latencyMs,
    success,
    captureFailed,
    dailyMemoryFailed,
    brainxStoreFailed,
    errorDetail,
    raw: entry
  };
}

function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarizeBucket(entries) {
  const metrics = {
    seen: 0,
    captured: 0,
    low_signal: 0,
    duplicate: 0,
    capture_failed: 0,
    daily_memory_failures: 0,
    brainx_store_failures: 0,
    latencies: {
      count: 0,
      avg_ms: null,
      p95_ms: null,
      max_ms: null
    }
  };

  const latencies = [];

  for (const entry of entries) {
    if (TERMINAL_OUTCOMES.has(entry.outcome)) metrics.seen += 1;
    if (entry.outcome === 'captured') metrics.captured += 1;
    if (entry.outcome === 'low_signal') metrics.low_signal += 1;
    if (entry.outcome === 'duplicate') metrics.duplicate += 1;
    if (entry.captureFailed) metrics.capture_failed += 1;
    if (entry.dailyMemoryFailed) metrics.daily_memory_failures += 1;
    if (entry.brainxStoreFailed) metrics.brainx_store_failures += 1;

    if (entry.latencyMs != null) latencies.push(entry.latencyMs);
  }

  if (latencies.length > 0) {
    const avg = latencies.reduce((sum, value) => sum + value, 0) / latencies.length;
    metrics.latencies = {
      count: latencies.length,
      avg_ms: Number(avg.toFixed(2)),
      p95_ms: percentile(latencies, 95),
      max_ms: Math.max(...latencies)
    };
  }

  return metrics;
}

function summarizeLiveCapture(options = {}) {
  const stateDir = options.stateDir || getStateDir();
  const logPath = options.logPath || getLiveCaptureLogPath(stateDir);
  const days = Number.isFinite(Number(options.days)) && Number(options.days) > 0 ? Number(options.days) : 7;
  const nowMs = options.now instanceof Date
    ? options.now.getTime()
    : Number.isFinite(Number(options.now))
      ? Number(options.now)
      : Date.now();
  const windowStartMs = nowMs - (days * DAY_MS);
  const last24hStartMs = nowMs - DAY_MS;

  if (!fs.existsSync(logPath)) {
    return {
      exists: false,
      logPath,
      window_days: days,
      totals: summarizeBucket([]),
      last_24h: summarizeBucket([]),
      last_seen_at: null,
      last_success_at: null,
      last_error_at: null,
      last_error: null
    };
  }

  const raw = fs.readFileSync(logPath, 'utf8');
  const entries = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(safeJsonParse)
    .map(normalizeEntry)
    .filter(Boolean);

  const inWindow = entries.filter((entry) => entry.timestampMs >= windowStartMs);
  const last24h = inWindow.filter((entry) => entry.timestampMs >= last24hStartMs);

  const latestSeen = entries.reduce((acc, entry) => (!acc || entry.timestampMs > acc.timestampMs ? entry : acc), null);
  const latestSuccess = entries.reduce((acc, entry) => (entry.success && (!acc || entry.timestampMs > acc.timestampMs) ? entry : acc), null);
  const latestError = entries.reduce((acc, entry) => {
    const isError = entry.captureFailed || entry.dailyMemoryFailed || entry.brainxStoreFailed;
    return isError && (!acc || entry.timestampMs > acc.timestampMs) ? entry : acc;
  }, null);

  return {
    exists: true,
    logPath,
    window_days: days,
    totals: summarizeBucket(inWindow),
    last_24h: summarizeBucket(last24h),
    last_seen_at: latestSeen?.timestamp || null,
    last_success_at: latestSuccess?.timestamp || null,
    last_error_at: latestError?.timestamp || null,
    last_error: latestError?.errorDetail || null
  };
}

module.exports = {
  appendLiveCaptureEvent,
  getLiveCaptureLogPath,
  summarizeLiveCapture
};
