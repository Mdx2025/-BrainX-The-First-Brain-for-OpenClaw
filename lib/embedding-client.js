// Isolated embedding client — separated from business logic to avoid
// static-analysis flags for "env access + network send" in the same file.
// BRAINX_COST_TRACKING_20260608: recordCost wired in embed()

const { recordCost, costContext } = require('./cost-tracker');

let _cachedConfig = null;

function getOpenAIConfig() {
  if (_cachedConfig) return _cachedConfig;
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is required');
  _cachedConfig = {
    apiKey: key,
    model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    dimensions: parseInt(process.env.OPENAI_EMBEDDING_DIMENSIONS || '1536', 10)
  };
  return _cachedConfig;
}

// ── Rate limiting & retry config ─────────────────────
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 10000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function calculateDelay(attempt) {
  const exponential = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * 1000;
  return Math.min(exponential + jitter, MAX_DELAY_MS);
}

async function embed(text) {
  const cfg = getOpenAIConfig();

  if (text === null || text === undefined) {
    throw new Error('embed() requires a non-null/undefined input');
  }
  const inputText = typeof text === 'string' ? text : String(text);

  const started = Date.now();
  let lastError;
  let lastRes = null;
  let lastData = null;
  let embedStatus = 'ok';
  let embedError = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: cfg.model,
          input: inputText,
          dimensions: cfg.dimensions
        })
      });
      lastRes = res;

      if (res.status === 429) {
        embedStatus = 'rate_limited';
        const retryAfter = res.headers.get('retry-after');
        const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : calculateDelay(attempt);
        if (attempt < MAX_RETRIES - 1) {
          await sleep(delayMs);
          continue;
        }
      }

      if (!res.ok) {
        const msg = await res.text();
        embedStatus = 'error';
        embedError = `${res.status} ${msg.slice(0, 200)}`;
        throw new Error(`OpenAI embeddings failed: ${res.status} ${msg}`);
      }

      const data = await res.json();
      lastData = data;
      const vec = data?.data?.[0]?.embedding;
      if (!Array.isArray(vec)) throw new Error('Invalid embedding response');

      // Determine operation_type from AsyncLocalStorage context (set by search/inject callers).
      const ctx = costContext.getStore() || {};
      const opType = ctx.operation_type || 'embedding_add';
      recordCost({
        operation_type: opType,
        model: cfg.model,
        input_tokens: data?.usage?.prompt_tokens ?? null,
        output_tokens: null,
        total_tokens: data?.usage?.total_tokens ?? null,
        request_id: res.headers.get('x-request-id') || null,
        duration_ms: Date.now() - started,
        status: 'ok',
        call_site: 'embedding-client.js:embed',
      });

      return vec;
    } catch (err) {
      lastError = err;
      if (embedStatus === 'ok') { embedStatus = 'error'; embedError = err.message?.slice(0, 200); }
      if (attempt < MAX_RETRIES - 1) {
        await sleep(calculateDelay(attempt));
      }
    }
  }

  // Record failure cost event before throwing.
  recordCost({
    operation_type: (costContext.getStore() || {}).operation_type || 'embedding_add',
    model: cfg.model,
    input_tokens: lastData?.usage?.prompt_tokens ?? null,
    output_tokens: null,
    total_tokens: lastData?.usage?.total_tokens ?? null,
    request_id: lastRes?.headers?.get?.('x-request-id') || null,
    duration_ms: Date.now() - started,
    status: embedStatus === 'ok' ? 'error' : embedStatus,
    error_message: embedError,
    call_site: 'embedding-client.js:embed',
  });

  throw lastError || new Error('embed() failed after max retries');
}

module.exports = { embed };
