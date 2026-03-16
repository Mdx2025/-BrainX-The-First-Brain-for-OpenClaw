#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (_) {}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx !== -1 ? Number.parseInt(argv[limitIdx + 1] || '80', 10) : 80;
  // Positional args: skip flag values
  const skipSet = new Set();
  if (limitIdx !== -1) { skipSet.add(limitIdx); skipSet.add(limitIdx + 1); }
  argv.forEach((a, i) => { if (a.startsWith('--')) skipSet.add(i); });
  const positional = argv.filter((_, i) => !skipSet.has(i));
  const outPath = positional[0] || path.join(__dirname, '..', 'tests', 'fixtures', 'memory-eval-real.jsonl');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (Number.isNaN(limit) || limit < 1) throw new Error(`Invalid limit: ${limit}`);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, context, content
       FROM brainx_memories
       WHERE superseded_by IS NULL
         AND content IS NOT NULL
       ORDER BY last_seen DESC NULLS LAST, created_at DESC
       LIMIT $1`,
      [limit]
    );

    const lines = rows.map((r) => {
      const content = String(r.content || '').replace(/\s+/g, ' ').trim();
      const query = content.length > 120 ? content.slice(0, 120) : content;
      return JSON.stringify({
        query,
        expected_id: r.id,
        context: r.context || null
      });
    });

    if (dryRun) {
      console.log(JSON.stringify({ ok: true, dryRun: true, count: lines.length, outPath }, null, 2));
    } else {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
      console.log(JSON.stringify({ ok: true, outPath, count: lines.length }, null, 2));
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
