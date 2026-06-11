#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true, quiet: true });

const db = require('../lib/db');
const {
  extractRule,
  extractSuggestionMetadata,
  normalizeRule,
  isLowSignalPromotionRule,
  readCanonicalRules,
  findCanonicalRuleMatch,
} = require('../lib/promotion-governance');

function parseArgs(argv) {
  return {
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    limit: parseInt((argv.find((arg) => arg.startsWith('--limit=')) || '').split('=')[1] || '500', 10) || 500,
  };
}

const REJECT_PATTERNS = [
  /^\s*\{/,
  /\bactualmente hay \d+\b/i,
  /\breporte?\b|\breport\b/i,
  /\bart[íi]culo\b|\barticle\b|\bblog\b|\bdraft\b|\bpublished\b|\bpublicado\b/i,
  /\bhealth\b|\bv1\b/i,
  /\bjob deshabilitado\b/i,
  /\bbug de alineaci[óo]n\b/i,
  /\bbackfill\b|\bfeatured image\b/i,
  /\binvitaciones a m[úu]ltiples repositorios\b/i,
  /\bmission control\b/i,
  /\bnew-closer\b|\bnpm install tras clonar\b/i,
  /\bcontenido apareci[óo]\b/i,
  /\bmdx seo growth report\b/i,
];

function shouldReject(rule) {
  return isLowSignalPromotionRule(rule) || REJECT_PATTERNS.some((pattern) => pattern.test(rule));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { rows } = await db.query(
    `SELECT id, status, verification_state, superseded_by, content
     FROM brainx_memories
     WHERE 'promotion-suggestion' = ANY(COALESCE(tags, '{}'))
       AND COALESCE(status, 'pending') NOT IN ('promoted', 'applied', 'rejected', 'wont_fix')
     ORDER BY created_at DESC
     LIMIT $1`,
    [args.limit]
  );

  const promotedRows = await db.query(
    `SELECT content
     FROM brainx_memories
     WHERE 'promotion-suggestion' = ANY(COALESCE(tags, '{}'))
       AND COALESCE(status, '') IN ('promoted', 'applied')`
  );
  const promotedRules = new Set(promotedRows.rows.map((row) => normalizeRule(extractRule(row.content))));
  const canonical = readCanonicalRules();

  const rejectIds = [];
  const keepIds = [];
  const samples = [];

  for (const row of rows) {
    const meta = extractSuggestionMetadata(row.content);
    const rule = meta.rule;
    const normalized = normalizeRule(rule);
    const duplicateOfPromoted = promotedRules.has(normalized);
    const duplicateOfCanonical = Boolean(findCanonicalRuleMatch(rule, canonical, meta.targetKey));
    const invalid = shouldReject(rule);
    if (duplicateOfPromoted || duplicateOfCanonical || invalid || row.verification_state === 'obsolete' || row.superseded_by) {
      rejectIds.push(row.id);
      if (samples.length < 20) {
        samples.push({
          id: row.id,
          reason: duplicateOfPromoted
            ? 'duplicate_of_promoted'
            : duplicateOfCanonical
              ? 'duplicate_of_canonical'
            : (row.verification_state === 'obsolete' || row.superseded_by ? 'stale_duplicate' : 'low_signal'),
          rule: rule.slice(0, 180),
        });
      }
    } else {
      keepIds.push(row.id);
    }
  }

  if (args.apply && rejectIds.length > 0) {
    await db.query(
      `UPDATE brainx_memories
       SET status = 'wont_fix',
           verification_state = 'obsolete',
           feedback_score = LEAST(COALESCE(feedback_score, 0), -2),
           resolution_notes = CONCAT(COALESCE(resolution_notes, ''), CASE WHEN COALESCE(resolution_notes, '') = '' THEN '' ELSE E'\n' END, 'promotion suggestion cleaned as low-signal or duplicate')
       WHERE id = ANY($1::text[])`,
      [rejectIds]
    );
  }

  const result = {
    ok: true,
    apply: args.apply,
    scanned: rows.length,
    rejected: rejectIds.length,
    kept: keepIds.length,
    sampleRejected: samples,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`scanned=${result.scanned} rejected=${result.rejected} kept=${result.kept}`);
    for (const sample of samples) {
      console.log(`- ${sample.id} [${sample.reason}] ${sample.rule}`);
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
