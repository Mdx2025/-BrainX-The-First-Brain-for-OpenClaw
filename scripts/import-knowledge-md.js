#!/usr/bin/env node
/**
 * BrainX V5 — Knowledge Markdown Importer
 *
 * Imports curated knowledge docs from knowledge/ into BrainX.
 * This is intentionally separate from memory/*.md harvesting:
 * - canonical docs stay human-editable
 * - BrainX only enriches the auto-managed block inside each file
 *
 * Usage:
 *   node scripts/import-knowledge-md.js [--dry-run] [--domain <name>] [--verbose]
 *   node scripts/import-knowledge-md.js --root /tmp/knowledge-test --dry-run --verbose
 */

'use strict';

try {
  const dotenv = require('dotenv');
  dotenv.config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
} catch (_) {}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const rag = require('../lib/openai-rag');
const db = require('../lib/db');
const { DOMAIN_CATEGORY } = require('../lib/knowledge-taxonomy');

const ROOT = path.join(__dirname, '..');

const DEFAULTS = {
  sourceKind: 'knowledge_canonical',
  verificationState: 'verified',
  tier: 'hot',
  importance: 8,
  lifecycleStatus: 'promoted',
};

const AUTO_BLOCK_RE = /<!--\s*BRAINX:AUTO:START\s*-->[\s\S]*?<!--\s*BRAINX:AUTO:END\s*-->/g;

function printUsage() {
  console.log(`Usage:
  node scripts/import-knowledge-md.js [--dry-run] [--domain <name>] [--verbose]

Options:
  --dry-run         Simulate without writing to BrainX
  --domain <name>   Import only one top-level domain (e.g. finanzas, development)
  --max-files <n>   Cap files processed
  --max-chunks <n>  Cap stored chunks
  --root <dir>      Override knowledge root for testing
  --verbose         Print detailed file/chunk info
  -h, --help        Show this help message

Conventions:
  - canonical docs live under knowledge/<domain>/
  - README.md, INDEX.md, and files prefixed with "_" are not indexed
`);
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    verbose: false,
    domain: null,
    maxFiles: Infinity,
    maxChunks: Infinity,
    root: path.join(ROOT, 'knowledge'),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--verbose') args.verbose = true;
    else if (arg === '--domain') args.domain = argv[++i] || null;
    else if (arg === '--max-files') args.maxFiles = parseInt(argv[++i], 10) || Infinity;
    else if (arg === '--max-chunks') args.maxChunks = parseInt(argv[++i], 10) || Infinity;
    else if (arg === '--root') args.root = path.resolve(argv[++i] || args.root);
  }

  return args;
}

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'section';
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  const raw = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed;
  return raw
    .split(',')
    .map((s) => s.replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { meta: {}, body: raw };

  const meta = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    if (['tags'].includes(key)) meta[key] = normalizeList(value);
    else if (['importance'].includes(key)) meta[key] = parseInt(value, 10);
    else meta[key] = value.replace(/^['"]|['"]$/g, '');
  }

  return { meta, body: raw.slice(match[0].length) };
}

function stripAutoManagedBlocks(raw) {
  return raw.replace(AUTO_BLOCK_RE, '').trim();
}

function shouldSkipFile(relPath) {
  const base = path.basename(relPath);
  if (!base.endsWith('.md')) return true;
  if (base === 'README.md' || base === 'INDEX.md') return true;
  if (base.startsWith('_')) return true;
  return false;
}

function walkMarkdownFiles(rootDir) {
  const files = [];

  function visit(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
      if (!shouldSkipFile(relPath)) files.push({ fullPath, relPath });
    }
  }

  if (!fs.existsSync(rootDir)) return [];
  visit(rootDir);
  return files.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function stripLeadingH1(body, fallbackTitle) {
  const lines = body.split(/\r?\n/);
  if (lines.length && /^#\s+/.test(lines[0])) {
    return {
      title: lines[0].replace(/^#\s+/, '').trim() || fallbackTitle,
      body: lines.slice(1).join('\n').trim(),
    };
  }
  return { title: fallbackTitle, body: body.trim() };
}

function splitSections(body, fileTitle) {
  const matches = [...body.matchAll(/^(##|###)\s+(.+)$/gm)];
  if (matches.length === 0) {
    const text = body.trim();
    return text ? [{ key: 'root', title: fileTitle, content: text }] : [];
  }

  const sections = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const next = matches[i + 1];
    const start = match.index;
    const end = next ? next.index : body.length;
    const chunk = body.slice(start, end).trim();
    const title = match[2].trim();
    if (!chunk || chunk.length < 40) continue;
    sections.push({
      key: `${i + 1}-${slugify(title)}`,
      title,
      content: chunk,
    });
  }
  return sections;
}

function splitLongContent(text, maxChars = 2200) {
  if (text.length <= maxChars) return [text];
  const lines = text.split(/\r?\n/);
  const chunks = [];
  let buffer = [];
  let len = 0;

  for (const line of lines) {
    if (len + line.length + 1 > maxChars && buffer.length) {
      chunks.push(buffer.join('\n').trim());
      buffer = [];
      len = 0;
    }
    buffer.push(line);
    len += line.length + 1;
  }

  if (buffer.length) chunks.push(buffer.join('\n').trim());
  return chunks.filter(Boolean);
}

function deriveDomainAndTopic(relPath) {
  const relNoExt = relPath.replace(/\.md$/i, '');
  const parts = relNoExt.split('/');
  const domain = parts[0] || 'general';
  const topic = parts.slice(1).join('/') || path.basename(relNoExt);
  return { domain, topic };
}

function inferType(meta, sectionTitle, fileTitle, topic) {
  const explicit = meta.type || meta.memory_type || meta.memoryType;
  if (explicit) return explicit;

  const haystack = `${sectionTitle} ${fileTitle} ${topic}`.toLowerCase();
  if (/(gotcha|pitfall|warning|cuidado|errores|errores comunes|avoid|trap)/i.test(haystack)) return 'gotcha';
  if (/(regla|rules|policy|workflow|procedure|proceso|protocolo|decision|decisión)/i.test(haystack)) return 'decision';
  return 'fact';
}

function inferCategory(meta, domain) {
  return meta.category || DOMAIN_CATEGORY[domain] || 'context';
}

function buildContext(meta, domain) {
  return meta.context || `knowledge:${domain}`;
}

function buildTags(meta, domain, topic, relPath) {
  const tags = new Set([
    'knowledge',
    'knowledge:canonical',
    `domain:${domain}`,
    `topic:${topic || 'general'}`,
    `path:${relPath.replace(/\.md$/i, '')}`,
    'source:knowledge-md',
  ]);

  for (const tag of normalizeList(meta.tags || [])) tags.add(tag);
  return [...tags];
}

function log(verbose, ...args) {
  if (verbose) console.error('[knowledge-import]', ...args);
}

async function markRemovedChunksObsolete(sourcePath, sourceKind, keepIds) {
  await db.query(
    `UPDATE brainx_memories
     SET status = 'wont_fix',
         verification_state = 'obsolete',
         resolution_notes = 'Removed from knowledge source during re-import'
     WHERE source_path = $1
       AND source_kind = $2
       AND NOT (id = ANY($3::text[]))
       AND COALESCE(verification_state, 'hypothesis') != 'obsolete'`,
    [sourcePath, sourceKind, keepIds]
  );
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    return;
  }

  const args = parseArgs(argv);
  const files = walkMarkdownFiles(args.root);
  const summary = {
    root: args.root,
    domainFilter: args.domain,
    filesDiscovered: files.length,
    filesProcessed: 0,
    chunksPrepared: 0,
    chunksStored: 0,
    chunksFailed: 0,
    skippedByDomain: 0,
    byDomain: {},
    errors: [],
  };

  let storedChunks = 0;

  for (const file of files) {
    if (summary.filesProcessed >= args.maxFiles || storedChunks >= args.maxChunks) break;

    const raw = fs.readFileSync(file.fullPath, 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    const status = 'canonical';
    const { domain, topic } = deriveDomainAndTopic(file.relPath);
    if (args.domain && args.domain !== domain) {
      summary.skippedByDomain++;
      continue;
    }

    const defaults = DEFAULTS;
    const canonicalBody = stripAutoManagedBlocks(body);
    const stripped = stripLeadingH1(canonicalBody, meta.title || path.basename(file.relPath, '.md'));
    const sections = splitSections(stripped.body, stripped.title);
    if (!sections.length) continue;

    summary.filesProcessed++;
    summary.byDomain[domain] = (summary.byDomain[domain] || 0) + 1;

    const currentIds = [];

    for (const section of sections) {
      const type = inferType(meta, section.title, stripped.title, topic);
      const category = inferCategory(meta, domain);
      const tags = buildTags(meta, domain, topic, file.relPath);
      const chunks = splitLongContent(section.content);

      for (let i = 0; i < chunks.length; i++) {
        if (storedChunks >= args.maxChunks) break;

        const chunk = chunks[i];
        const chunkKey = `${section.key}-${i + 1}`;
        const id = `kb_${sha1(`${file.relPath}|${chunkKey}`).slice(0, 24)}`;
        currentIds.push(id);
        summary.chunksPrepared++;

        const memory = {
          id,
          type,
          content: chunk,
          context: buildContext(meta, domain),
          tier: meta.tier || defaults.tier,
          importance: Number.isFinite(meta.importance) ? meta.importance : defaults.importance,
          agent: 'knowledge-base',
          tags,
          status: meta.lifecycle_status || defaults.lifecycleStatus,
          category,
          sourceKind: meta.source_kind || defaults.sourceKind,
          sourcePath: file.fullPath,
          confidence: meta.confidence ? parseFloat(meta.confidence) : 0.98,
          verificationState: meta.verification || meta.verification_state || defaults.verificationState,
          sensitivity: meta.sensitivity || 'normal',
        };

        log(args.verbose, `${status}:${domain}`, file.relPath, `-> ${id}`, `[${type}]`, section.title);

        if (args.dryRun) {
          storedChunks++;
          summary.chunksStored++;
          continue;
        }

        try {
          const result = await rag.storeMemory(memory);
          storedChunks++;
          summary.chunksStored++;
          if (result?.dedupe_merged) {
            log(args.verbose, `dedupe merged ${id} via ${result.dedupe_method}`);
          }
        } catch (error) {
          summary.chunksFailed++;
          summary.errors.push({
            file: file.relPath,
            section: section.title,
            message: (error.message || String(error)).slice(0, 240),
          });
        }
      }
    }

    if (!args.dryRun && currentIds.length) {
      await markRemovedChunksObsolete(file.fullPath, defaults.sourceKind, currentIds);
    }
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
