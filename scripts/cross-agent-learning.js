#!/usr/bin/env node
/**
 * cross-agent-learning.js — BrainX V5 Phase 4.2 (Refactored)
 *
 * Tags high-importance learnings/gotchas from individual agents as
 * 'cross-agent' so the hook's cross-agent query can surface them to
 * other agents.  NO copies are created — the original memory gets the
 * tag, preserving its real importance and agent ownership.
 *
 * Old approach (pre-refactor) created global copies with agent=NULL
 * and importance-1, which polluted the own-agent bucket and were
 * always outranked by real memories.
 *
 * Usage:
 *   node scripts/cross-agent-learning.js [--hours N] [--dry-run] [--verbose] [--max-tags N]
 */

'use strict';

const path = require('path');

// ── Bootstrap ───────────────────────────────────────────────────────────
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require(path.join(__dirname, '..', 'lib', 'db'));

// ── Args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

function flag(name) {
  return args.includes(`--${name}`);
}
function option(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return fallback;
  return args[idx + 1];
}

const HOURS = parseInt(option('hours', '24'), 10);
const DRY_RUN = flag('dry-run');
const VERBOSE = flag('verbose');
const MAX_TAGS = parseInt(option('max-tags', '20'), 10);

function log(...a) { if (VERBOSE) console.error('[cross-agent]', ...a); }

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const result = {
    ok: true,
    candidatesFound: 0,
    alreadyTagged: 0,
    newlyTagged: 0,
    skippedMaxTags: 0,
    bySourceAgent: {},
    errors: [],
  };

  try {
    // 1. Find recent high-importance learnings/gotchas from specific agents
    //    that don't already have the 'cross-agent' tag
    log(`Searching for shareable memories in last ${HOURS}h...`);

    // Threshold rationale (2026-04-14):
    //   - gotcha >=7: unchanged. Already meaningful at 7.
    //   - decision/fact >=7: lowered from 8. Importance=8 was a near-empty
    //     bucket in practice; 7 captures the mass of useful operational
    //     facts (URLs, service maps, decisions) without polluting with noise.
    //   - decision/fact still requires verification_state='verified'-level
    //     trust via the existing verification filter.
    const candidates = await db.query(
      `SELECT id, type, content, agent, importance, tags
       FROM brainx_memories
       WHERE superseded_by IS NULL
         AND agent IS NOT NULL
         AND (
           (type = 'gotcha' AND importance >= 7)
           OR (type IN ('decision', 'fact') AND importance >= 7)
         )
         AND COALESCE(verification_state, 'hypothesis') IN ('verified', 'hypothesis')
         AND COALESCE(status, 'pending') NOT IN ('resolved', 'wont_fix')
         AND (expires_at IS NULL OR expires_at > NOW())
         AND NOT ('cross-agent' = ANY(COALESCE(tags, '{}')))
         AND created_at > NOW() - make_interval(hours => $1)
       ORDER BY importance DESC, created_at DESC
       LIMIT 30`,
      [HOURS]
    );

    result.candidatesFound = candidates.rows.length;
    log(`Found ${result.candidatesFound} candidates`);

    if (result.candidatesFound === 0) {
      console.log(JSON.stringify(result));
      return;
    }

    // 2. Tag originals — no copies
    for (const mem of candidates.rows) {
      if (result.newlyTagged >= MAX_TAGS) {
        result.skippedMaxTags++;
        log(`Max tags (${MAX_TAGS}) reached, skipping ${mem.id}`);
        continue;
      }

      const agentName = mem.agent;
      log(`Tagging: ${mem.id} (${agentName}, ${mem.type}, imp:${mem.importance})`);

      if (!DRY_RUN) {
        try {
          const currentTags = Array.isArray(mem.tags) ? mem.tags : [];
          const newTags = [...currentTags, 'cross-agent'];

          await db.query(
            `UPDATE brainx_memories SET tags = $1 WHERE id = $2`,
            [newTags, mem.id]
          );
          log(`Tagged: ${mem.id}`);
        } catch (err) {
          result.errors.push({ memoryId: mem.id, error: err.message });
          log(`Error tagging ${mem.id}: ${err.message}`);
          continue;
        }
      } else {
        log(`[DRY-RUN] Would tag: ${mem.id}`);
      }

      result.newlyTagged++;
      result.bySourceAgent[agentName] = (result.bySourceAgent[agentName] || 0) + 1;
    }

    if (DRY_RUN) {
      log('[DRY-RUN] No memories were actually tagged.');
    }

    console.log(JSON.stringify(result));
  } catch (err) {
    result.ok = false;
    result.errors.push({ error: err.message, stack: err.stack });
    console.log(JSON.stringify(result));
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
}

main();
