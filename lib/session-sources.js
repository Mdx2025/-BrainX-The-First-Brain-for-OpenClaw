'use strict';

// BRAINX_ACP_TRANSCRIPT_HARVEST_20260612
//
// Shared transcript-source discovery + record normalization for BrainX harvesters.
//
// Problem this fixes: every harvester only read ~/.openclaw/agents/<a>/sessions/*.jsonl
// (the OpenClaw runtime session copies). The Claude ACP fleet (real agent names
// are fleet-specific; discovery uses the ~/.claude-<agent> directory layout).
// does its real reasoning in ~/.claude-<a>/projects/<encoded-cwd>/*.jsonl using the
// Claude Code transcript format. Those transcripts (~2GB, fresher than the OpenClaw
// copies) were invisible to every distiller/harvester/trajectory-recorder — so the ACP
// fleet's continuity material was never captured. This was the single largest coverage
// gap found in the 2026-06-12 BrainX loop audit.
//
// This module provides:
//   - findAcpSessions(hoursAgo, opts): discover recent ACP transcripts, mapped to fleet agents
//   - normalizeTranscriptRecord(entry): map BOTH transcript formats to {role, content, timestamp}
// so each harvester keeps its own classification logic and only swaps (a) discovery and
// (b) the per-record discriminator.
//
// Format reference:
//   OpenClaw runtime : { type:'message',                 message:{ role, content:[...] }, timestamp }
//   Claude ACP       : { type:'assistant'|'user', uuid,  message:{ role, content:[...] }, timestamp }
//
// Kill-switch: BRAINX_HARVEST_ACP_TRANSCRIPTS=0 disables ACP discovery without a code rollback.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { isOpsAgent } = require('./ops-agents');

const HARVEST_MARKER = 'BRAINX_ACP_TRANSCRIPT_HARVEST_20260612';
const HOME = process.env.HOME || os.homedir() || '';
const AGENTS_DIR = path.join(HOME, '.openclaw', 'agents');

// ACP transcripts can be large (active sessions seen up to ~57MB). The default ceiling is
// a pure anti-OOM backstop for a pathological/runaway file, NOT a content filter — it is
// set high enough that no legitimate transcript is dropped. Latency-sensitive callers (the
// 20-min turn-harvester, which was just stabilized after rc=124 timeouts) pass a tighter
// opts.maxFileBytes so a giant active session can't blow their time budget; those large
// sessions are still swept by the daily distiller/session-harvester which use this default.
const DEFAULT_MAX_FILE_BYTES = 128 * 1024 * 1024;

function acpHarvestEnabled() {
  const v = process.env.BRAINX_HARVEST_ACP_TRANSCRIPTS;
  if (v === undefined || v === null || v === '') return true;
  return !/^(0|false|off|no)$/i.test(String(v).trim());
}

// Real fleet agents = dirs under AGENTS_DIR, minus ops-only agents (monitor/alert*).
// An ACP store whose <agent> is not a real fleet agent (e.g. operator config dirs,
// operator's terminal config dir) is excluded — it is not a fleet agent and we must not
// harvest the operator's personal terminal sessions.
function realFleetAgents() {
  let dirs = [];
  try { dirs = fs.readdirSync(AGENTS_DIR); } catch (_) { return new Set(); }
  return new Set(dirs.filter((d) => !isOpsAgent(d)));
}

// Discover ~/.claude-<agent>/projects dirs that map to a real fleet agent.
function listAcpStores(agentFilter) {
  const fleet = realFleetAgents();
  let entries = [];
  try { entries = fs.readdirSync(HOME); } catch (_) { return []; }
  const stores = [];
  for (const name of entries) {
    const m = /^\.claude-(.+)$/.exec(name);
    if (!m) continue;
    const agent = m[1];
    // Skip lock/backup/archive siblings (.claude-foo.lock, .claude-foo.bak-..., *.tar.zst)
    if (agent.includes('.lock') || agent.includes('.bak') || /\.(tar|zst|gz|tmp)$/i.test(agent)) continue;
    if (agentFilter && agent !== agentFilter) continue;
    if (!fleet.has(agent)) continue; // excludes operator/extra config dirs
    const projectsDir = path.join(HOME, name, 'projects');
    if (!fs.existsSync(projectsDir)) continue;
    stores.push({ agent, projectsDir });
  }
  return stores;
}

// Find ACP transcript files modified within `hoursAgo`. Returns the SAME shape the
// harvesters' local findRecentSessions produce, with an added source:'acp' tag.
function findAcpSessions(hoursAgo, opts = {}) {
  if (!acpHarvestEnabled()) return [];
  const { agentFilter = null, maxFileBytes = DEFAULT_MAX_FILE_BYTES } = opts;
  const cutoff = Date.now() - hoursAgo * 60 * 60 * 1000;
  const out = [];
  for (const { agent, projectsDir } of listAcpStores(agentFilter)) {
    let projDirs = [];
    try { projDirs = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch (_) { continue; }
    for (const pd of projDirs) {
      if (!pd.isDirectory()) continue;
      const dir = path.join(projectsDir, pd.name);
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.includes('.trajectory')); } catch (_) { continue; }
      for (const file of files) {
        const full = path.join(dir, file);
        let stat;
        try { stat = fs.statSync(full); } catch (_) { continue; }
        if (stat.mtimeMs < cutoff) continue;
        if (stat.size > maxFileBytes) continue;
        out.push({
          agent,
          sessionId: file.replace(/\.jsonl$/, ''),
          path: full,
          modified: stat.mtimeMs,
          size: stat.size,
          source: 'acp',
        });
      }
    }
  }
  return out;
}

// Normalize a transcript record from EITHER format to a common shape, or null when the
// record is not a user/assistant message (session header, queue-operation, summary,
// file-history-snapshot, etc.). Inner content shape is identical across both formats
// (Claude message content array), so callers keep iterating block.type === 'text'.
function normalizeTranscriptRecord(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const t = entry.type;
  let role = null;
  if (t === 'message') {
    role = entry.message && entry.message.role;
  } else if (t === 'assistant' || t === 'user') {
    role = (entry.message && entry.message.role) || t;
  } else {
    return null;
  }
  if (role !== 'assistant' && role !== 'user') return null;
  const msg = entry.message;
  if (!msg) return null;
  const content = Array.isArray(msg.content)
    ? msg.content
    : (typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : null);
  if (!content) return null;
  return {
    role,
    content,
    timestamp: entry.timestamp || (msg && msg.timestamp) || null,
    source: t === 'message' ? 'openclaw' : 'acp',
  };
}

module.exports = {
  HARVEST_MARKER,
  DEFAULT_MAX_FILE_BYTES,
  acpHarvestEnabled,
  realFleetAgents,
  listAcpStores,
  findAcpSessions,
  normalizeTranscriptRecord,
};
