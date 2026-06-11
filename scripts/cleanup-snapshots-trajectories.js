#!/usr/bin/env node
/**
 * BrainX V5 — Cleanup snapshots + trajectories.
 *
 * Maintenance for the two long-lived secondary tables that previously had
 * zero retention policy:
 *   - brainx_session_snapshots: drop snapshots older than --max-age-days
 *     (default 30) unless status='blocked' OR status='critical' (those carry
 *     unresolved-blocker context and are kept until --max-age-days * 2).
 *   - brainx_session_snapshots: dedup. Same (agent, project, session-id-prefix
 *     of the id) within 1h → keep newest, drop the rest. We treat the snap_
 *     id as opaque, so dedup runs by (agent, project, session_end DATE) which
 *     is the realistic granularity (the same session is re-snapshotted hourly
 *     while it stays open).
 *   - brainx_trajectories: drop trajectories with times_used=0 AND created_at
 *     older than --trajectory-max-age-days (default 60). Used trajectories
 *     (times_used > 0) are kept indefinitely — they've proven valuable.
 *
 * Usage:
 *   node scripts/cleanup-snapshots-trajectories.js [--dry-run] [--max-age-days 30] [--trajectory-max-age-days 60]
 *
 * Idempotent. Emits JSON summary so it plugs into the alert agent's cron
 * reply template (status: ok / noop / error).
 */

const argv = process.argv.slice(2);

function parseArgs() {
  const args = { dryRun: false, maxAgeDays: 30, trajectoryMaxAgeDays: 60, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--max-age-days') args.maxAgeDays = parseInt(argv[++i], 10) || 30;
    else if (a === '--trajectory-max-age-days') args.trajectoryMaxAgeDays = parseInt(argv[++i], 10) || 60;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '-h' || a === '--help') {
      console.log('Usage: cleanup-snapshots-trajectories.js [--dry-run] [--max-age-days 30] [--trajectory-max-age-days 60] [--verbose]');
      process.exit(0);
    }
  }
  return args;
}

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const pool = new Pool({ connectionString: DATABASE_URL });

async function purgeOldSnapshots(args) {
  // Critical/blocked snapshots get 2x age budget — they hold unresolved
  // context that may still be relevant when the agent comes back to it.
  const sql = args.dryRun
    ? `SELECT COUNT(*) AS n
       FROM brainx_session_snapshots
       WHERE (status NOT IN ('blocked','critical') AND session_end < now() - $1::interval)
          OR (status IN ('blocked','critical')     AND session_end < now() - $2::interval)`
    : `WITH d AS (
         DELETE FROM brainx_session_snapshots
         WHERE (status NOT IN ('blocked','critical') AND session_end < now() - $1::interval)
            OR (status IN ('blocked','critical')     AND session_end < now() - $2::interval)
         RETURNING 1
       ) SELECT COUNT(*) AS n FROM d`;
  const r = await pool.query(sql, [`${args.maxAgeDays} days`, `${args.maxAgeDays * 2} days`]);
  return Number(r.rows[0].n);
}

async function dedupSnapshots(args) {
  // Within (agent, project, DATE(session_end)), keep newest by session_end.
  const selectSql = `
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY agent, project, DATE(session_end) ORDER BY session_end DESC) rn
      FROM brainx_session_snapshots
    ) t WHERE rn > 1`;
  const dups = await pool.query(selectSql);
  if (dups.rowCount === 0 || args.dryRun) return dups.rowCount;
  const ids = dups.rows.map((r) => r.id);
  await pool.query(`DELETE FROM brainx_session_snapshots WHERE id = ANY($1)`, [ids]);
  return ids.length;
}

async function purgeUnusedTrajectories(args) {
  const sql = args.dryRun
    ? `SELECT COUNT(*) AS n
       FROM brainx_trajectories
       WHERE COALESCE(times_used, 0) = 0 AND created_at < now() - $1::interval`
    : `WITH d AS (
         DELETE FROM brainx_trajectories
         WHERE COALESCE(times_used, 0) = 0 AND created_at < now() - $1::interval
         RETURNING 1
       ) SELECT COUNT(*) AS n FROM d`;
  const r = await pool.query(sql, [`${args.trajectoryMaxAgeDays} days`]);
  return Number(r.rows[0].n);
}

async function getCurrentCounts() {
  const a = await pool.query(`SELECT COUNT(*) AS n FROM brainx_session_snapshots`);
  const b = await pool.query(`SELECT COUNT(*) AS n FROM brainx_trajectories`);
  return { snapshots: Number(a.rows[0].n), trajectories: Number(b.rows[0].n) };
}

async function main() {
  const args = parseArgs();
  const before = await getCurrentCounts();

  const result = {
    dryRun: args.dryRun,
    config: { maxAgeDays: args.maxAgeDays, trajectoryMaxAgeDays: args.trajectoryMaxAgeDays },
    before,
    purgedOldSnapshots: 0,
    dedupedSnapshots: 0,
    purgedUnusedTrajectories: 0,
    errors: [],
  };

  try {
    result.purgedOldSnapshots = await purgeOldSnapshots(args);
  } catch (err) {
    result.errors.push({ step: 'purgeOldSnapshots', error: (err.message || String(err)).slice(0, 240) });
  }
  try {
    result.dedupedSnapshots = await dedupSnapshots(args);
  } catch (err) {
    result.errors.push({ step: 'dedupSnapshots', error: (err.message || String(err)).slice(0, 240) });
  }
  try {
    result.purgedUnusedTrajectories = await purgeUnusedTrajectories(args);
  } catch (err) {
    result.errors.push({ step: 'purgeUnusedTrajectories', error: (err.message || String(err)).slice(0, 240) });
  }

  result.after = await getCurrentCounts();
  result.totalRemoved = result.purgedOldSnapshots + result.dedupedSnapshots + result.purgedUnusedTrajectories;
  result.status = result.errors.length > 0 ? 'error' : (result.totalRemoved === 0 ? 'noop' : 'ok');

  await pool.end();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
