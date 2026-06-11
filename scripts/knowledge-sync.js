#!/usr/bin/env node
/**
 * BrainX V5 — Knowledge Sync
 *
 * High-level sync for the canonical knowledge base:
 * 1. Detects whether manual knowledge content changed.
 * 2. Re-imports canonical docs into BrainX only when needed.
 * 3. Refreshes the BrainX auto block after a successful import.
 *
 * Auto-managed block changes do not count as manual edits, so this script
 * remains stable under cron and does not retrigger itself forever.
 */

'use strict';

try {
  const dotenv = require('dotenv');
  dotenv.config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
} catch (_) {}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const KNOWLEDGE_DIR = path.join(ROOT, 'knowledge');
const STATE_FILE = path.join(ROOT, 'data', 'knowledge-sync-state.json');
const AUTO_BLOCK_RE = /<!--\s*BRAINX:AUTO:START\s*-->[\s\S]*?<!--\s*BRAINX:AUTO:END\s*-->/g;

function usage() {
  console.log(`Usage:
  node scripts/knowledge-sync.js [--dry-run] [--force] [--domain <name>] [--verbose] [--json]

What it does:
  - Detects manual changes under knowledge/
  - Runs import-knowledge-md.js only when needed
  - Refreshes the BrainX auto block afterwards
  - Stores a lightweight sync state in data/knowledge-sync-state.json
`);
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    force: false,
    verbose: false,
    json: false,
    domain: null,
    root: KNOWLEDGE_DIR,
    stateFile: STATE_FILE,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--verbose') args.verbose = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--domain') args.domain = argv[++i] || null;
    else if (arg === '--root') args.root = path.resolve(argv[++i] || args.root);
    else if (arg === '--state-file') args.stateFile = path.resolve(argv[++i] || args.stateFile);
  }

  return args;
}

function log(verbose, ...parts) {
  if (verbose) console.error('[knowledge-sync]', ...parts);
}

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
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
        if (entry.name.startsWith('_')) continue;
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

function computeSnapshot(args) {
  const files = walkMarkdownFiles(args.root)
    .filter((file) => !args.domain || file.relPath.split('/')[0] === args.domain);

  const entries = files.map((file) => {
    const raw = fs.readFileSync(file.fullPath, 'utf8');
    const canonical = stripAutoManagedBlocks(raw);
    const stat = fs.statSync(file.fullPath);
    return {
      relPath: file.relPath,
      hash: sha1(canonical),
      manualBytes: Buffer.byteLength(canonical, 'utf8'),
      mtimeMs: Math.floor(stat.mtimeMs),
    };
  });

  const snapshotHash = sha1(JSON.stringify(entries.map((entry) => [entry.relPath, entry.hash])));
  const latestMtimeMs = entries.reduce((max, entry) => Math.max(max, entry.mtimeMs), 0);

  return {
    domain: args.domain || null,
    root: args.root,
    fileCount: entries.length,
    latestMtimeMs,
    snapshotHash,
    entries,
  };
}

function loadState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (_) {
    return { all: null, domains: {} };
  }
}

function saveState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function getPreviousSnapshot(state, domain) {
  if (domain) return state.domains?.[domain] || null;
  return state.all || null;
}

function setSnapshot(state, domain, snapshot) {
  if (domain) {
    state.domains ||= {};
    state.domains[domain] = snapshot;
    return;
  }
  state.all = snapshot;
}

function diffFiles(prevSnapshot, nextSnapshot) {
  const prev = new Map((prevSnapshot?.entries || []).map((entry) => [entry.relPath, entry.hash]));
  const next = new Map((nextSnapshot?.entries || []).map((entry) => [entry.relPath, entry.hash]));
  const changed = [];

  for (const [relPath, hash] of next.entries()) {
    if (!prev.has(relPath)) changed.push(relPath);
    else if (prev.get(relPath) !== hash) changed.push(relPath);
  }
  for (const relPath of prev.keys()) {
    if (!next.has(relPath)) changed.push(relPath);
  }

  return changed.sort();
}

function runJsonScript(scriptName, scriptArgs, options = {}) {
  const fullPath = path.join(ROOT, 'scripts', scriptName);
  const result = spawnSync(process.execPath, [fullPath, ...scriptArgs], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });

  if (options.verbose && result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    const error = new Error((result.stderr || result.stdout || `${scriptName} failed`).trim() || `${scriptName} failed`);
    error.code = result.status;
    throw error;
  }

  const stdout = (result.stdout || '').trim();
  if (!stdout) return {};
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${scriptName} returned non-JSON output`);
  }
}

function runJsonCli(argv, options = {}) {
  const cliPath = path.join(ROOT, 'lib', 'cli.js');
  const result = spawnSync(process.execPath, [cliPath, ...argv], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });

  if (options.verbose && result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    const error = new Error((result.stderr || result.stdout || `cli ${argv.join(' ')} failed`).trim() || `cli ${argv.join(' ')} failed`);
    error.code = result.status;
    throw error;
  }

  const stdout = (result.stdout || '').trim();
  if (!stdout) return {};
  try {
    return JSON.parse(stdout);
  } catch (_) {
    throw new Error(`cli ${argv.join(' ')} returned non-JSON output`);
  }
}

function printSummary(summary, asJson) {
  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (summary.status === 'noop') {
    console.log(`knowledge-sync: noop (${summary.fileCount} files, no manual changes)`);
    return;
  }

  if (summary.status === 'ok') {
    console.log(`knowledge-sync: ok (${summary.changedFilesCount} changed, ${summary.fileCount} files)`);
    return;
  }

  console.log(`knowledge-sync: error (${summary.error?.step || 'unknown'})`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }

  const args = parseArgs(argv);
  const state = loadState(args.stateFile);
  const previousSnapshot = getPreviousSnapshot(state, args.domain);
  const snapshot = computeSnapshot(args);
  const changedFiles = diffFiles(previousSnapshot, snapshot);

  const summary = {
    status: 'noop',
    domain: args.domain,
    root: args.root,
    stateFile: args.stateFile,
    fileCount: snapshot.fileCount,
    changedFilesCount: changedFiles.length,
    changedFiles,
    forced: args.force,
    dryRun: args.dryRun,
    importSummary: null,
    autoSummary: null,
    wikiSummary: null,
    error: null,
  };

  if (!snapshot.fileCount) {
    printSummary(summary, args.json);
    return;
  }

  if (!args.force && previousSnapshot && previousSnapshot.snapshotHash === snapshot.snapshotHash) {
    printSummary(summary, args.json);
    return;
  }

  const scriptArgs = [];
  if (args.domain) scriptArgs.push('--domain', args.domain);
  if (args.dryRun) scriptArgs.push('--dry-run');
  if (args.verbose) scriptArgs.push('--verbose');

  try {
    log(args.verbose, 'manual changes detected', changedFiles.length ? changedFiles.join(', ') : '(snapshot changed)');
    summary.importSummary = runJsonScript('import-knowledge-md.js', scriptArgs, { verbose: args.verbose });
    summary.autoSummary = runJsonScript('sync-knowledge-auto-blocks.js', scriptArgs, { verbose: args.verbose });
    summary.wikiSummary = runJsonCli(['wiki', 'compile', '--json', ...(args.dryRun ? ['--dry-run'] : [])], { verbose: args.verbose });
    summary.status = 'ok';

    if (!args.dryRun) {
      setSnapshot(state, args.domain, {
        snapshotHash: snapshot.snapshotHash,
        fileCount: snapshot.fileCount,
        latestMtimeMs: snapshot.latestMtimeMs,
        syncedAt: new Date().toISOString(),
        entries: snapshot.entries,
      });
      saveState(args.stateFile, state);
    }
  } catch (error) {
    summary.status = 'error';
    summary.error = {
      step: summary.importSummary ? 'knowledge-auto-sync' : 'knowledge-import',
      message: (error.message || String(error)).slice(0, 500),
    };
  }

  printSummary(summary, args.json);
  if (summary.status === 'error') process.exit(1);
}

main();
