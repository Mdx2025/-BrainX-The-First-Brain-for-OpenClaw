#!/usr/bin/env node
/**
 * promotion-applier.js — Last-mile: reads pending promotion suggestions,
 * uses LLM to distill them into concise rules, and appends them only to the
 * canonical agent-core reference file.
 *
 * Safety:
 * - Never writes to AGENTS.md, TOOLS.md, or SOUL.md
 * - Only appends inside dedicated markers in the canonical reference
 * - Creates a backup before writing
 * - Marks processed suggestions as 'promoted' in DB
 * - Deduplicates: skips rules whose distilled text already exists in the section
 * - Dry-run mode by default (pass --apply to actually write)
 *
 * Usage:
 *   node scripts/promotion-applier.js [--apply] [--limit 10] [--json] [--min-recurrence 5]
 */

try {
  const dotenv = require('dotenv');
  const path = require('path');
  dotenv.configDotenv({ path: process.env.BRAINX_ENV || path.join(__dirname, '..', '.env') });
} catch (_) {}

const fs = require('fs');
const path = require('path');
const {
  CANONICAL_RULES_FILE,
  TARGETS,
  normalizeTargetKey,
  targetKeyToPromotedTo,
  extractRule,
  extractSourcePatternKey,
} = require('../lib/promotion-governance');

function isPromotableSuggestion(text) {
  const normalized = String(text || '').toLowerCase();
  if (!normalized.trim()) return false;
  const rejectPatterns = [
    /^\s*\{/,
    /\bactualmente hay \d+\b/,
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
    /\b\d{4}-\d{2}-\d{2}\b/,
    /\b[0-9a-f]{7,40}\b/,
  ];
  return !rejectPatterns.some((pat) => pat.test(normalized));
}

function parseArgs(argv) {
  const args = { apply: false, forceApply: false, limit: 10, json: false, minRecurrence: 6 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') args.apply = true;
    if (argv[i] === '--force-apply') args.forceApply = true;
    if (argv[i] === '--limit' && argv[i + 1]) args.limit = parseInt(argv[i + 1], 10) || 10;
    if (argv[i] === '--json') args.json = true;
    if (argv[i] === '--min-recurrence' && argv[i + 1]) args.minRecurrence = parseInt(argv[i + 1], 10) || 6;
  }
  return args;
}

function getDb() {
  return require(path.join(__dirname, '..', 'lib', 'db'));
}

function canonicalTemplate(dateStr) {
  return `# BrainX Promoted Rules

Fuente única para reglas promovidas por BrainX.

Reglas:
- BrainX no escribe directo en \`AGENTS.md\`, \`TOOLS.md\` ni \`SOUL.md\`.
- Las promociones review-gated aterrizan solo en este archivo.
- \`agent-core\` debe apuntar aquí desde las plantillas canónicas para evitar drift entre agentes.

**Updated:** ${dateStr}

## Workflow & Execution
${TARGETS.workflow.startMarker}
${TARGETS.workflow.endMarker}

## Tools & Infrastructure
${TARGETS.tools.startMarker}
${TARGETS.tools.endMarker}

## Behavior & Tone
${TARGETS.behavior.startMarker}
${TARGETS.behavior.endMarker}
`;
}

function updateTimestamp(content) {
  const dateStr = new Date().toISOString().split('T')[0];
  if (/\*\*Updated:\*\* .+/m.test(content)) {
    return content.replace(/\*\*Updated:\*\* .+/m, `**Updated:** ${dateStr}`);
  }
  return content;
}

function ensureCanonicalFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, canonicalTemplate('pending'), 'utf-8');
    return true;
  }

  let content = fs.readFileSync(filePath, 'utf-8');
  let changed = false;

  if (!content.includes('# BrainX Promoted Rules')) {
    content = canonicalTemplate('pending').trimEnd() + '\n\n' + content.trimStart();
    changed = true;
  }

  for (const target of Object.values(TARGETS)) {
    if (!content.includes(target.startMarker) || !content.includes(target.endMarker)) {
      content = content.trimEnd()
        + `\n\n## ${target.heading}\n${target.startMarker}\n${target.endMarker}\n`;
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  return true;
}

function parseStoredSuggestion(content) {
  const arrowMatch = String(content || '').match(/→\s*([^\n]+)/);
  const sectionMatch = String(content || '').match(/Section:\s*([^\n]+)/);
  const recMatch = String(content || '').match(/Recurrence:\s*(\d+)x/);

  const targetKey = normalizeTargetKey(sectionMatch?.[1] || arrowMatch?.[1]);

  return {
    targetKey,
    description: extractRule(content) || String(content || '').slice(0, 200),
    recurrence: parseInt(recMatch?.[1], 10) || null,
    sourcePatternKey: extractSourcePatternKey(content),
  };
}

async function distillWithLLM(suggestions) {
  // Routed through the OpenClaw gateway agent (brainx-reviewer / gpt-5.5 OAuth)
  // instead of the OpenAI pay-per-token API. See lib/agent-llm.js.
  const { callAgentLLM } = require(path.join(__dirname, '..', 'lib', 'agent-llm'));

  const grouped = { workflow: [], tools: [], behavior: [] };
  for (const s of suggestions) {
    const targetKey = normalizeTargetKey(s.targetKey);
    grouped[targetKey].push(s);
  }

  const results = {};
  for (const [targetKey, items] of Object.entries(grouped)) {
    if (items.length === 0) continue;

    const target = TARGETS[targetKey];
    const itemsText = items.map((s, i) =>
      `${i + 1}. [${s.recurrence}x] ${s.description?.slice(0, 300) || s.content?.slice(0, 300)}`
    ).join('\n');

    const systemContent = `You distill recurring patterns into concise operational rules for a canonical reference file shared by many AI agents.
Rules must be:
- One line each, starting with "- " (markdown bullet)
- Actionable and specific (not vague)
- In Spanish (matching workspace language)
- Deduplicated (merge similar patterns into one rule)
- Maximum 15 rules total, even if there are more patterns
- Include the recurrence count as context: e.g. "- [×23] Nunca modificar HTML original en migración — solo ajustar paths de recursos."

Target section context:
- Workflow & Execution: ${TARGETS.workflow.description}
- Tools & Infrastructure: ${TARGETS.tools.description}
- Behavior & Tone: ${TARGETS.behavior.description}

Important:
- These rules will be stored in a shared canonical reference, not in AGENTS.md / TOOLS.md / SOUL.md directly.
- Keep the rules generic enough to avoid per-agent drift.

Output ONLY the bullet list. No headers, no explanation.`;

    const { text: rules } = await callAgentLLM({
      system: systemContent,
      user: `Distill these ${items.length} recurring patterns for the "${target.heading}" section:\n\n${itemsText}`,
      label: 'promotion',
    });
    results[targetKey] = { rules, sourceIds: items.map(i => i.id), count: items.length, heading: target.heading };
  }

  return results;
}

function appendRulesToSection(filePath, targetKey, newRules) {
  const target = TARGETS[targetKey];
  const content = fs.readFileSync(filePath, 'utf-8');
  const startIdx = content.indexOf(target.startMarker);
  const endIdx = content.indexOf(target.endMarker);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return { written: 0, skipped: 0, error: `missing markers for ${targetKey}` };
  }

  const bodyStart = startIdx + target.startMarker.length;
  const existingBody = content.slice(bodyStart, endIdx);
  const existingLower = existingBody.toLowerCase();

  const lines = newRules.split('\n').filter(l => l.trim().startsWith('- '));
  let written = 0;
  let skipped = 0;
  const toAppend = [];

  for (const line of lines) {
    const core = line.replace(/^- \[×\d+\]\s*/, '').trim().toLowerCase().slice(0, 60);
    if (!core || existingLower.includes(core)) {
      skipped++;
      continue;
    }
    toAppend.push(line);
    written++;
  }

  if (toAppend.length === 0) return { written: 0, skipped };

  const trimmedBody = existingBody.trim();
  const replacementBody = `\n${trimmedBody ? `${trimmedBody}\n` : ''}${toAppend.join('\n')}\n`;

  let updated = content.slice(0, bodyStart) + replacementBody + content.slice(endIdx);
  updated = updateTimestamp(updated);
  fs.writeFileSync(filePath, updated, 'utf-8');

  return { written, skipped };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = getDb();

  console.log(`🔄 Promotion Applier ${args.apply ? '(APPLY MODE)' : '(DRY-RUN)'}...\n`);

  const { rows: suggestions } = await db.query(`
    SELECT m.id, m.content, m.created_at,
           p.pattern_key, p.recurrence_count, p.last_category
    FROM brainx_memories m
    LEFT JOIN brainx_patterns p ON m.content LIKE '%' || p.pattern_key || '%'
    WHERE 'promotion-suggestion' = ANY(m.tags)
      AND COALESCE(m.status, 'pending') = 'pending'
      AND COALESCE(m.verification_state, 'hypothesis') != 'obsolete'
      AND m.superseded_by IS NULL
    ORDER BY p.recurrence_count DESC NULLS LAST, m.created_at DESC
    LIMIT $1
  `, [args.limit]);

  if (suggestions.length === 0) {
    console.log('✅ No pending promotion suggestions.');
    try { await db.end(); } catch (_) {}
    return;
  }

  const parsed = suggestions.map(s => {
    const parsedSuggestion = parseStoredSuggestion(s.content);
    return {
      id: s.id,
      targetKey: parsedSuggestion.targetKey,
      description: parsedSuggestion.description,
      recurrence: parsedSuggestion.recurrence || s.recurrence_count || 3,
      pattern_key: s.pattern_key,
      content: s.content,
    };
  }).filter(s => s.recurrence >= args.minRecurrence && isPromotableSuggestion(s.description));

  if (parsed.length === 0) {
    console.log(`✅ No suggestions meet minimum recurrence threshold (${args.minRecurrence}x).`);
    try { await db.end(); } catch (_) {}
    return;
  }

  if (args.apply && !args.forceApply && process.env.BRAINX_PROMOTION_AUTO_APPLY !== 'true') {
    throw new Error('Refusing auto-apply without review gate. Use --force-apply for an intentional manual apply or set BRAINX_PROMOTION_AUTO_APPLY=true.');
  }

  console.log(`📋 ${parsed.length} suggestions above ${args.minRecurrence}x recurrence, distilling with LLM...\n`);

  const distilled = await distillWithLLM(parsed);
  const summary = {
    referenceFile: CANONICAL_RULES_FILE,
    sections: {},
    totalWritten: 0,
    totalSkipped: 0,
  };

  ensureCanonicalFile(CANONICAL_RULES_FILE);

  let backupPath = null;
  if (args.apply) {
    backupPath = `${CANONICAL_RULES_FILE}.bak.promo.${Date.now()}`;
    fs.copyFileSync(CANONICAL_RULES_FILE, backupPath);
  }

  for (const [targetKey, data] of Object.entries(distilled)) {
    const target = TARGETS[targetKey];
    console.log(`\n📄 ${target.heading} (${data.count} patterns → distilled rules):`);
    console.log(data.rules);

    if (args.apply) {
      const result = appendRulesToSection(CANONICAL_RULES_FILE, targetKey, data.rules);
      if (result.error) throw new Error(result.error);

      summary.totalWritten += result.written;
      summary.totalSkipped += result.skipped;
      summary.sections[targetKey] = {
        heading: target.heading,
        patternsDistilled: data.count,
        rulesWritten: result.written,
        rulesSkipped: result.skipped,
      };

      if (result.written > 0) {
        console.log(`  ✅ ${CANONICAL_RULES_FILE}: +${result.written} (${result.skipped} dedup)`);
      } else {
        console.log(`  ⏭️ ${CANONICAL_RULES_FILE}: sección ya cubierta, sin cambios`);
      }

      for (const id of data.sourceIds) {
        await db.query(
          `UPDATE brainx_memories
           SET status = 'promoted',
               promoted_to = $2,
               resolved_at = COALESCE(resolved_at, NOW()),
               resolution_notes = CONCAT(COALESCE(resolution_notes, ''), CASE WHEN COALESCE(resolution_notes, '') = '' THEN '' ELSE E'\n' END, 'promotion applied to canonical BrainX rules sink')
           WHERE id = $1`,
          [id, targetKeyToPromotedTo(targetKey)]
        );
      }
    } else {
      summary.sections[targetKey] = {
        heading: target.heading,
        patternsDistilled: data.count,
        rulesPreview: data.rules.split('\n').filter(line => line.trim().startsWith('- ')).length,
      };
    }
  }

  if (args.apply) {
    const promotedMappings = {};
    for (const item of parsed) {
      const patternKey = item.sourcePatternKey || item.pattern_key || null;
      if (patternKey && !promotedMappings[patternKey]) {
        promotedMappings[patternKey] = item.targetKey;
      }
    }

    for (const [patternKey, targetKey] of Object.entries(promotedMappings)) {
      await db.query(
        `UPDATE brainx_patterns
         SET promoted_to = $2, last_status = 'promoted', updated_at = NOW()
         WHERE pattern_key = $1`,
        [patternKey, targetKeyToPromotedTo(targetKey)]
      );
    }

    if (summary.totalWritten === 0 && backupPath) {
      try { fs.unlinkSync(backupPath); } catch (_) {}
      backupPath = null;
    }
    if (backupPath) summary.backupPath = backupPath;
  }

  if (args.json) {
    console.log(JSON.stringify({ ok: true, mode: args.apply ? 'apply' : 'dry-run', summary }, null, 2));
  } else {
    console.log(`\n📊 Summary: ${summary.totalWritten} rules written, ${summary.totalSkipped} skipped (dedup)`);
    console.log(`📍 Canonical reference: ${CANONICAL_RULES_FILE}`);
    if (!args.apply) {
      console.log('\n⚠️  DRY-RUN — pass --apply to write to the canonical reference file.');
    }
  }

  try { await db.end(); } catch (_) {}
}

main().catch(e => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
