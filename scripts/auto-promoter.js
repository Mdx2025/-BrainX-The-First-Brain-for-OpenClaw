#!/usr/bin/env node
/**
 * auto-promoter.js — Detects high-recurrence patterns and generates
 * promotion suggestions for workspace files.
 *
 * Does NOT write to workspace files. Outputs suggestions only.
 * Optionally saves suggestions as BrainX memories (--save).
 *
 * Promotion criteria:
 * - Recurrence >= 3 (configurable)
 * - Importance >= 8
 * - Occurred within last 30 days
 *
 * Usage:
 *   node scripts/auto-promoter.js [--min-recurrence 3] [--days 30] [--json] [--save] [--dry-run]
 */

try {
  const dotenv = require('dotenv');
  const path = require('path');
  const envPath = process.env.BRAINX_ENV || path.join(__dirname, '..', '.env');
  dotenv.configDotenv({ path: envPath });
} catch (_) {}

const path = require('path');
const { execFileSync } = require('child_process');

const BRAINX_CLI = path.join(__dirname, '..', 'brainx-v5');

function parseArgs(argv) {
  const args = { minRecurrence: 3, days: 30, json: false, save: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--min-recurrence' && argv[i + 1]) args.minRecurrence = parseInt(argv[i + 1], 10) || 3;
    if (argv[i] === '--days' && argv[i + 1]) args.days = parseInt(argv[i + 1], 10) || 30;
    if (argv[i] === '--json') args.json = true;
    if (argv[i] === '--save') args.save = true;
    if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

function getDb() {
  return require(path.join(__dirname, '..', 'lib', 'db'));
}

function classifyTarget(memory) {
  const content = (memory.content || '').toLowerCase();
  const category = (memory.category || '').toLowerCase();
  const tags = (memory.tags || []).map(t => t.toLowerCase());

  if (category === 'infrastructure' || category === 'error' ||
      tags.some(t => ['cli', 'tool', 'command', 'integration', 'api'].includes(t)) ||
      content.match(/\b(command|cli|api|endpoint|config|path|binary|permission|port|url)\b/)) {
    return { file: 'TOOLS.md', reason: 'Tool/infrastructure pattern' };
  }

  if (category === 'best_practice' || category === 'preference' ||
      tags.some(t => ['behavior', 'style', 'tone', 'communication'].includes(t)) ||
      content.match(/\b(always|never|prefer|avoid|style|tone|format|language)\b/)) {
    return { file: 'SOUL.md', reason: 'Behavioral/style pattern' };
  }

  return { file: 'AGENTS.md', reason: 'Workflow/execution pattern' };
}

function distillRule(content) {
  const firstSentence = content.split(/[.\n]/).filter(s => s.trim().length > 10)[0];
  if (firstSentence && firstSentence.length <= 150) return firstSentence.trim();
  return content.slice(0, 150).trim() + '...';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = getDb();

  console.log(`🔍 Scanning for promotion candidates (recurrence >= ${args.minRecurrence}, last ${args.days}d)...\n`);

  // 1. High-recurrence patterns (join with representative memory for content)
  const patternsResult = await db.query(`
    SELECT p.pattern_key, p.recurrence_count, p.first_seen, p.last_seen,
           p.last_status, p.last_category, p.promoted_to,
           COALESCE(m.content, p.pattern_key) AS description
    FROM brainx_patterns p
    LEFT JOIN brainx_memories m ON m.id = p.representative_memory_id
    WHERE p.recurrence_count >= $1
      AND p.last_seen >= NOW() - ($2 || ' days')::interval
      AND (p.last_status IS NULL OR p.last_status NOT IN ('resolved', 'promoted', 'wont_fix'))
      AND p.promoted_to IS NULL
    ORDER BY p.recurrence_count DESC
    LIMIT 20
  `, [args.minRecurrence, String(args.days)]);

  // 2. High-importance recurring memories
  const memoriesResult = await db.query(`
    SELECT id, content, type, category, tags, importance, access_count, agent,
           recurrence_count, created_at, last_seen
    FROM brainx_memories
    WHERE superseded_by IS NULL
      AND importance >= 8
      AND access_count >= 3
      AND recurrence_count >= $1
      AND last_seen >= NOW() - ($2 || ' days')::interval
      AND status NOT IN ('promoted', 'wont_fix')
    ORDER BY recurrence_count DESC, importance DESC
    LIMIT 20
  `, [args.minRecurrence, String(args.days)]);

  const suggestions = [];

  // Process patterns
  for (const p of patternsResult.rows) {
    suggestions.push({
      source: 'pattern',
      patternKey: p.pattern_key,
      description: p.description,
      recurrence: p.recurrence_count,
      firstSeen: p.first_seen,
      lastSeen: p.last_seen,
      target: classifyTarget({ content: p.description, category: '', tags: [] }),
      rule: distillRule(p.description),
    });
  }

  // Process memories
  for (const m of memoriesResult.rows) {
    // Skip if already covered by a pattern
    if (suggestions.some(s => s.description === m.content)) continue;

    suggestions.push({
      source: 'memory',
      memoryId: m.id,
      description: m.content.slice(0, 200),
      type: m.type,
      category: m.category,
      recurrence: m.recurrence_count,
      importance: m.importance,
      accessCount: m.access_count,
      agent: m.agent,
      target: classifyTarget(m),
      rule: distillRule(m.content),
    });
  }

  if (suggestions.length === 0) {
    console.log('✅ No promotion candidates found. Patterns are either too recent or already promoted.');
    try { await db.end(); } catch (_) {}
    return;
  }

  if (args.json) {
    console.log(JSON.stringify({ ok: true, count: suggestions.length, suggestions }, null, 2));
  } else {
    console.log(`📋 Found ${suggestions.length} promotion candidates:\n`);
    for (const s of suggestions) {
      console.log(`  → [${s.target.file}] (recurrence: ${s.recurrence}x)`);
      console.log(`    Source: ${s.source} | ${s.target.reason}`);
      console.log(`    Rule: "${s.rule}"`);
      if (s.patternKey) console.log(`    Pattern: ${s.patternKey}`);
      if (s.memoryId) console.log(`    Memory: ${s.memoryId}`);
      console.log('');
    }

    console.log('⚠️  These are suggestions only. Review and manually add to workspace files if appropriate.');
  }

  // Save suggestions as memories
  if (args.save && !args.dryRun) {
    let saved = 0;
    for (const s of suggestions) {
      const content = `[PROMOTION SUGGESTION] → ${s.target.file}\nRule: ${s.rule}\nReason: ${s.target.reason}\nRecurrence: ${s.recurrence}x\nSource: ${s.source} (${s.patternKey || s.memoryId || 'unknown'})`;
      try {
        execFileSync(BRAINX_CLI, [
          'add',
          '--type', 'decision',
          '--content', content,
          '--tier', 'warm',
          '--importance', '7',
          '--category', 'best_practice',
          '--tags', 'promotion-suggestion,auto-promoter',
          '--sourceKind', 'agent_inference',
        ], { encoding: 'utf8', timeout: 15000 });
        saved++;
      } catch (e) {
        console.error(`  ⚠️ Failed to save suggestion: ${e.message?.slice(0, 100)}`);
      }
    }
    console.log(`\n💾 Saved ${saved} suggestions as BrainX memories (tag: promotion-suggestion)`);
  }

  try { await db.end(); } catch (_) {}
}

main().catch(e => {
  console.error(e.message || e);
  process.exit(1);
});
