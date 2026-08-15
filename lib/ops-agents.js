// OPS_AGENTS_20260503: shared classifier of operational-only agents.
// Source of truth for the BrainX skill (cron scripts in ../scripts), the
// runtime plugin (extensions/brainx), and any tooling that iterates per-agent
// state. Used to permanently exclude these agents from BrainX (capture,
// recall, working memory, wiki digest, advisories, snapshots).
//
// Why pattern-based, not a list: ops agents spawn per-channel Discord variants
// (monitor-d-<channelId>) and could grow more roles (alert-foo, monitor-bar)
// without a config edit. Matching by pattern means any new variant is gated
// from day one — no list maintenance, no future "ops leaked into BrainX"
// regression because someone forgot to add an ID.
//
// Default pattern matches:
//   monitor                        (parent)
//   monitor-public                 (public sibling)
//   monitor-d-<anything>           (Discord variants)
//   monitor-anything               (any future suffix)
//   alert / alert-anything         (same shape)
//
// Overrides (env, runtime):
//   BRAINX_OPS_AGENTS_PATTERN  — custom regex source (case-insensitive). Replaces default pattern.
//   BRAINX_OPS_AGENTS          — comma-separated extra IDs to treat as ops in addition to the pattern.

'use strict';

const DEFAULT_OPS_AGENT_PATTERN = '^(monitor|alert)($|-)';

function compilePattern(source) {
  if (typeof source !== 'string' || !source.trim()) return null;
  try {
    return new RegExp(source.trim(), 'i');
  } catch (_) {
    return null;
  }
}

function parseEnvList(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

const OPS_AGENT_PATTERN =
  compilePattern(process.env.BRAINX_OPS_AGENTS_PATTERN) ||
  compilePattern(DEFAULT_OPS_AGENT_PATTERN);

const EXTRA_OPS_AGENTS = new Set(parseEnvList(process.env.BRAINX_OPS_AGENTS));

function normalizeAgentKey(agentId) {
  if (agentId === null || agentId === undefined) return '';
  return String(agentId).trim().toLowerCase();
}

function isOpsAgent(agentId) {
  const key = normalizeAgentKey(agentId);
  if (!key) return false;
  if (OPS_AGENT_PATTERN && OPS_AGENT_PATTERN.test(key)) return true;
  if (EXTRA_OPS_AGENTS.has(key)) return true;
  return false;
}

module.exports = {
  OPS_AGENT_PATTERN_SOURCE: OPS_AGENT_PATTERN ? OPS_AGENT_PATTERN.source : null,
  EXTRA_OPS_AGENTS: Object.freeze([...EXTRA_OPS_AGENTS]),
  isOpsAgent,
};
