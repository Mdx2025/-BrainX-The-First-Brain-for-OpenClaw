'use strict';
// BRAINX_COST_TRACKING_20260608
/**
 * BrainX — Agent LLM bridge.
 *
 * Routes BrainX housekeeping "chat" calls (distillation, trajectory/rule
 * extraction) through a Hermes-jailed OpenClaw gateway agent. The default
 * agent `brainx-semantic-reviewer` resolves to gpt-5-nano on the metered
 * OpenAI API (provider `openai-brainx-reviewer`, baseUrl api.openai.com) and
 * has no shell, filesystem mutation, or sub-agent tools. The separate
 * `brainx-reviewer` agent remains the cron/operations owner with exec/process.
 *
 * Embeddings are NOT handled here — those stay on their own client.
 *
 * Contract: callAgentLLM returns the agent reply text verbatim. Callers that
 * expect JSON should pass it through extractJson().
 */

const { execFile } = require('child_process');
const crypto = require('crypto');
const { recordCost } = require('./cost-tracker');

const OPENCLAW_BIN = process.env.OPENCLAW_BIN || 'openclaw';
const DEFAULT_AGENT = process.env.BRAINX_LLM_AGENT || 'brainx-semantic-reviewer';
// BRAINX_GATEWAY_REVIEWER_LANE_ISOLATION_20260721: Gateway fallbacks never consume the interactive main lane.
const DEFAULT_LANE = (process.env.BRAINX_LLM_LANE || 'brainx').trim() || 'brainx';
// BRAINX_REVIEWER_THINKING_COST_GUARD_20260701: reasoning tokens are billed as
// output. These are background housekeeping calls (JSON review/distill), not
// user-facing reasoning — reasoning burned ~4000 tokens/call (MiniMax-M3 did the
// same task in <800). The fix lives in the agent config (`thinkingDefault: off`);
// we do NOT force a per-call --thinking by default because the level is validated
// against the RESOLVED model and the fallback chain mixes providers (gemini
// flash-lite only accepts "off", gpt-5-nano accepts minimal/low) — an explicit
// level errors when a fallback model doesn't support it, killing the call.
// Leave empty to defer to the agent's thinkingDefault (robust across fallback);
// set BRAINX_LLM_THINKING only to force a specific level for a single-model agent.
const DEFAULT_THINKING = (process.env.BRAINX_LLM_THINKING || '').trim();
// gpt-5.5 turns carry a large system prompt; floor the timeout so big
// transcripts don't get cut off by a caller's tighter OpenAI-era timeout.
const TIMEOUT_FLOOR_MS = 120000;
// BRAINX_AGENT_LLM_OWNER_TIMEOUT_NO_EXTERNAL_KILL_20260721: serialize Gateway
// fallbacks in-process and let the owning OpenClaw run enforce --timeout.
// No execFile timeout means this bridge cannot SIGTERM/SIGKILL an accepted agent.
let gatewayTail = Promise.resolve();
async function withGatewaySlot(work) {
  const previous = gatewayTail;
  let release;
  gatewayTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try { return await work(); } finally { release(); }
}

// BRAINX_COST_FLAT_CHANNEL_20260703: channels billed flat/subscription — calls
// routed through them must land in the ledger with cost_usd=0 even when a
// metered pricing row exists for the bare model name (MiniMax-M3 has one for
// hypothetical metered use; the portal channel doesn't bill per token).
const FLAT_COST_CHANNELS = (process.env.BRAINX_COST_FLAT_CHANNELS || 'minimax-portal')
  .split(',').map((s) => s.trim()).filter(Boolean);

function splitProviderModel(id) {
  const s = String(id || '').trim();
  const slash = s.indexOf('/');
  return slash > 0 ? { channel: s.slice(0, slash), bare: s.slice(slash + 1) } : { channel: '', bare: s };
}

// The gateway's agentMeta.model may come back bare (no provider prefix). When it
// matches the override's model part, the call ran on the override's channel; a
// mismatch means a cross-provider fallback fired and the channel is unknown →
// fail toward priced (never silently zero a metered call).
function resolveFlatChannel(modelOverride, resolvedModel) {
  const resolved = splitProviderModel(resolvedModel);
  if (resolved.channel) return FLAT_COST_CHANNELS.includes(resolved.channel);
  const override = splitProviderModel(modelOverride);
  if (!override.channel) return false;
  return resolved.bare === override.bare && FLAT_COST_CHANNELS.includes(override.channel);
}

function buildMessage(system, user) {
  const sys = String(system || '').trim();
  const usr = String(user || '').trim();
  return sys ? `${sys}\n\n---\n\n${usr}` : usr;
}

/**
 * Run one agent turn and return its reply text + usage.
 * `model` overrides the agent's configured model for this run only
 * (provider/model id, e.g. `minimax-portal/MiniMax-M3` for the cost-0 path).
 * @param {{system?:string, user:string, agent?:string, model?:string, timeoutMs?:number, label?:string, lane?:string}} opts
 * @returns {Promise<{text:string, usage:object, model:string|null, sessionId:string}>}
 */
async function callAgentLLM(opts = {}) {
  const { system, user, label } = opts;
  const agent = opts.agent || DEFAULT_AGENT;
  const modelOverride = opts.model ? String(opts.model).trim() : '';
  const timeoutMs = Math.max(parseInt(opts.timeoutMs, 10) || 0, TIMEOUT_FLOOR_MS);
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const lane = (opts.lane != null ? String(opts.lane) : DEFAULT_LANE).trim() || DEFAULT_LANE;
  const message = buildMessage(system, user);
  if (!message) throw new Error('AGENT_LLM_EMPTY_MESSAGE');

  // Ephemeral session id per call: keeps each turn isolated (no context
  // accumulation across runs). Session-cleanup cron prunes these.
  const sessionId = `brainx-${label || 'llm'}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const args = ['agent', '--agent', agent, '--json', '--session-id', sessionId, '--lane', lane, '--timeout', String(timeoutSeconds)];
  if (modelOverride) args.push('--model', modelOverride);
  const thinking = (opts.thinking != null ? String(opts.thinking) : DEFAULT_THINKING).trim();
  if (thinking && thinking !== 'off') args.push('--thinking', thinking);
  args.push('-m', message);

  const stdout = await withGatewaySlot(() => new Promise((resolve, reject) => {
    execFile(
      OPENCLAW_BIN,
      args,
      { maxBuffer: 32 * 1024 * 1024, env: process.env },
      (err, out, errOut) => {
        if (err) {
          const tag = /timed? ?out|timeout/i.test(`${err.message || ''} ${errOut || ''}`) ? 'AGENT_LLM_TIMEOUT' : 'AGENT_LLM_FAIL';
          return reject(new Error(`${tag}(${agent}): ${(err.message || '').slice(0, 200)} ${String(errOut || '').slice(0, 300)}`));
        }
        resolve(out);
      }
    );
  }));

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`AGENT_LLM_BAD_JSON(${agent}): ${String(stdout).slice(0, 300)}`);
  }

  if (parsed.status && parsed.status !== 'ok') {
    throw new Error(`AGENT_LLM_STATUS(${agent}): ${parsed.status} ${JSON.stringify(parsed.error || '').slice(0, 200)}`);
  }

  const text = parsed?.result?.payloads?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error(`AGENT_LLM_NO_TEXT(${agent}): ${JSON.stringify(parsed).slice(0, 300)}`);
  }

  const usage = parsed?.result?.meta?.agentMeta?.usage || {};
  const model = parsed?.result?.meta?.agentMeta?.model || null;

  // Record cost for distill/recap LLM calls (fire-and-forget).
  recordCost({
    operation_type: 'distill_or_recap',
    provider: 'openai:brainx_models',
    model: model || agent,
    // BRAINX_COST_AGENT_ATTRIBUTION_20260702: reviewer profile as agent_id
    // (was always NULL — blocked per-agent cost/utility analysis).
    agent_id: agent,
    input_tokens: usage.input_tokens ?? usage.prompt_tokens ?? usage.input ?? null,
    output_tokens: usage.output_tokens ?? usage.completion_tokens ?? usage.output ?? null,
    total_tokens: usage.total_tokens ?? usage.total ?? null,
    surface: 'cron',
    // BRAINX_COST_LABEL_ATTRIBUTION_20260628: keep the caller's label in call_site
    // so the cost ledger can attribute spend per extractor (turn-harvest, distiller,
    // trajectory, method-error, learning-detail, post-turn-review) instead of lumping
    // everything under the reviewer agent. Enables evidence-based consolidation.
    call_site: `agent-llm.js:callAgentLLM(${agent}):${label || 'llm'}`,
    status: 'ok',
    flat_channel: resolveFlatChannel(modelOverride, model),
  });

  return { text: text.trim(), usage, model, sessionId };
}

function parseBalancedJsonValue(text, start) {
  const opening = text[start];
  if (opening !== '{' && opening !== '[') return null;

  const expectedClosers = opening === '{' ? ['}'] : [']'];
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') expectedClosers.push('}');
    else if (char === '[') expectedClosers.push(']');
    else if (char === '}' || char === ']') {
      if (char !== expectedClosers.at(-1)) return null;
      expectedClosers.pop();
      if (expectedClosers.length === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Parse JSON from an agent reply, tolerating accidental ```json fences or
 * leading/trailing prose. When a model appends prose or another value after a
 * complete object, preserve the first complete object rather than rejecting
 * the otherwise valid reply. Throws if no JSON object/array is found.
 */
function extractJson(text) {
  let s = String(text || '').trim();
  // Strip markdown code fences if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    // BRAINX_EXTRACT_JSON_BALANCED_VALUE_20260726: do not use first-open to
    // last-close slicing. It rejects a valid JSON reply when a provider
    // appends prose/a second value, and it is confused by braces in strings.
    for (let start = 0; start < s.length; start += 1) {
      const parsed = parseBalancedJsonValue(s, start);
      if (parsed !== null) return parsed;
    }
    throw new Error(`extractJson: no JSON found in agent reply: ${s.slice(0, 200)}`);
  }
}

module.exports = { callAgentLLM, extractJson, resolveFlatChannel };
