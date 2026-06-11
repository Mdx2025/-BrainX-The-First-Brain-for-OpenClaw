#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true, quiet: true });

const db = require('../lib/db');
const { deriveSensitivity, normalizeSensitivity } = require('../lib/brainx-phase2');

const FINANCIAL_HINTS = /(credit|card|visa|mastercard|amex|payment|billing|stripe|tarjeta)/i;

function sanitizeTags(tags, content) {
  const list = Array.isArray(tags) ? tags.map(String) : [];
  const hasFinanceHints = FINANCIAL_HINTS.test(String(content || ''));
  const filtered = list.filter((tag) => tag !== 'pii:credit_card' || hasFinanceHints);
  const piiReasons = filtered.filter((tag) => tag.startsWith('pii:') && tag !== 'pii:redacted');
  if (piiReasons.length === 0) {
    return filtered.filter((tag) => tag !== 'pii:redacted');
  }
  return filtered;
}

function parseArgs(argv) {
  return {
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    includeNonNormal: argv.includes('--include-non-normal'),
    limit: parseInt((argv.find((arg) => arg.startsWith('--limit=')) || '').split('=')[1] || '5000', 10) || 5000,
  };
}

function buildRedactionMeta(tags, content) {
  const list = sanitizeTags(tags, content);
  const reasons = list
    .filter((tag) => tag.startsWith('pii:') && tag !== 'pii:redacted')
    .map((tag) => tag.slice(4));
  return {
    redacted: list.includes('pii:redacted') && reasons.length > 0,
    reasons
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const filters = [];
  const params = [];

  if (!args.includeNonNormal) {
    params.push('normal');
    filters.push(`COALESCE(sensitivity, 'normal') = $${params.length}`);
  }

  params.push(args.limit);
  const limitParam = `$${params.length}`;

  const whereSql = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const { rows } = await db.query(
    `SELECT id, content, context, tags, sensitivity
     FROM brainx_memories
     ${whereSql}
     ORDER BY created_at DESC
     LIMIT ${limitParam}`,
    params
  );

  const changes = [];
  const transitions = {};

  for (const row of rows) {
    const sanitizedTags = sanitizeTags(row.tags, row.content);
    const current = normalizeSensitivity(row.sensitivity);
    const next = deriveSensitivity({
      explicit: null,
      content: row.content,
      context: row.context,
      tags: sanitizedTags,
      redactionMeta: buildRedactionMeta(sanitizedTags, row.content)
    });
    const key = `${current}->${next}`;
    transitions[key] = (transitions[key] || 0) + 1;
    if (next !== current) {
      changes.push({
        id: row.id,
        from: current,
        to: next,
        content: String(row.content || '').replace(/\s+/g, ' ').trim().slice(0, 180)
      });
    }
  }

  if (args.apply && changes.length > 0) {
    const groups = changes.reduce((acc, row) => {
      if (!acc[row.to]) acc[row.to] = [];
      acc[row.to].push(row.id);
      return acc;
    }, {});

    for (const [target, ids] of Object.entries(groups)) {
      await db.query(
        `UPDATE brainx_memories
         SET sensitivity = $2
         WHERE id = ANY($1::text[])`,
        [ids, target]
      );
    }
  }

  const result = {
    ok: true,
    apply: args.apply,
    scanned: rows.length,
    changed: changes.length,
    unchanged: rows.length - changes.length,
    transitions,
    sample: changes.slice(0, 20)
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`scanned=${result.scanned} changed=${result.changed} unchanged=${result.unchanged}`);
    for (const [transition, count] of Object.entries(result.transitions)) {
      console.log(`- ${transition}: ${count}`);
    }
    if (changes.length > 0) {
      console.log('\nsample changes:');
      for (const row of result.sample) {
        console.log(`- ${row.id} ${row.from}->${row.to} ${row.content}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
