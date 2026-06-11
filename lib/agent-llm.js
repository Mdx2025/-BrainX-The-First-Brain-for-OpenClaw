'use strict';
// BRAINX_COST_TRACKING_20260608
/**
 * BrainX — Agent LLM bridge.
 *
 * Routes BrainX housekeeping "chat" calls (distillation, trajectory/rule
 * extraction) through the OpenClaw gateway agent. The default agent
 * `brainx-reviewer` resolves to gpt-5-mini on the metered OpenAI API
 * (provider `openai-metered`, baseUrl api.openai.com) — a dedicated provider
 * key is required because the shared `openai` provider delegates gpt-5* model
 * ids to the ChatGPT/Codex OAuth account, which does not serve gpt-5-mini.
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
const DEFAULT_AGENT = process.env.BRAINX_LLM_AGENT || 'brainx-reviewer';
// gpt-5.5 turns carry a large system prompt; floor the timeout so big
// transcripts don't get cut off by a caller's tighter OpenAI-era timeout.
const TIMEOUT_FLOOR_MS = 120000;

function buildMessage(system, user) {
  const sys = String(system || '').trim();
  const usr = String(user || '').trim();
  return sys ? `${sys}\n\n---\n\n${usr}` : usr;
}

/**
 * Run one agent turn and return its reply text + usage.
 * @param {{system?:string, user:string, agent?:string, timeoutMs?:number, label?:string}} opts
 * @returns {Promise<{text:string, usage:object, model:string|null, sessionId:string}>}
 */
async function callAgentLLM(opts = {}) {
  const { system, user, label } = opts;
  const agent = opts.agent || DEFAULT_AGENT;
  const timeoutMs = Math.max(parseInt(opts.timeoutMs, 10) || 0, TIMEOUT_FLOOR_MS);
  const message = buildMessage(system, user);
  if (!message) throw new Error('AGENT_LLM_EMPTY_MESSAGE');

  // Ephemeral session id per call: keeps each turn isolated (no context
  // accumulation across runs). Session-cleanup cron prunes these.
  const sessionId = `brainx-${label || 'llm'}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const args = ['agent', '--agent', agent, '--json', '--session-id', sessionId, '-m', message];

  const stdout = await new Promise((resolve, reject) => {
    execFile(
      OPENCLAW_BIN,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: process.env },
      (err, out, errOut) => {
        if (err) {
          const tag = err.killed ? 'AGENT_LLM_TIMEOUT' : 'AGENT_LLM_FAIL';
          return reject(new Error(`${tag}(${agent}): ${(err.message || '').slice(0, 200)} ${String(errOut || '').slice(0, 300)}`));
        }
        resolve(out);
      }
    );
  });

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
    model: model || agent,
    input_tokens: usage.input_tokens ?? usage.prompt_tokens ?? usage.input ?? null,
    output_tokens: usage.output_tokens ?? usage.completion_tokens ?? usage.output ?? null,
    total_tokens: usage.total_tokens ?? usage.total ?? null,
    surface: 'cron',
    call_site: `agent-llm.js:callAgentLLM(${agent})`,
    status: 'ok',
  });

  return { text: text.trim(), usage, model, sessionId };
}

/**
 * Parse JSON from an agent reply, tolerating accidental ```json fences or
 * leading/trailing prose. Throws if no JSON object/array is found.
 */
function extractJson(text) {
  let s = String(text || '').trim();
  // Strip markdown code fences if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    // Fall back to the first {...} or [...] span.
    const start = s.search(/[[{]/);
    const end = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
    if (start !== -1 && end > start) {
      return JSON.parse(s.slice(start, end + 1));
    }
    throw new Error(`extractJson: no JSON found in agent reply: ${s.slice(0, 200)}`);
  }
}

module.exports = { callAgentLLM, extractJson };
