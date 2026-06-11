#!/usr/bin/env node
/**
 * BrainX V5 — Knowledge Topic Scaffolder
 *
 * Creates a canonical knowledge markdown file with:
 * - frontmatter
 * - manual sections
 * - BrainX auto-managed block markers
 *
 * Usage:
 *   node scripts/new-knowledge-topic.js --category development --name nextjs-server-actions
 *   node scripts/new-knowledge-topic.js --category finanzas --name trading-riesgo --title "Trading Riesgo"
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { CATEGORY_IDS } = require('../lib/knowledge-taxonomy');

const ROOT = path.join(__dirname, '..');
const KNOWLEDGE_DIR = path.join(ROOT, 'knowledge');
const VALID_CATEGORIES = CATEGORY_IDS;

function usage() {
  console.log(`Usage:
  node scripts/new-knowledge-topic.js --category <name> --name <slug> [--title <text>] [--tags a,b,c] [--query <text>] [--dry-run] [--force]

Examples:
  node scripts/new-knowledge-topic.js --category development --name nextjs-server-actions
  node scripts/new-knowledge-topic.js --category finanzas --name trading-riesgo --title "Trading Riesgo"
`);
}

function parseArgs(argv) {
  const args = {
    category: null,
    name: null,
    title: null,
    tags: [],
    query: null,
    dryRun: false,
    force: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--category') args.category = argv[++i] || null;
    else if (arg === '--name') args.name = argv[++i] || null;
    else if (arg === '--title') args.title = argv[++i] || null;
    else if (arg === '--tags') args.tags = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--query') args.query = argv[++i] || null;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--force') args.force = true;
  }

  return args;
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function titleize(slug) {
  return String(slug || '')
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function makeTemplate({ category, title, tags, query }) {
  const tagsYaml = tags.length ? `[${tags.join(', ')}]` : '[]';
  const autoQueryLine = query ? `auto_query: "${query.replace(/"/g, '\\"')}"\n` : '';

  return `---
domain: ${category}
tags: ${tagsYaml}
status: canonical
importance: 8
sensitivity: normal
${autoQueryLine}---
# ${title}

## Manual
Escribe aquí el contenido manual que quieres conservar como canónico.

## Reglas
-

## Notas
-

<!-- BRAINX:AUTO:START -->
## BrainX Auto
_Aún no sincronizado._
<!-- BRAINX:AUTO:END -->
`;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }

  const args = parseArgs(argv);
  if (!args.category || !args.name) {
    usage();
    process.exit(1);
  }

  if (!VALID_CATEGORIES.includes(args.category)) {
    console.error(`Invalid category: ${args.category}`);
    console.error(`Valid categories: ${VALID_CATEGORIES.join(', ')}`);
    process.exit(1);
  }

  const slug = slugify(args.name);
  if (!slug) {
    console.error('Invalid --name');
    process.exit(1);
  }

  const title = args.title || titleize(slug);
  const dir = path.join(KNOWLEDGE_DIR, args.category);
  const filePath = path.join(dir, `${slug}.md`);

  if (fs.existsSync(filePath) && !args.force) {
    console.error(`File already exists: ${filePath}`);
    process.exit(1);
  }

  const content = makeTemplate({
    category: args.category,
    title,
    tags: args.tags,
    query: args.query,
  });

  if (args.dryRun) {
    console.log(JSON.stringify({ filePath, title, category: args.category, dryRun: true }, null, 2));
    return;
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(JSON.stringify({ filePath, title, category: args.category, created: true }, null, 2));
}

main();
