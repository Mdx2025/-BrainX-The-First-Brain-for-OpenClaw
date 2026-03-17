#!/usr/bin/env node
/**
 * error-harvester.js — Scans OpenClaw session logs for command failures
 * and stores them as gotcha/error memories in BrainX.
 *
 * Designed to run in the BrainX Daily Core Pipeline cron.
 * Only processes logs from the last 24h (or --hours N).
 *
 * Usage:
 *   node scripts/error-harvester.js [--hours 24] [--dry-run] [--verbose]
 */

try {
  const dotenv = require('dotenv');
  const path = require('path');
  const envPath = process.env.BRAINX_ENV || path.join(__dirname, '..', '.env');
  dotenv.configDotenv({ path: envPath });
} catch (_) {}

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Check multiple possible session log locations
const HOME = process.env.HOME || '/home/clawd';
const SESSION_DIRS = [
  path.join(HOME, '.openclaw', 'agents'),  // agent session .jsonl files
  path.join(HOME, '.acpx', 'sessions'),     // ACP session logs
];
const BRAINX_CLI = path.join(__dirname, '..', 'brainx-v5');

function parseArgs(argv) {
  const args = { hours: 24, dryRun: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--hours' && argv[i + 1]) args.hours = parseInt(argv[i + 1], 10) || 24;
    if (argv[i] === '--dry-run') args.dryRun = true;
    if (argv[i] === '--verbose') args.verbose = true;
  }
  return args;
}

function findRecentLogs(dir, hoursAgo) {
  const cutoff = Date.now() - hoursAgo * 3600 * 1000;
  const files = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...findRecentLogs(full, hoursAgo));
      } else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.ndjson'))) {
        const stat = fs.statSync(full);
        if (stat.mtimeMs >= cutoff) files.push(full);
      }
    }
  } catch (_) {}
  return files;
}

function extractErrors(filePath) {
  const errors = [];
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        // Look for tool results with errors
        if (entry.role === 'tool' && entry.content) {
          const text = typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content);

          // Detect non-zero exit codes
          const exitMatch = text.match(/(?:exit(?:ed)?\s+(?:with\s+)?(?:code|status)\s+(\d+)|Process exited with code (\d+))/i);
          if (exitMatch) {
            const code = parseInt(exitMatch[1] || exitMatch[2], 10);
            if (code !== 0) {
              // Extract the command if possible
              const cmdMatch = text.match(/(?:command|cmd|exec|running|ran)[\s:]*[`"']?([^\n`"']{5,120})/i);
              const command = cmdMatch ? cmdMatch[1].trim() : null;

              // Get a meaningful snippet (first 300 chars of error output)
              const snippet = text.slice(0, 300).replace(/\s+/g, ' ').trim();

              errors.push({
                type: 'exit_code',
                code,
                command,
                snippet,
                file: filePath,
                agent: extractAgent(filePath),
              });
            }
          }

          // Detect common error patterns
          const errorPatterns = [
            /(?:Error|ERROR|FATAL|CRITICAL):\s*(.{10,200})/,
            /(?:TypeError|ReferenceError|SyntaxError|RangeError):\s*(.{10,200})/,
            /(?:ENOENT|EACCES|EPERM|ECONNREFUSED):\s*(.{10,200})/,
            /permission denied[:\s]*(.{5,150})/i,
            /command not found[:\s]*(.{5,80})/i,
          ];

          for (const pat of errorPatterns) {
            const m = text.match(pat);
            if (m) {
              errors.push({
                type: 'error_pattern',
                pattern: pat.source.split(':')[0],
                message: m[1]?.trim() || m[0]?.trim(),
                snippet: text.slice(0, 300).replace(/\s+/g, ' ').trim(),
                file: filePath,
                agent: extractAgent(filePath),
              });
              break; // one per entry
            }
          }
        }
      } catch (_) {
        // skip unparseable lines
      }
    }
  } catch (_) {}
  return errors;
}

function extractAgent(filePath) {
  // Try to get agent name from path: .../workspace-<agent>/... or session key
  const m = filePath.match(/workspace-([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  const m2 = filePath.match(/agent[=:]([a-zA-Z0-9_-]+)/);
  if (m2) return m2[1];
  return 'unknown';
}

function dedupeErrors(errors) {
  const seen = new Set();
  return errors.filter(e => {
    const key = `${e.type}:${e.command || e.message || e.snippet?.slice(0, 80)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`🔍 Scanning session logs from last ${args.hours}h...`);

  let logFiles = [];
  for (const dir of SESSION_DIRS) {
    logFiles.push(...findRecentLogs(dir, args.hours));
  }
  console.log(`  Found ${logFiles.length} recent log files`);

  let allErrors = [];
  for (const file of logFiles) {
    const errors = extractErrors(file);
    allErrors.push(...errors);
  }

  allErrors = dedupeErrors(allErrors);
  console.log(`  Extracted ${allErrors.length} unique errors`);

  if (allErrors.length === 0) {
    console.log('✅ No errors found. Clean day!');
    return;
  }

  let saved = 0;
  for (const err of allErrors) {
    const content = err.command
      ? `Command failed (exit ${err.code || '?'}): ${err.command}\n${err.snippet}`
      : `${err.pattern || 'Error'}: ${err.message}\n${err.snippet}`;

    if (content.length < 20) continue;

    if (args.verbose || args.dryRun) {
      console.log(`  ${args.dryRun ? '[DRY-RUN]' : '[SAVE]'} agent=${err.agent} → ${content.slice(0, 100)}...`);
    }

    if (!args.dryRun) {
      try {
        execFileSync(BRAINX_CLI, [
          'add',
          '--type', 'gotcha',
          '--content', content.slice(0, 2000),
          '--tier', 'warm',
          '--importance', '6',
          '--category', 'error',
          '--agent', err.agent,
          '--tags', 'auto-harvested,error',
          '--sourceKind', 'tool_verified',
        ], { encoding: 'utf8', timeout: 15000 });
        saved++;
      } catch (e) {
        console.error(`  ⚠️ Failed to save: ${e.message?.slice(0, 100)}`);
      }
    } else {
      saved++;
    }
  }

  console.log(`${args.dryRun ? '🏃 Dry run:' : '✅'} ${saved} errors ${args.dryRun ? 'would be' : ''} saved to BrainX`);
}

main().catch(e => {
  console.error(e.message || e);
  process.exit(1);
});
