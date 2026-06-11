#!/usr/bin/env node
/**
 * BrainX V5 — Knowledge Auto Block Sync
 *
 * Refreshes the auto-managed block inside canonical knowledge docs.
 * It never touches manual content outside the markers.
 *
 * Usage:
 *   node scripts/sync-knowledge-auto-blocks.js
 *   node scripts/sync-knowledge-auto-blocks.js --domain development --dry-run --verbose
 */

'use strict';

try {
  const dotenv = require('dotenv');
  dotenv.config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
} catch (_) {}

const fs = require('fs');
const path = require('path');
const rag = require('../lib/openai-rag');

const ROOT = path.join(__dirname, '..');
const KNOWLEDGE_DIR = path.join(ROOT, 'knowledge');
const AUTO_START = '<!-- BRAINX:AUTO:START -->';
const AUTO_END = '<!-- BRAINX:AUTO:END -->';
const AUTO_BLOCK_RE = /<!--\s*BRAINX:AUTO:START\s*-->[\s\S]*?<!--\s*BRAINX:AUTO:END\s*-->/g;

function usage() {
  console.log(`Usage:
  node scripts/sync-knowledge-auto-blocks.js [--domain <name>] [--limit <n>] [--dry-run] [--verbose]
`);
}

function parseArgs(argv) {
  const args = {
    domain: null,
    limit: 6,
    dryRun: false,
    verbose: false,
    root: KNOWLEDGE_DIR,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--domain') args.domain = argv[++i] || null;
    else if (arg === '--limit') args.limit = parseInt(argv[++i], 10) || 6;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--verbose') args.verbose = true;
    else if (arg === '--root') args.root = path.resolve(argv[++i] || args.root);
  }

  return args;
}

function log(verbose, ...args) {
  if (verbose) console.error('[knowledge-auto]', ...args);
}

function walkFiles(rootDir) {
  const files = [];
  function visit(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (entry.name.startsWith('_')) continue;
        visit(fullPath);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      if (entry.name === 'README.md' || entry.name === 'INDEX.md' || entry.name.startsWith('_')) continue;
      files.push({ fullPath, relPath });
    }
  }
  if (!fs.existsSync(rootDir)) return [];
  visit(rootDir);
  return files.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { meta: {}, body: raw };

  const meta = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    meta[key] = value;
  }
  return { meta, body: raw.slice(match[0].length) };
}

function extractTitle(body, fallback) {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function deriveQuery(meta, relPath, title) {
  if (meta.auto_query) return meta.auto_query;
  const relNoExt = relPath.replace(/\.md$/i, '');
  const parts = relNoExt.split('/');
  const domain = meta.domain || parts[0] || 'general';
  const topic = parts.slice(1).join(' ');
  return [domain, topic, title].filter(Boolean).join(' ');
}

function replaceOrAppendAutoBlock(raw, block) {
  if (AUTO_BLOCK_RE.test(raw)) {
    return raw.replace(AUTO_BLOCK_RE, block);
  }
  const trimmed = raw.trimEnd();
  return `${trimmed}\n\n${block}\n`;
}

function buildAutoBlock(query, rows) {
  const lines = [
    AUTO_START,
    '## BrainX Auto',
    `_Última sincronización: ${new Date().toISOString()}_`,
    `_Query: ${query}_`,
    '',
  ];

  if (!rows.length) {
    lines.push('- Sin sugerencias relevantes todavía.');
  } else {
    for (const row of rows) {
      const ctx = row.context ? ` | ctx:${row.context}` : '';
      lines.push(`- [${row.type} | imp:${row.importance}${ctx}] ${row.content.replace(/\s+/g, ' ').trim()}`);
    }
  }

  lines.push(AUTO_END);
  return lines.join('\n');
}

async function queryAutoMemories(query, limit) {
  const rows = await rag.search(query, {
    limit: Math.max(limit * 2, 8),
    minSimilarity: 0.30,
    minImportance: 5,
    contextFilter: null,
  });

  return rows
    .filter((row) => ['fact', 'decision', 'gotcha', 'learning'].includes(row.type))
    .filter((row) => !String(row.source_kind || '').startsWith('knowledge_'))
    .filter((row) => row.verification_state !== 'obsolete')
    .slice(0, limit);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }

  const args = parseArgs(argv);
  const files = walkFiles(args.root);
  const summary = {
    root: args.root,
    domainFilter: args.domain,
    filesDiscovered: files.length,
    filesUpdated: 0,
    filesSkipped: 0,
    errors: [],
  };

  for (const file of files) {
    const domain = file.relPath.split('/')[0];
    if (args.domain && args.domain !== domain) {
      summary.filesSkipped++;
      continue;
    }

    try {
      const raw = fs.readFileSync(file.fullPath, 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      const title = extractTitle(body, path.basename(file.relPath, '.md'));
      const query = deriveQuery(meta, file.relPath, title);
      const rows = await queryAutoMemories(query, args.limit);
      const block = buildAutoBlock(query, rows);
      const updated = replaceOrAppendAutoBlock(raw, block);

      log(args.verbose, file.relPath, `results=${rows.length}`, `query="${query}"`);

      if (!args.dryRun) {
        fs.writeFileSync(file.fullPath, updated, 'utf8');
      }
      summary.filesUpdated++;
    } catch (error) {
      summary.errors.push({
        file: file.relPath,
        message: (error.message || String(error)).slice(0, 240),
      });
    }
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
