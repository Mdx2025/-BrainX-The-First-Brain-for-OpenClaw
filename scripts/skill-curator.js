#!/usr/bin/env node
/**
 * BrainX skill curator.
 *
 * Mirrors Hermes' curator lifecycle for BrainX-created skills:
 * sidecar ownership, pin/unpin, reversible archive/restore, and stale pruning.
 */

const lifecycle = require('../lib/skill-lifecycle');

function parseArgs(argv) {
  const args = {
    command: argv[0] || 'status',
    skill: null,
    days: 90,
    staleDays: 30,
    archiveDays: 90,
    dryRun: false,
    yes: false,
    json: false,
    root: null,
  };
  for (let i = 1; i < argv.length; i++) {
    const current = argv[i];
    const next = argv[i + 1];
    if (!current.startsWith('-') && !args.skill) args.skill = current;
    else if (current === '--days' && next) {
      args.days = parseInt(next, 10) || args.days;
      i++;
    } else if (current === '--stale-days' && next) {
      args.staleDays = parseInt(next, 10) || args.staleDays;
      i++;
    } else if (current === '--archive-days' && next) {
      args.archiveDays = parseInt(next, 10) || args.archiveDays;
      i++;
    } else if (current === '--root' && next) {
      args.root = next;
      i++;
    } else if (current === '--dry-run') args.dryRun = true;
    else if (current === '--json') args.json = true;
    else if (current === '-y' || current === '--yes') args.yes = true;
  }
  return args;
}

function formatTs(value) {
  return value || 'never';
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function printStatus(rows, options) {
  const byState = { active: 0, stale: 0, archived: 0 };
  const pinned = [];
  for (const row of rows) {
    byState[row.state] = (byState[row.state] || 0) + 1;
    if (row.pinned) pinned.push(row.name);
  }
  console.log('BrainX Skill Curator');
  console.log('  root:          ' + options.root);
  console.log('  tracked:       ' + rows.length);
  console.log('  active:        ' + (byState.active || 0));
  console.log('  stale:         ' + (byState.stale || 0));
  console.log('  archived:      ' + (byState.archived || 0));
  console.log('  pinned:        ' + pinned.length);
  console.log('  stale after:   ' + options.staleDays + 'd unused');
  console.log('  archive after: ' + options.archiveDays + 'd unused');
  if (pinned.length) console.log('\npinned: ' + pinned.join(', '));
}

function printRows(rows) {
  if (!rows.length) {
    console.log('No brainx-created skills tracked.');
    return;
  }
  for (const row of rows) {
    console.log(
      row.name.padEnd(34)
      + ' state=' + String(row.state || 'active').padEnd(8)
      + ' pinned=' + String(Boolean(row.pinned)).padEnd(5)
      + ' activity=' + String(row.activity_count || 0).padStart(3)
      + ' last=' + formatTs(row.last_activity_at)
    );
  }
}

function requireSkill(args) {
  if (!args.skill) throw new Error('missing skill name');
  return args.skill;
}

function idleDays(row, now = new Date()) {
  const anchor = row.last_activity_at || row.created_at;
  if (!anchor) return null;
  const parsed = new Date(anchor);
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - parsed.getTime()) / (24 * 60 * 60 * 1000)));
}

function prune(args, root) {
  const rows = lifecycle.brainxCreatedReport({ root });
  const candidates = rows
    .filter((row) => !row.pinned)
    .filter((row) => row.state !== lifecycle.STATE_ARCHIVED)
    .map((row) => ({ row, idle: idleDays(row) }))
    .filter((item) => item.idle !== null && item.idle >= args.days)
    .sort((a, b) => b.idle - a.idle);

  if (!candidates.length) {
    return { ok: true, checked: rows.length, archived: 0, candidates: [] };
  }

  if (args.dryRun || !args.yes) {
    return {
      ok: true,
      dryRun: true,
      checked: rows.length,
      archived: 0,
      candidates: candidates.map((item) => ({ name: item.row.name, idleDays: item.idle })),
      message: args.dryRun ? 'dry-run; no changes made' : 'pass --yes to archive these skills',
    };
  }

  const results = [];
  for (const item of candidates) {
    const result = lifecycle.archiveSkill(item.row.name, { root });
    results.push({ name: item.row.name, idleDays: item.idle, ...result });
  }
  return {
    ok: results.every((result) => result.ok),
    checked: rows.length,
    archived: results.filter((result) => result.ok).length,
    results,
  };
}

function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const root = args.root || lifecycle.defaultSkillsRoot();
  const command = args.command;

  if (command === 'status') {
    const rows = lifecycle.brainxCreatedReport({ root });
    const payload = { ok: true, root, count: rows.length, rows };
    if (args.json) return payload;
    printStatus(rows, { root, staleDays: args.staleDays, archiveDays: args.archiveDays });
    return payload;
  }

  if (command === 'list') {
    const rows = lifecycle.brainxCreatedReport({ root });
    const payload = { ok: true, root, count: rows.length, rows };
    if (args.json) return payload;
    printRows(rows);
    return payload;
  }

  if (command === 'list-archived') {
    const names = lifecycle.listArchivedSkillNames({ root });
    const payload = { ok: true, root, count: names.length, names };
    if (args.json) return payload;
    if (!names.length) console.log('No archived brainx-created skills.');
    else console.log(names.join('\n'));
    return payload;
  }

  if (command === 'pin' || command === 'unpin') {
    const skill = requireSkill(args);
    if (!lifecycle.isBrainxCreated(skill, { root })) {
      return { ok: false, error: "skill '" + skill + "' is not brainx-created" };
    }
    lifecycle.setPinned(skill, command === 'pin', { root });
    return { ok: true, skill, pinned: command === 'pin' };
  }

  if (command === 'archive') {
    const skill = requireSkill(args);
    const record = lifecycle.getRecord(skill, { root });
    if (record.pinned) return { ok: false, error: "skill '" + skill + "' is pinned; unpin first" };
    return lifecycle.archiveSkill(skill, { root });
  }

  if (command === 'restore') {
    return lifecycle.restoreSkill(requireSkill(args), { root });
  }

  if (command === 'prune') {
    return prune(args, root);
  }

  if (command === 'run') {
    if (args.dryRun) {
      const rows = lifecycle.brainxCreatedReport({ root });
      return { ok: true, dryRun: true, checked: rows.length, rows };
    }
    const counts = lifecycle.applyAutomaticTransitions({
      root,
      staleAfterDays: args.staleDays,
      archiveAfterDays: args.archiveDays,
    });
    return { ok: true, ...counts };
  }

  throw new Error('unknown command: ' + command);
}

function printResult(payload, args) {
  if (args.json) {
    printJson(payload);
    return;
  }
  if (payload.error) {
    console.error('skill-curator: ' + payload.error);
    return;
  }
  if (payload.message) console.log('skill-curator: ' + payload.message);
  if (payload.results) {
    for (const result of payload.results) {
      console.log((result.ok ? 'ok' : 'failed') + ' ' + result.name + ': ' + result.message);
    }
  } else if (payload.skill) {
    console.log('skill-curator: ' + payload.skill + ' pinned=' + payload.pinned);
  } else if (payload.path || payload.message) {
    console.log('skill-curator: ' + (payload.message || payload.path));
  } else if (payload.checked !== undefined) {
    console.log('skill-curator: checked=' + payload.checked + ' stale=' + (payload.marked_stale || 0) + ' archived=' + (payload.archived || 0) + ' reactivated=' + (payload.reactivated || 0));
  }
  if (payload.candidates && payload.candidates.length) {
    for (const candidate of payload.candidates) {
      console.log('  ' + candidate.name + ' idle=' + candidate.idleDays + 'd');
    }
  }
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const payload = run(process.argv.slice(2));
    printResult(payload, args);
    if (!payload.ok) process.exitCode = 1;
  } catch (err) {
    console.error(err.stack || err.message || err);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  idleDays,
  prune,
  run,
};
