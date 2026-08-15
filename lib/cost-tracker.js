'use strict';
// BRAINX_COST_TRACKING_20260608
// Cost ledger for BrainX LLM operations.
// Fire-and-forget inserts into brainx_cost_events; failures never block callers.

const { AsyncLocalStorage } = require('async_hooks');

// AsyncLocalStorage carries per-call context (operation_type, agent_id, etc.)
// into recordCost() without changing embed() / search() signatures.
const costContext = new AsyncLocalStorage();

// Lazy-loaded db module (same pattern as cli.js).
let _db = null;
function getDb() {
  if (!_db) _db = require('./db');
  return _db;
}

// Optional override for tests / plugin runtime.
let _dbOverride = null;
function setDbGetter(fn) {
  _dbOverride = fn;
}

// Pricing-aware insert: cost_usd derived from brainx_model_pricing at write time.
// BRAINX_COST_FLAT_CHANNEL_20260703: $15 (flat_channel) zeroes cost_usd when the
// call was routed through a subscription/flat channel (e.g. minimax-portal) —
// the per-model pricing row must not price calls the channel doesn't bill.
const INSERT_SQL = `
  INSERT INTO brainx_cost_events
    (operation_type, model, provider, input_tokens, output_tokens, total_tokens,
     cost_usd, agent_id, session_id, surface, call_site, request_id,
     duration_ms, status, error_message)
  SELECT
    $1::text,
    $2::text,
    $3::text,
    $4::integer,
    $5::integer,
    $6::integer,
    CASE WHEN COALESCE($15::boolean, false) THEN 0::numeric ELSE COALESCE(
      (
        COALESCE($4, 0)::numeric * p.input_per_1k / 1000.0 +
        COALESCE($5, 0)::numeric * p.output_per_1k / 1000.0
      ),
      0::numeric
    ) END,
    $7::text,
    $8::text,
    $9::text,
    $10::text,
    $11::text,
    $12::integer,
    $13::text,
    $14::text
  FROM (SELECT 1) AS _dummy
  LEFT JOIN brainx_model_pricing p ON p.model = $2
`.trim();

/**
 * Record one LLM cost event. Fire-and-forget — never throws, never blocks.
 */
function recordCost(data) {
  const ctx = costContext.getStore() || {};
  const op = data.operation_type || ctx.operation_type || 'embedding_add';

  setImmediate(async () => {
    try {
      const db = _dbOverride ? _dbOverride() : getDb();
      const resolved = (db && typeof db.then === 'function') ? await db : db;
      await resolved.query(INSERT_SQL, [
        op,
        data.model || 'unknown',
        data.provider || ctx.provider || 'openai',
        data.input_tokens ?? null,
        data.output_tokens ?? null,
        data.total_tokens ?? null,
        data.agent_id ?? ctx.agent_id ?? null,
        data.session_id ?? ctx.session_id ?? null,
        data.surface ?? ctx.surface ?? null,
        data.call_site ?? ctx.call_site ?? null,
        data.request_id ?? null,
        data.duration_ms ?? null,
        data.status || 'ok',
        data.error_message ?? null,
        data.flat_channel === true,
      ]);
    } catch (_err) {
      // Silently ignore — cost tracking must never break the caller.
    }
  });
}

/**
 * Run fn inside an AsyncLocalStorage context.
 * Returned value is whatever fn() returns.
 */
function withCostContext(ctx, fn) {
  return costContext.run(ctx, fn);
}

/**
 * Flush pending setImmediate cost inserts. Use in cron scripts before exit.
 */
async function flushPending(timeoutMs = 3000) {
  await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 5000)));
}

module.exports = { recordCost, withCostContext, setDbGetter, flushPending, costContext };
