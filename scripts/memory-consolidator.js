#!/usr/bin/env node

/**
 * memory-consolidator.js
 *
 * Weekly-safe semantic compaction for mature BrainX memories.
 * It clusters only eligible memories within the same semantic scope
 * and persists the merged result through the normal write path.
 *
 * Usage:
 *   node scripts/memory-consolidator.js [options]
 *   ./brainx consolidate [options]
 *
 * Options:
 *   --dry-run             Preview without writes
 *   --verbose             Show cluster details
 *   --json                Machine-readable output
 *   --limit N             Max clusters to process (default from env / 25)
 *   --min-similarity N    Cosine similarity threshold (default 0.82)
 *   --min-cluster N       Minimum cluster size (default 2)
 *   --max-cluster N       Maximum cluster size (default 5)
 *   --min-age-days N      Minimum age for eligible memories (default 7)
 *   --max-seeds N         Maximum seed memories to inspect (default 600)
 *   --include-borderline  Allow quality:borderline memories into consolidation
 *   --include-changelog   Allow changelog memories into consolidation
 *   --agent NAME          Restrict anchors to one agent
 *   --context CTX         Restrict anchors to one context
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const crypto = require('crypto');
const db = require('../lib/db');
const { storeMemoryWithClient } = require('../lib/openai-rag');
const {
  getSemanticConsolidationConfig,
  isMemoryEligibleForConsolidation,
  canConsolidatePair,
  mergeClusterMemories
} = require('../lib/semantic-consolidation');

function makeId() {
  return `m_cons_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

const argv = process.argv.slice(2);

function flag(name) {
  return argv.includes(`--${name}`);
}

function opt(name, fallback) {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= argv.length) return fallback;
  return argv[idx + 1];
}

function parseIntOpt(name, fallback) {
  const value = Number.parseInt(String(opt(name, fallback)), 10);
  return Number.isFinite(value) ? value : fallback;
}

function parseFloatOpt(name, fallback) {
  const value = Number.parseFloat(String(opt(name, fallback)));
  return Number.isFinite(value) ? value : fallback;
}

const defaults = getSemanticConsolidationConfig();
const DRY_RUN = flag('dry-run');
const VERBOSE = flag('verbose');
const JSON_OUT = flag('json');
const LIMIT = parseIntOpt('limit', 25);
const CONFIG = getSemanticConsolidationConfig({
  minSimilarity: parseFloatOpt('min-similarity', defaults.minSimilarity),
  minCluster: parseIntOpt('min-cluster', defaults.minCluster),
  maxCluster: parseIntOpt('max-cluster', defaults.maxCluster),
  minAgeDays: parseIntOpt('min-age-days', defaults.minAgeDays),
  maxSeeds: parseIntOpt('max-seeds', defaults.maxSeeds),
  includeBorderline: flag('include-borderline') ? true : defaults.includeBorderline,
  includeChangelog: flag('include-changelog') ? true : defaults.includeChangelog
});
const AGENT_FILTER = opt('agent', null);
const CONTEXT_FILTER = opt('context', null);

const MEMORY_FIELDS = `
  id, type, content, context, tier, agent, importance, tags,
  status, category, pattern_key, recurrence_count, first_seen, last_seen,
  source_kind, source_path, confidence_score, sensitivity, verification_state,
  created_at, last_accessed
`;

function log(...args) {
  if (!JSON_OUT) console.log(...args);
}

function vlog(...args) {
  if (VERBOSE && !JSON_OUT) console.log(...args);
}

function buildEligibleWhere(config, params, mode = 'seed', scope = {}) {
  const clauses = [
    `superseded_by IS NULL`,
    `tier != 'archive'`,
    `embedding IS NOT NULL`,
    `created_at <= NOW() - make_interval(days => $${params.push(config.minAgeDays)})`,
    `type = ANY($${params.push(config.includeTypes)}::text[])`,
    `COALESCE(verification_state, 'hypothesis') != 'obsolete'`,
    `COALESCE(source_kind, '') != ALL($${params.push(config.excludeSourceKinds)}::text[])`
  ];

  const blockedTags = config.includeBorderline
    ? ['quality:rejected']
    : ['quality:rejected', 'quality:borderline'];
  clauses.push(
    `NOT (COALESCE(tags, ARRAY[]::text[]) && $${params.push(blockedTags)}::text[])`
  );

  if (!config.includeChangelog) {
    clauses.push(`COALESCE(verification_state, 'hypothesis') != 'changelog'`);
  }

  if (mode === 'seed') {
    if (AGENT_FILTER) {
      clauses.push(`agent = $${params.push(AGENT_FILTER)}`);
    }
    if (CONTEXT_FILTER !== null) {
      const index = params.push(CONTEXT_FILTER);
      clauses.push(`(($${index}::text IS NULL AND context IS NULL) OR context = $${index})`);
    }
    return clauses;
  }

  if (config.requireSameType !== false) {
    clauses.push(`type = $${params.push(scope.type || null)}`);
  }
  if (config.requireSameAgent !== false) {
    const index = params.push(scope.agent || null);
    clauses.push(`(($${index}::text IS NULL AND agent IS NULL) OR agent = $${index})`);
  }
  if (config.requireSameContext !== false) {
    const index = params.push(scope.context || null);
    clauses.push(`(($${index}::text IS NULL AND context IS NULL) OR context = $${index})`);
  }
  if (config.requireSameCategory !== false) {
    const index = params.push(scope.category || null);
    clauses.push(`(($${index}::text IS NULL AND category IS NULL) OR category = $${index})`);
  }
  if (config.requireSameSensitivity !== false) {
    clauses.push(`COALESCE(sensitivity, 'normal') = $${params.push(scope.sensitivity || 'normal')}`);
  }

  return clauses;
}

async function fetchEligibleSeeds(config) {
  const params = [];
  const where = buildEligibleWhere(config, params, 'seed');

  const sql = `
    SELECT ${MEMORY_FIELDS}
    FROM brainx_memories
    WHERE ${where.join('\n      AND ')}
    ORDER BY COALESCE(recurrence_count, 1) DESC,
             importance DESC,
             COALESCE(last_seen, last_accessed, created_at) DESC
    LIMIT $${params.push(config.maxSeeds)}
  `;

  const res = await db.query(sql, params);
  return res.rows;
}

async function findSimilar(anchor, config, assigned, now) {
  const anchorCheck = isMemoryEligibleForConsolidation(anchor, config, now);
  if (!anchorCheck.eligible) return [];

  const params = [anchor.id];
  const where = [
    `id != $1`,
    `1 - (embedding <=> (SELECT embedding FROM brainx_memories WHERE id = $1)) >= $${params.push(config.minSimilarity)}`
  ].concat(buildEligibleWhere(config, params, 'neighbor', anchorCheck.scope));

  const sql = `
    SELECT ${MEMORY_FIELDS},
           1 - (embedding <=> (SELECT embedding FROM brainx_memories WHERE id = $1)) AS similarity
    FROM brainx_memories
    WHERE ${where.join('\n      AND ')}
    ORDER BY similarity DESC,
             COALESCE(recurrence_count, 1) DESC,
             importance DESC
    LIMIT $${params.push(config.maxNeighbors)}
  `;

  const res = await db.query(sql, params);
  return res.rows.filter((candidate) => {
    if (assigned.has(candidate.id)) return false;
    return canConsolidatePair(anchor, candidate, config, now).ok;
  });
}

async function buildClusters(seeds, config, limit) {
  const now = new Date();
  const assigned = new Set();
  const clusters = [];

  for (const seed of seeds) {
    if (clusters.length >= limit) break;
    if (assigned.has(seed.id)) continue;

    const eligibility = isMemoryEligibleForConsolidation(seed, config, now);
    if (!eligibility.eligible) continue;

    const cluster = new Map([[seed.id, seed]]);
    const queue = [seed];
    const visited = new Set([seed.id]);

    while (queue.length > 0 && cluster.size < config.maxCluster) {
      const current = queue.shift();
      const neighbors = await findSimilar(current, config, assigned, now);
      for (const neighbor of neighbors) {
        if (visited.has(neighbor.id)) continue;
        if (!canConsolidatePair(seed, neighbor, config, now).ok) continue;
        visited.add(neighbor.id);
        cluster.set(neighbor.id, neighbor);
        queue.push(neighbor);
        if (cluster.size >= config.maxCluster) break;
      }
    }

    if (cluster.size < config.minCluster) continue;

    for (const memory of cluster.values()) {
      assigned.add(memory.id);
    }
    clusters.push([...cluster.values()]);
  }

  return clusters;
}

async function consolidateCluster(merged) {
  return db.withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const stored = await storeMemoryWithClient(client, {
        id: makeId(),
        type: merged.type,
        content: merged.content,
        context: merged.context,
        tier: merged.tier,
        agent: merged.agent,
        importance: merged.importance,
        tags: merged.tags,
        status: merged.status,
        category: merged.category,
        recurrence_count: merged.recurrence_count,
        first_seen: merged.first_seen,
        last_seen: merged.last_seen,
        source_kind: merged.source_kind,
        source_path: merged.source_path,
        confidence_score: merged.confidence_score,
        verification_state: merged.verification_state,
        sensitivity: merged.sensitivity
      }, { skipDedupe: true });

      const update = await client.query(
        `UPDATE brainx_memories
         SET superseded_by = $1,
             tags = CASE
               WHEN NOT (COALESCE(tags, ARRAY[]::text[]) @> ARRAY['consolidated:source']::text[])
                 THEN COALESCE(tags, ARRAY[]::text[]) || ARRAY['consolidated:source']::text[]
               ELSE COALESCE(tags, ARRAY[]::text[])
             END
         WHERE id = ANY($2::text[])
           AND superseded_by IS NULL`,
        [stored.id, merged.source_ids]
      );

      if (update.rowCount !== merged.source_ids.length) {
        throw new Error(`supersede mismatch: expected ${merged.source_ids.length}, updated ${update.rowCount}`);
      }

      await client.query('COMMIT');
      return { id: stored.id, superseded: update.rowCount };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

async function main() {
  const startTime = Date.now();
  log('BrainX Weekly Semantic Consolidation');
  log(`  Similarity threshold: ${CONFIG.minSimilarity}`);
  log(`  Cluster size: ${CONFIG.minCluster}-${CONFIG.maxCluster}`);
  log(`  Minimum age: ${CONFIG.minAgeDays}d`);
  log(`  Seed limit: ${CONFIG.maxSeeds}`);
  log(`  Max clusters: ${LIMIT}`);
  log(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  log('');

  const countBefore = await db.query(
    `SELECT count(*) AS total
     FROM brainx_memories
     WHERE superseded_by IS NULL
       AND tier != 'archive'`
  );
  const totalBefore = Number.parseInt(countBefore.rows[0].total, 10);
  log(`Active memories before: ${totalBefore}`);

  const seeds = await fetchEligibleSeeds(CONFIG);
  log(`Eligible seeds: ${seeds.length}`);

  const clusters = await buildClusters(seeds, CONFIG, LIMIT);
  log(`Clusters ready: ${clusters.length}`);

  const stats = {
    eligibleSeeds: seeds.length,
    clustersProcessed: 0,
    memoriesConsolidated: 0,
    newMemories: 0,
    errors: 0
  };
  const results = [];

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    const merged = mergeClusterMemories(cluster, CONFIG);
    const scopePreview = [merged.type, merged.agent || '<none>', merged.context || '<none>'].join(' | ');

    vlog(`\nCluster ${i + 1} (${cluster.length}) :: ${scopePreview}`);
    for (const memory of cluster) {
      vlog(`  [${memory.id.slice(0, 10)}] imp=${memory.importance} rec=${memory.recurrence_count || 1} ${memory.content.slice(0, 90)}`);
    }
    vlog(`  => ${merged.content.slice(0, 140)}`);

    if (DRY_RUN) {
      results.push({
        cluster: i + 1,
        size: cluster.length,
        memberIds: cluster.map((memory) => memory.id),
        scope: scopePreview,
        mergedPreview: merged.content.slice(0, 220),
        verificationState: merged.verification_state,
        recurrenceCount: merged.recurrence_count
      });
      stats.clustersProcessed++;
      stats.memoriesConsolidated += cluster.length;
      continue;
    }

    try {
      const result = await consolidateCluster(merged);
      log(`  Cluster ${i + 1}: created ${result.id.slice(0, 10)}, superseded ${result.superseded}`);
      results.push({
        cluster: i + 1,
        newId: result.id,
        superseded: result.superseded,
        memberIds: cluster.map((memory) => memory.id)
      });
      stats.clustersProcessed++;
      stats.memoriesConsolidated += cluster.length;
      stats.newMemories++;
    } catch (err) {
      log(`  Cluster ${i + 1} failed: ${err.message}`);
      stats.errors++;
    }
  }

  const countAfter = await db.query(
    `SELECT count(*) AS total
     FROM brainx_memories
     WHERE superseded_by IS NULL
       AND tier != 'archive'`
  );
  const totalAfter = Number.parseInt(countAfter.rows[0].total, 10);
  const elapsed = Number((((Date.now() - startTime) / 1000))).toFixed(1);

  log('');
  log('Summary');
  log(`  Active memories: ${totalBefore} -> ${DRY_RUN ? totalBefore : totalAfter}`);
  log(`  Eligible seeds: ${stats.eligibleSeeds}`);
  log(`  Clusters processed: ${stats.clustersProcessed}`);
  log(`  Memories consolidated: ${stats.memoriesConsolidated}`);
  log(`  New merged memories: ${stats.newMemories}`);
  log(`  Errors: ${stats.errors}`);
  log(`  Elapsed: ${elapsed}s`);

  if (JSON_OUT) {
    console.log(JSON.stringify({
      ok: stats.errors === 0,
      dryRun: DRY_RUN,
      before: totalBefore,
      after: DRY_RUN ? totalBefore : totalAfter,
      config: {
        minSimilarity: CONFIG.minSimilarity,
        minCluster: CONFIG.minCluster,
        maxCluster: CONFIG.maxCluster,
        minAgeDays: CONFIG.minAgeDays,
        maxSeeds: CONFIG.maxSeeds
      },
      stats,
      results,
      elapsed: Number(elapsed)
    }, null, 2));
  }
}

main()
  .catch((err) => {
    if (JSON_OUT) {
      console.log(JSON.stringify({ ok: false, error: err.message }));
    } else {
      console.error(`Fatal: ${err.message}`);
    }
    process.exit(1);
  })
  .finally(() => db.pool.end());
