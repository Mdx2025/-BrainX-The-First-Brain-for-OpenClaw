#!/usr/bin/env node
/**
 * BrainX V5 — Knowledge Locator
 *
 * Finds canonical knowledge docs relevant to a concrete task/query and
 * returns the file paths the agent should read in full before answering.
 */

'use strict';

try {
  const dotenv = require('dotenv');
  dotenv.config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
} catch (_) {}

const path = require('path');
const rag = require('../lib/openai-rag');

const ROOT = path.join(__dirname, '..');
const KNOWLEDGE_DIR = path.join(ROOT, 'knowledge');

function usage() {
  console.log(`Usage:
  node scripts/knowledge-locate.js --query "<task>" [--domain <name>] [--docs <n>] [--snippets <n>] [--json]

Options:
  --query <text>      Required. Task or intent to locate docs for.
  --domain <name>     Optional. Limit to one knowledge domain.
  --docs <n>          Max docs to return (default 5)
  --snippets <n>      Max supporting snippets per doc (default 2)
  --search-limit <n>  Raw semantic hits before grouping (default 40)
  --min-similarity    Minimum similarity threshold (default 0.28)
  --min-importance    Minimum importance threshold (default 5)
  --json              Emit JSON instead of markdown
`);
}

function parseArgs(argv) {
  const args = {
    query: null,
    domain: null,
    docs: 5,
    snippets: 2,
    searchLimit: 40,
    minSimilarity: 0.28,
    minImportance: 5,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--query') args.query = argv[++i] || null;
    else if (arg === '--domain') args.domain = argv[++i] || null;
    else if (arg === '--docs') args.docs = parseInt(argv[++i], 10) || 5;
    else if (arg === '--snippets') args.snippets = parseInt(argv[++i], 10) || 2;
    else if (arg === '--search-limit') args.searchLimit = parseInt(argv[++i], 10) || 40;
    else if (arg === '--min-similarity') args.minSimilarity = parseFloat(argv[++i]) || 0.28;
    else if (arg === '--min-importance') args.minImportance = parseInt(argv[++i], 10) || 5;
    else if (arg === '--json') args.json = true;
  }

  return args;
}

function compact(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function truncate(text, max = 220) {
  const normalized = compact(text);
  if (normalized.length <= max) return normalized;
  return normalized.slice(0, max - 3).trimEnd() + '...';
}

function relKnowledgePath(absPath) {
  const rel = path.relative(KNOWLEDGE_DIR, absPath).replace(/\\/g, '/');
  return rel.startsWith('..') ? absPath : rel;
}

function inferDomain(row) {
  const ctx = String(row.context || '');
  if (ctx.startsWith('knowledge:')) return ctx.slice('knowledge:'.length);
  const rel = relKnowledgePath(row.source_path || '');
  return rel.split('/')[0] || 'general';
}

function extractSectionTitle(content) {
  const lines = String(content || '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^#{2,3}\s+(.+)$/);
    if (match) return match[1].trim();
  }
  return null;
}

function cleanSnippet(content) {
  const lines = String(content || '')
    .split(/\r?\n/)
    .filter((line) => !/^#{2,3}\s+/.test(line.trim()));
  return truncate(lines.join(' '), 220);
}

function toReadCommand(absPath) {
  return `sed -n '1,220p' ${absPath}`;
}

function queryTokens(query) {
  return [...new Set(
    compact(query)
      .toLowerCase()
      .split(/[^a-z0-9áéíóúñ-]+/i)
      .filter((token) => token.length >= 4)
  )];
}

function keywordSignal(tokens, doc) {
  if (!tokens.length) return 0;
  const haystack = compact([
    doc.domain,
    doc.relativePath,
    ...(doc.sections || []),
    ...(doc.snippets || []).map((item) => item.text || ''),
  ].join(' ')).toLowerCase();

  let hits = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) hits += 1;
  }

  return hits / Math.min(tokens.length, 6);
}

function renderMarkdown(result) {
  const lines = [
    '# Knowledge Locator',
    '',
    `Query: ${result.query}`,
  ];

  if (result.domain) lines.push(`Domain: ${result.domain}`);
  lines.push('');

  if (!result.docs.length) {
    lines.push('No canonical docs found for this query.');
    return lines.join('\n');
  }

  lines.push('Read these docs first:');
  lines.push('');

  result.docs.forEach((doc, idx) => {
    lines.push(`${idx + 1}. \`${doc.path}\``);
    lines.push(`   domain: ${doc.domain} | score: ${doc.score.toFixed(3)} | similarity: ${doc.similarity.toFixed(3)}`);
    lines.push(`   read: \`${doc.readCommand}\``);
    if (doc.sections.length) {
      lines.push(`   sections: ${doc.sections.join(' ; ')}`);
    }
    doc.snippets.forEach((snippet) => {
      const prefix = snippet.section ? `${snippet.section}: ` : '';
      lines.push(`   - ${prefix}${snippet.text}`);
    });
    lines.push('');
  });

  return lines.join('\n').trim() + '\n';
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }

  const args = parseArgs(argv);
  if (!args.query) {
    usage();
    process.exit(1);
  }

  const rawRows = await rag.search(args.query, {
    limit: Math.max(args.searchLimit, args.docs * args.snippets * 4),
    minSimilarity: args.minSimilarity,
    minImportance: args.minImportance,
    contextFilter: args.domain ? `knowledge:${args.domain}` : null,
  });

  const docsMap = new Map();

  for (const row of rawRows) {
    if (row.source_kind !== 'knowledge_canonical') continue;
    if (!row.source_path) continue;

    const absPath = row.source_path;
    const domain = inferDomain(row);
    if (args.domain && args.domain !== domain) continue;

    const section = extractSectionTitle(row.content);
    const snippetText = cleanSnippet(row.content);
    const score = Number(row.score || row.similarity || 0);
    const similarity = Number(row.similarity || 0);

    if (!docsMap.has(absPath)) {
      docsMap.set(absPath, {
        path: absPath,
        relativePath: relKnowledgePath(absPath),
        domain,
        score,
        similarity,
        sections: [],
        snippets: [],
        readCommand: toReadCommand(absPath),
      });
    }

    const doc = docsMap.get(absPath);
    doc.score = Math.max(doc.score, score);
    doc.similarity = Math.max(doc.similarity, similarity);
    if (section && !doc.sections.includes(section)) doc.sections.push(section);
    if (
      snippetText &&
      !doc.snippets.some((item) => item.text === snippetText) &&
      doc.snippets.length < args.snippets
    ) {
      doc.snippets.push({ section, text: snippetText, score });
    }
  }

  const tokens = queryTokens(args.query);
  const docs = [...docsMap.values()]
    .map((doc) => {
      const lexical = keywordSignal(tokens, doc);
      return {
        ...doc,
        lexical,
        rank: doc.score + (lexical * 0.18),
      };
    })
    .sort((a, b) => (b.rank - a.rank) || (b.score - a.score) || (b.similarity - a.similarity) || a.path.localeCompare(b.path))
    .slice(0, args.docs)
    .map((doc) => ({
      ...doc,
      sections: doc.sections.slice(0, 4),
      snippets: doc.snippets.sort((a, b) => b.score - a.score).slice(0, args.snippets),
    }));

  const result = {
    query: args.query,
    domain: args.domain,
    docs,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(renderMarkdown(result));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
