#!/usr/bin/env node
/**
 * auto-promoter.js — Detects high-recurrence patterns and generates
 * promotion suggestions for canonical agent-core reference sections.
 *
 * Does NOT write to canonical files. Outputs suggestions only.
 * Optionally saves suggestions as BrainX memories (--save).
 *
 * Promotion criteria:
 * - Recurrence >= 6 (configurable)
 * - Importance >= 8
 * - Occurred within last 30 days
 *
 * Usage:
 *   node scripts/auto-promoter.js [--min-recurrence 6] [--days 30] [--json] [--save] [--dry-run]
 */

try {
  const dotenv = require('dotenv');
  const path = require('path');
  const envPath = process.env.BRAINX_ENV || path.join(__dirname, '..', '.env');
  dotenv.configDotenv({ path: envPath });
} catch (_) {}

const path = require('path');
const { execFileSync } = require('child_process');
const { isLowSignalPromotionRule } = require('../lib/promotion-governance');

const BRAINX_CLI = path.join(__dirname, '..', 'brainx');
const PROMOTED_RULES_PATH = process.env.BRAINX_PROMOTION_REFERENCE_FILE
  || '/home/clawd/.openclaw/skills/agent-core/references/BRAINX_PROMOTED_RULES.md';

function parseArgs(argv) {
  const defaultMinRecurrence = parseInt(process.env.BRAINX_PROMOTER_MIN_RECURRENCE || '6', 10);
  const args = { minRecurrence: defaultMinRecurrence, days: 30, json: false, save: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--min-recurrence' && argv[i + 1]) args.minRecurrence = parseInt(argv[i + 1], 10) || defaultMinRecurrence;
    if (argv[i] === '--days' && argv[i + 1]) args.days = parseInt(argv[i + 1], 10) || 30;
    if (argv[i] === '--json') args.json = true;
    if (argv[i] === '--save') args.save = true;
    if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

function isPromotableSuggestion(suggestion) {
  const text = `${suggestion.description || ''} ${suggestion.rule || ''}`.toLowerCase();
  if (!text.trim()) return false;
  if (isLowSignalPromotionRule(suggestion.rule || suggestion.description)) return false;
  if (String(suggestion.patternKey || '').startsWith('tool-failure:')) return false;

  const rejectPatterns = [
    /^\s*\{/,
    /\bactualmente hay \d+\b/,
    /\bse agregó un archivo\b/,
    /\breport\b|\breporte\b/,
    /\bart[íi]culo\b|\barticle\b|\bblog\b|\bdraft\b|\bpublished\b|\bpublicado\b/,
    /\bhealth\b|\bv1\b/,
    /\bjob deshabilitado\b/,
    /\bbug de alineaci[óo]n\b/,
    /\bdeployment\b|\bdeploy\b/,
    /\bfeatured image\b|\bbackfill\b/,
    /\binvitaciones a m[úu]ltiples repositorios\b/,
    /\bmission control\b/,
    /\bnew-closer\b/,
    /\bcommit\b/,
    /\bbrowser failed\b/,
    /\bapply_patch failed\b/,
    /\bvalidation failed for tool\b/,
    /\bgetaddrinfo enotfound\b/,
    /\btab not found\b/,
    /\b\d{4}-\d{2}-\d{2}\b/,
    /\b[0-9a-f]{7,40}\b/,
  ];

  return !rejectPatterns.some((pat) => pat.test(text));
}

function getDb() {
  return require(path.join(__dirname, '..', 'lib', 'db'));
}

function buildTarget(section, label, reason) {
  return {
    section,
    label,
    reason,
    file: path.basename(PROMOTED_RULES_PATH),
    path: PROMOTED_RULES_PATH,
  };
}

function classifyTarget(memory) {
  const content = (memory.content || '').toLowerCase();
  const category = (memory.category || '').toLowerCase();
  const tags = (memory.tags || []).map(t => t.toLowerCase());

  if (category === 'infrastructure' || category === 'error' ||
      tags.some(t => ['cli', 'tool', 'command', 'integration', 'api'].includes(t)) ||
      content.match(/\b(command|cli|api|endpoint|config|path|binary|permission|port|url)\b/)) {
    return buildTarget('tools', 'Tools & Infrastructure', 'Tool/infrastructure pattern');
  }

  if (category === 'best_practice' || category === 'preference' ||
      tags.some(t => ['behavior', 'style', 'tone', 'communication'].includes(t)) ||
      content.match(/\b(always|never|prefer|avoid|style|tone|format|language)\b/)) {
    return buildTarget('behavior', 'Behavior & Tone', 'Behavioral/style pattern');
  }

  return buildTarget('workflow', 'Workflow & Execution', 'Workflow/execution pattern');
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
      AND (p.last_status IS NULL OR p.last_status NOT IN ('resolved', 'wont_fix'))
      AND p.promoted_to IS NULL
      AND m.type IN ('fact', 'decision', 'gotcha')
      AND COALESCE(m.source_kind, '') IN ('consolidated', 'llm_distilled', 'auto_harvested', 'memory_bridge', 'agent_inference', 'tool_verified', 'regex_extraction')
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
      AND status NOT IN ('wont_fix')
      AND type IN ('fact', 'decision', 'gotcha')
      AND COALESCE(source_kind, '') IN ('consolidated', 'llm_distilled', 'auto_harvested', 'memory_bridge', 'agent_inference', 'tool_verified', 'regex_extraction')
    ORDER BY recurrence_count DESC, importance DESC
    LIMIT 20
  `, [args.minRecurrence, String(args.days)]);

  const suggestions = [];

  // Process patterns
  for (const p of patternsResult.rows) {
    const suggestion = {
      source: 'pattern',
      patternKey: p.pattern_key,
      description: p.description,
      recurrence: p.recurrence_count,
      firstSeen: p.first_seen,
      lastSeen: p.last_seen,
      target: classifyTarget({ content: p.description, category: '', tags: [] }),
      rule: distillRule(p.description),
    };
    if (isPromotableSuggestion(suggestion)) suggestions.push(suggestion);
  }

  // Process memories
  for (const m of memoriesResult.rows) {
    // Skip if already covered by a pattern
    if (suggestions.some(s => s.description === m.content)) continue;

    const suggestion = {
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
    };
    if (isPromotableSuggestion(suggestion)) suggestions.push(suggestion);
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
      console.log(`  → [${s.target.section} → ${s.target.file}] (recurrence: ${s.recurrence}x)`);
      console.log(`    Source: ${s.source} | ${s.target.label} | ${s.target.reason}`);
      console.log(`    Reference: ${s.target.path}`);
      console.log(`    Rule: "${s.rule}"`);
      if (s.patternKey) console.log(`    Pattern: ${s.patternKey}`);
      if (s.memoryId) console.log(`    Memory: ${s.memoryId}`);
      console.log('');
    }

    console.log(`⚠️  These are suggestions only. Review and apply them to ${PROMOTED_RULES_PATH} if appropriate.`);
  }

  // Save suggestions as memories (direct DB insert, no CLI spawn per item)
  if (args.save && !args.dryRun) {
    let saved = 0;
    for (const s of suggestions) {
      const content = `[PROMOTION SUGGESTION] → ${s.target.section}\nSection: ${s.target.label}\nReference: ${s.target.path}\nRule: ${s.rule}\nReason: ${s.target.reason}\nRecurrence: ${s.recurrence}x\nSource: ${s.source} (${s.patternKey || s.memoryId || 'unknown'})`;
      const id = `m_promo_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      try {
        await db.query(`
          INSERT INTO brainx_memories (id, content, type, tier, importance, category, tags, source_kind, agent, status, verification_state, created_at, last_seen)
          VALUES ($1, $2, 'decision', 'warm', 7, 'best_practice', $3, 'agent_inference', 'system', 'pending', 'hypothesis', NOW(), NOW())
          ON CONFLICT DO NOTHING
        `, [id, content, '{promotion-suggestion,auto-promoter}']);
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
