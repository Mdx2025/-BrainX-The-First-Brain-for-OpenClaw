/**
 * BrainX Fix — Auto-Repair
 * Fixes issues detected by `brainx doctor`.
 * Output styled with Unicode box-drawing (clack/prompts style).
 */

const fs = require('fs');
const path = require('path');
const { deriveSensitivity, normalizeSensitivity } = require('./brainx-phase2');
const {
  readCanonicalRules,
  extractSuggestionMetadata,
  targetKeyToPromotedTo,
  findCanonicalRuleMatch,
  isLowSignalPromotionRule,
  normalizeRule,
} = require('./promotion-governance');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'sql', 'migrations');
const FINANCIAL_HINTS = /(credit|card|visa|mastercard|amex|payment|billing|stripe|tarjeta)/i;

function hasAllEntries(set, values) {
  return values.every((value) => set.has(value));
}

async function loadMigrationSnapshot(db) {
  const [memoryColsRes, allColsRes, constraintRes, tableRes, indexRes] = await Promise.all([
    db.query(`SELECT column_name FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'brainx_memories'`),
    db.query(`SELECT table_name, column_name FROM information_schema.columns
              WHERE table_schema = 'public'`),
    db.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE connamespace = 'public'::regnamespace`),
    db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`),
    db.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`)
  ]);

  return {
    memoryColumns: new Set(memoryColsRes.rows.map((row) => row.column_name)),
    columns: new Set(allColsRes.rows.map((row) => `${row.table_name}.${row.column_name}`)),
    constraints: new Set(constraintRes.rows.map((row) => row.conname)),
    constraintDefs: new Map(constraintRes.rows.map((row) => [row.conname, row.def || ''])),
    tables: new Set(tableRes.rows.map((row) => row.table_name)),
    indexes: new Set(indexRes.rows.map((row) => row.indexname))
  };
}

function sanitizeSensitivityTags(tags, content) {
  const list = Array.isArray(tags) ? tags.map(String) : [];
  const hasFinanceHints = FINANCIAL_HINTS.test(String(content || ''));
  const filtered = list.filter((tag) => tag !== 'pii:credit_card' || hasFinanceHints);
  const piiReasons = filtered.filter((tag) => tag.startsWith('pii:') && tag !== 'pii:redacted');
  if (piiReasons.length === 0) {
    return filtered.filter((tag) => tag !== 'pii:redacted');
  }
  return filtered;
}

function buildRedactionMeta(tags, content) {
  const list = sanitizeSensitivityTags(tags, content);
  const reasons = list
    .filter((tag) => tag.startsWith('pii:') && tag !== 'pii:redacted')
    .map((tag) => tag.slice(4));
  return {
    redacted: list.includes('pii:redacted') && reasons.length > 0,
    reasons
  };
}

function parseOnlySteps(rawValue) {
  if (!rawValue) return null;
  const values = String(rawValue)
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return values.length ? values : null;
}

// ─── Step 1: Apply missing migrations ───

async function applyMigrations(db, opts = {}) {
  const { dryRun = false } = opts;

  let files;
  try {
    files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  } catch (err) {
    return { label: 'Migrations', status: 'warn', detail: err.message };
  }

  if (files.length === 0) {
    return { label: 'Migrations', status: 'ok', detail: 'no migration files found' };
  }

  const migrationChecks = {
    '007_v5_features.sql': (snapshot) =>
      hasAllEntries(snapshot.tables, ['brainx_advisories', 'brainx_eidos_cycles', 'brainx_distillation_log']),
    '2026-02-24_phase2_governance.sql': (snapshot) =>
      hasAllEntries(snapshot.memoryColumns, [
        'status',
        'category',
        'pattern_key',
        'recurrence_count',
        'first_seen',
        'last_seen',
        'resolved_at',
        'promoted_to',
        'resolution_notes'
      ]) &&
      hasAllEntries(snapshot.constraints, ['brainx_memories_status_check', 'brainx_memories_category_check']) &&
      hasAllEntries(snapshot.tables, ['brainx_patterns', 'brainx_query_log']),
    '2026-03-27_verification_state.sql': (snapshot) =>
      snapshot.memoryColumns.has('verification_state') &&
      snapshot.constraints.has('brainx_memories_verification_state_check') &&
      snapshot.indexes.has('idx_mem_verification_state'),
    '2026-04-02_knowledge_source_kinds.sql': (snapshot) => {
      const def = snapshot.constraintDefs.get('brainx_memories_source_kind_check') || '';
      return def.includes('knowledge_canonical') &&
        def.includes('knowledge_staging') &&
        def.includes('knowledge_generated');
    },
    '009_runtime_injections.sql': (snapshot) =>
      snapshot.tables.has('brainx_runtime_injections') &&
      snapshot.indexes.has('idx_runtime_inj_agent') &&
      snapshot.indexes.has('idx_runtime_inj_session') &&
      snapshot.indexes.has('idx_runtime_inj_surface') &&
      snapshot.indexes.has('idx_runtime_inj_unscored'),
    '010_intake_gate_prompt_preview.sql': (snapshot) =>
      snapshot.columns.has('brainx_intake_gates.prompt_preview'),
    '011_runtime_injection_decisions.sql': (snapshot) =>
      snapshot.columns.has('brainx_runtime_injections.decision_summary') &&
      snapshot.columns.has('brainx_runtime_injections.top_candidates'),
    '012_artifact_ledger.sql': (snapshot) =>
      snapshot.tables.has('brainx_artifact_ledger') &&
      snapshot.indexes.has('idx_brainx_artifacts_agent_last_seen') &&
      snapshot.indexes.has('idx_brainx_artifacts_session_key_last_seen'),
    '013_context_broker_artifact_v2.sql': (snapshot) =>
      snapshot.tables.has('brainx_artifact_ledger') &&
      snapshot.tables.has('brainx_context_state') &&
      snapshot.columns.has('brainx_artifact_ledger.artifact_role') &&
      snapshot.columns.has('brainx_artifact_ledger.project_key') &&
      snapshot.columns.has('brainx_artifact_ledger.provenance') &&
      snapshot.columns.has('brainx_artifact_ledger.finality_score') &&
      snapshot.columns.has('brainx_artifact_ledger.metadata') &&
      snapshot.indexes.has('idx_brainx_artifacts_finality_last_seen') &&
      snapshot.indexes.has('idx_brainx_context_state_agent_updated') &&
      snapshot.indexes.has('idx_brainx_context_state_session_key'),
    '014_session_rotation_events.sql': (snapshot) =>
      snapshot.tables.has('brainx_session_rotation_events') &&
      snapshot.indexes.has('idx_brainx_session_rotation_event_unique') &&
      snapshot.indexes.has('idx_brainx_session_rotation_events_agent_detected') &&
      snapshot.indexes.has('idx_brainx_session_rotation_events_session_key_detected'),
    '015_runtime_injections_session_key.sql': (snapshot) =>
      snapshot.columns.has('brainx_runtime_injections.session_key') &&
      snapshot.indexes.has('idx_runtime_inj_session_key'),
    '016_policy_decisions.sql': (snapshot) =>
      snapshot.tables.has('brainx_policy_decisions') &&
      snapshot.indexes.has('idx_brainx_policy_decisions_agent_created') &&
      snapshot.indexes.has('idx_brainx_policy_decisions_surface_created'),
    '2026-04-19_category_domains.sql': (snapshot) => {
      const def = snapshot.constraintDefs.get('brainx_memories_category_check') || '';
      return ['marketing', 'design', 'legal', 'communication', 'product', 'operations', 'content', 'research']
        .every((category) => def.includes(category));
    },
  };

  let snapshot;
  try {
    snapshot = await loadMigrationSnapshot(db);
  } catch (err) {
    return { label: 'Migrations', status: 'fail', detail: `schema inspection failed — ${err.message}` };
  }

  const applied = [];
  for (const file of files) {
    const checkFn = migrationChecks[file];
    if (checkFn && checkFn(snapshot)) continue;

    if (dryRun) { applied.push(file); continue; }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await db.query(sql);
      applied.push(file);
      snapshot = await loadMigrationSnapshot(db);
    } catch (err) {
      return { label: 'Migrations', status: 'fail', detail: `${file} — ${err.message}` };
    }
  }

  if (applied.length === 0) {
    return { label: 'Migrations', status: 'ok', detail: 'nothing to apply' };
  }
  const prefix = dryRun ? 'would apply' : 'applied';
  return {
    label: 'Migrations', status: 'fixed',
    detail: `${prefix} ${applied.length}: ${applied.join(', ')}`,
    verbose: applied.map(f => `${dryRun ? 'would apply' : 'applied'}: ${f}`)
  };
}

// ─── Step 2: Clean expired memories ───

async function cleanExpired(db, opts = {}) {
  const { dryRun = false } = opts;

  const colCheck = await db.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'brainx_memories' AND column_name = 'expires_at'`
  );
  if (colCheck.rows.length === 0) {
    return { label: 'Expired cleanup', status: 'ok', detail: 'no expires_at column' };
  }

  const countRes = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM brainx_memories
     WHERE expires_at IS NOT NULL AND expires_at < NOW() AND superseded_by IS NULL`
  );
  const count = countRes.rows[0]?.cnt || 0;

  if (count === 0) return { label: 'Expired cleanup', status: 'ok', detail: 'no expired memories' };
  if (dryRun) return { label: 'Expired cleanup', status: 'fixed', detail: `would archive ${count} memories` };

  await db.query(
    `UPDATE brainx_memories SET tier = 'archive', superseded_by = 'expired'
     WHERE expires_at IS NOT NULL AND expires_at < NOW() AND superseded_by IS NULL`
  );
  return { label: 'Expired cleanup', status: 'fixed', detail: `archived ${count} memories` };
}

// ─── Step 3: Fix orphaned superseded_by ───

async function fixOrphans(db, opts = {}) {
  const { dryRun = false } = opts;

  const res = await db.query(
    `SELECT m.id FROM brainx_memories m
     WHERE m.superseded_by IS NOT NULL AND m.superseded_by != 'expired'
       AND NOT EXISTS (SELECT 1 FROM brainx_memories t WHERE t.id = m.superseded_by)`
  );
  const count = res.rows.length;

  if (count === 0) return { label: 'Orphaned refs', status: 'ok', detail: 'no orphans found' };
  if (dryRun) {
    return { label: 'Orphaned refs', status: 'fixed', detail: `would fix ${count} refs`,
      verbose: res.rows.map(r => `would fix: ${r.id}`) };
  }

  await db.query(`UPDATE brainx_memories SET superseded_by = NULL WHERE id = ANY($1)`,
    [res.rows.map(r => r.id)]);
  return { label: 'Orphaned refs', status: 'fixed', detail: `cleared ${count} refs` };
}

// ─── Step 4: Backfill legacy provenance ───

async function backfillProvenance(db, opts = {}) {
  const { dryRun = false } = opts;

  const colCheck = await db.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'brainx_memories' AND column_name = 'source_kind'`
  );
  if (colCheck.rows.length === 0) {
    return { label: 'Legacy provenance', status: 'ok', detail: 'source_kind column not present' };
  }

  const countRes = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM brainx_memories
     WHERE source_kind IS NULL AND superseded_by IS NULL`
  );
  const count = countRes.rows[0]?.cnt || 0;

  if (count === 0) return { label: 'Legacy provenance', status: 'ok', detail: 'all have source_kind' };
  if (dryRun) return { label: 'Legacy provenance', status: 'fixed', detail: `would backfill ${count} memories` };

  await db.query(
    `UPDATE brainx_memories SET source_kind = 'markdown_import'
     WHERE source_kind IS NULL AND superseded_by IS NULL`
  );
  return { label: 'Legacy provenance', status: 'fixed', detail: `backfilled ${count} memories` };
}

// ─── Step 5: Recalibrate sensitivity ───

async function recalibrateSensitivity(db, opts = {}) {
  const { dryRun = false } = opts;

  let rows;
  try {
    const res = await db.query(
      `SELECT id, content, context, tags, sensitivity
       FROM brainx_memories
       WHERE COALESCE(sensitivity, 'normal') = 'normal'
       ORDER BY created_at DESC`
    );
    rows = res.rows;
  } catch (err) {
    return { label: 'Sensitivity calibration', status: 'fail', detail: err.message };
  }

  const changes = [];
  const groupedIds = {};

  for (const row of rows) {
    const sanitizedTags = sanitizeSensitivityTags(row.tags, row.content);
    const current = normalizeSensitivity(row.sensitivity);
    const next = deriveSensitivity({
      explicit: null,
      content: row.content,
      context: row.context,
      tags: sanitizedTags,
      redactionMeta: buildRedactionMeta(sanitizedTags, row.content)
    });

    if (next === current) continue;

    if (!groupedIds[next]) groupedIds[next] = [];
    groupedIds[next].push(row.id);
    changes.push({
      id: row.id,
      from: current,
      to: next,
      content: String(row.content || '').replace(/\s+/g, ' ').trim().slice(0, 160)
    });
  }

  if (changes.length === 0) {
    return { label: 'Sensitivity calibration', status: 'ok', detail: `no recalibration needed (${rows.length} checked)` };
  }

  if (dryRun) {
    return {
      label: 'Sensitivity calibration',
      status: 'fixed',
      detail: `would recalibrate ${changes.length} memories (${rows.length} checked)`,
      verbose: changes.slice(0, 10).map((row) => `${row.id} ${row.from}->${row.to} ${row.content}`)
    };
  }

  try {
    for (const [target, ids] of Object.entries(groupedIds)) {
      await db.query(
        `UPDATE brainx_memories
         SET sensitivity = $2
         WHERE id = ANY($1::text[])`,
        [ids, target]
      );
    }
  } catch (err) {
    return { label: 'Sensitivity calibration', status: 'fail', detail: err.message };
  }

  return {
    label: 'Sensitivity calibration',
    status: 'fixed',
    detail: `recalibrated ${changes.length} memories (${rows.length} checked)`,
    verbose: changes.slice(0, 10).map((row) => `${row.id} ${row.from}->${row.to} ${row.content}`)
  };
}

// ─── Step 6: Raise durable confidence floors ───

async function curateDurableConfidence(db, opts = {}) {
  const { dryRun = false } = opts;

  const candidateBaseSql = `
    SELECT
      id,
      verification_state,
      source_kind,
      tier,
      importance,
      COALESCE(confidence_score, 0) AS current_confidence,
      CASE
        WHEN verification_state = 'verified' AND source_kind = 'knowledge_canonical' THEN 0.98
        WHEN verification_state = 'verified' AND source_kind = 'tool_verified' THEN 0.95
        WHEN verification_state = 'verified' AND source_kind = 'consolidated' THEN 0.88
        WHEN verification_state = 'verified' AND source_kind = 'markdown_import' THEN 0.86
        WHEN verification_state = 'verified' AND source_kind = 'agent_inference' THEN 0.84
        WHEN verification_state = 'changelog' AND source_kind IN ('tool_verified', 'summary_derived') THEN 0.84
        WHEN verification_state = 'changelog' AND source_kind IN ('agent_inference', 'markdown_import', 'consolidated') THEN 0.80
        ELSE NULL
      END AS next_confidence,
      LEFT(REPLACE(REPLACE(COALESCE(content, ''), E'\\n', ' '), E'\\r', ' '), 160) AS preview
    FROM brainx_memories
    WHERE superseded_by IS NULL
      AND (expires_at IS NULL OR expires_at > NOW())
      AND tier IN ('hot', 'warm')
      AND importance >= 7
      AND verification_state IN ('verified', 'changelog')
  `;

  const candidateSelectSql = `
    SELECT
      id,
      verification_state,
      source_kind,
      tier,
      importance,
      current_confidence,
      next_confidence,
      preview
    FROM (${candidateBaseSql}) AS candidates
    WHERE next_confidence IS NOT NULL
      AND current_confidence < (next_confidence - 0.001)
    ORDER BY next_confidence DESC, current_confidence ASC, importance DESC, id ASC
  `;

  let rows;
  try {
    const res = await db.query(candidateSelectSql);
    rows = res.rows;
  } catch (err) {
    return { label: 'Durable confidence', status: 'fail', detail: err.message };
  }

  if (rows.length === 0) {
    return { label: 'Durable confidence', status: 'ok', detail: 'no durable confidence updates needed' };
  }

  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.verification_state}/${row.source_kind}->${Number(row.next_confidence).toFixed(2)}`;
    grouped.set(key, (grouped.get(key) || 0) + 1);
  }
  const breakdown = Array.from(grouped.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([key, count]) => `${key}:${count}`);

  if (dryRun) {
    return {
      label: 'Durable confidence',
      status: 'fixed',
      detail: `would raise ${rows.length} durable memories`,
      verbose: [
        ...breakdown,
        ...rows.slice(0, 8).map((row) =>
          `${row.id} ${row.verification_state}/${row.source_kind} ${Number(row.current_confidence).toFixed(2)}->${Number(row.next_confidence).toFixed(2)} ${row.preview}`
        ),
      ],
    };
  }

  try {
    await db.query(
      `WITH candidates AS (${candidateBaseSql})
       UPDATE brainx_memories AS mem
       SET confidence_score = candidates.next_confidence
       FROM candidates
       WHERE mem.id = candidates.id
         AND candidates.next_confidence IS NOT NULL
         AND COALESCE(mem.confidence_score, 0) < (candidates.next_confidence - 0.001)`
    );
  } catch (err) {
    return { label: 'Durable confidence', status: 'fail', detail: err.message };
  }

  return {
    label: 'Durable confidence',
    status: 'fixed',
    detail: `raised ${rows.length} durable memories`,
    verbose: breakdown,
  };
}

// ─── Step 7: Demote stale tiers ───

async function demoteStaleTiers(db, opts = {}) {
  const { dryRun = false } = opts;

  const carriedStaleRes = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM brainx_memories
     WHERE tier IN ('hot', 'warm')
       AND superseded_by IS NULL
       AND source_kind = 'consolidated'
       AND COALESCE(access_count, 0) = 0
       AND last_accessed IS NOT NULL
       AND last_accessed < created_at
       AND last_accessed < NOW() - INTERVAL '30 days'`
  );
  const carriedStaleCount = carriedStaleRes.rows[0]?.cnt || 0;

  const staleImportRes = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM brainx_memories
     WHERE tier IN ('hot', 'warm')
       AND superseded_by IS NULL
       AND source_kind = 'markdown_import'
       AND COALESCE(last_accessed, created_at) < NOW() - INTERVAL '30 days'`
  );
  const staleImportCount = staleImportRes.rows[0]?.cnt || 0;

  const staleInferenceRes = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM brainx_memories
     WHERE tier IN ('hot', 'warm')
       AND superseded_by IS NULL
       AND source_kind = 'agent_inference'
       AND COALESCE(verification_state, 'hypothesis') != 'verified'
       AND COALESCE(last_accessed, created_at) < NOW() - INTERVAL '30 days'`
  );
  const staleInferenceCount = staleInferenceRes.rows[0]?.cnt || 0;

  const hotRes = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM brainx_memories
     WHERE tier = 'hot'
       AND superseded_by IS NULL
       AND NOT (
         source_kind = 'consolidated'
         AND COALESCE(access_count, 0) = 0
         AND last_accessed IS NOT NULL
         AND last_accessed < created_at
         AND last_accessed < NOW() - INTERVAL '30 days'
       )
       AND NOT (
         source_kind = 'markdown_import'
         AND COALESCE(last_accessed, created_at) < NOW() - INTERVAL '30 days'
       )
       AND NOT (
         source_kind = 'agent_inference'
         AND COALESCE(verification_state, 'hypothesis') != 'verified'
         AND COALESCE(last_accessed, created_at) < NOW() - INTERVAL '30 days'
       )
       AND COALESCE(last_accessed, created_at) < NOW() - INTERVAL '60 days'`
  );
  const hotCount = hotRes.rows[0]?.cnt || 0;

  const warmRes = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM brainx_memories
     WHERE tier = 'warm'
       AND superseded_by IS NULL
       AND NOT (
         source_kind = 'consolidated'
         AND COALESCE(access_count, 0) = 0
         AND last_accessed IS NOT NULL
         AND last_accessed < created_at
         AND last_accessed < NOW() - INTERVAL '30 days'
       )
       AND NOT (
         source_kind = 'markdown_import'
         AND COALESCE(last_accessed, created_at) < NOW() - INTERVAL '30 days'
       )
       AND NOT (
         source_kind = 'agent_inference'
         AND COALESCE(verification_state, 'hypothesis') != 'verified'
         AND COALESCE(last_accessed, created_at) < NOW() - INTERVAL '30 days'
       )
       AND COALESCE(last_accessed, created_at) < NOW() - INTERVAL '90 days'`
  );
  const warmCount = warmRes.rows[0]?.cnt || 0;

  if (carriedStaleCount === 0 && staleImportCount === 0 && staleInferenceCount === 0 && hotCount === 0 && warmCount === 0) {
    return { label: 'Stale demotion', status: 'ok', detail: 'no stale tiers' };
  }

  const parts = [];
  if (carriedStaleCount > 0) parts.push(`${carriedStaleCount} carried stale consolidated→cold`);
  if (staleImportCount > 0) parts.push(`${staleImportCount} stale imports→cold`);
  if (staleInferenceCount > 0) parts.push(`${staleInferenceCount} stale inference→cold`);
  if (hotCount > 0) parts.push(`${hotCount} hot→warm`);
  if (warmCount > 0) parts.push(`${warmCount} warm→cold`);

  if (dryRun) return { label: 'Stale demotion', status: 'fixed', detail: `would demote ${parts.join(', ')}` };

  if (carriedStaleCount > 0) {
    await db.query(
      `UPDATE brainx_memories
       SET tier = 'cold',
           tags = CASE
             WHEN NOT (COALESCE(tags, '{}') @> ARRAY['carried_stale_demoted']) THEN COALESCE(tags, '{}') || ARRAY['carried_stale_demoted']
             ELSE tags
           END
       WHERE tier IN ('hot', 'warm')
         AND superseded_by IS NULL
         AND source_kind = 'consolidated'
         AND COALESCE(access_count, 0) = 0
         AND last_accessed IS NOT NULL
         AND last_accessed < created_at
         AND last_accessed < NOW() - INTERVAL '30 days'`
    );
  }
  if (staleImportCount > 0) {
    await db.query(
      `UPDATE brainx_memories
       SET tier = 'cold',
           tags = CASE
             WHEN NOT (COALESCE(tags, '{}') @> ARRAY['stale_import_demoted']) THEN COALESCE(tags, '{}') || ARRAY['stale_import_demoted']
             ELSE tags
           END
       WHERE tier IN ('hot', 'warm')
         AND superseded_by IS NULL
         AND source_kind = 'markdown_import'
         AND COALESCE(last_accessed, created_at) < NOW() - INTERVAL '30 days'`
    );
  }
  if (staleInferenceCount > 0) {
    await db.query(
      `UPDATE brainx_memories
       SET tier = 'cold',
           tags = CASE
             WHEN NOT (COALESCE(tags, '{}') @> ARRAY['stale_inference_demoted']) THEN COALESCE(tags, '{}') || ARRAY['stale_inference_demoted']
             ELSE tags
           END
       WHERE tier IN ('hot', 'warm')
         AND superseded_by IS NULL
         AND source_kind = 'agent_inference'
         AND COALESCE(verification_state, 'hypothesis') != 'verified'
         AND COALESCE(last_accessed, created_at) < NOW() - INTERVAL '30 days'`
    );
  }
  if (hotCount > 0) {
    await db.query(
      `UPDATE brainx_memories
       SET tier = 'warm'
       WHERE tier = 'hot'
         AND superseded_by IS NULL
         AND NOT (
           source_kind = 'consolidated'
           AND COALESCE(access_count, 0) = 0
           AND last_accessed IS NOT NULL
           AND last_accessed < created_at
           AND last_accessed < NOW() - INTERVAL '30 days'
         )
         AND NOT (
           source_kind = 'markdown_import'
           AND COALESCE(last_accessed, created_at) < NOW() - INTERVAL '30 days'
         )
         AND NOT (
           source_kind = 'agent_inference'
           AND COALESCE(verification_state, 'hypothesis') != 'verified'
           AND COALESCE(last_accessed, created_at) < NOW() - INTERVAL '30 days'
         )
         AND COALESCE(last_accessed, created_at) < NOW() - INTERVAL '60 days'`
    );
  }
  if (warmCount > 0) {
    await db.query(
      `UPDATE brainx_memories
       SET tier = 'cold'
       WHERE tier = 'warm'
         AND superseded_by IS NULL
         AND NOT (
           source_kind = 'consolidated'
           AND COALESCE(access_count, 0) = 0
           AND last_accessed IS NOT NULL
           AND last_accessed < created_at
           AND last_accessed < NOW() - INTERVAL '30 days'
         )
         AND NOT (
           source_kind = 'markdown_import'
           AND COALESCE(last_accessed, created_at) < NOW() - INTERVAL '30 days'
         )
         AND NOT (
           source_kind = 'agent_inference'
           AND COALESCE(verification_state, 'hypothesis') != 'verified'
           AND COALESCE(last_accessed, created_at) < NOW() - INTERVAL '30 days'
         )
         AND COALESCE(last_accessed, created_at) < NOW() - INTERVAL '90 days'`
    );
  }
  return { label: 'Stale demotion', status: 'fixed', detail: parts.join(', ') };
}

// ─── Step 8: Regenerate null embeddings ───

async function regenerateEmbeddings(db, opts = {}) {
  const { dryRun = false, skipEmbeddings = false } = opts;

  if (skipEmbeddings) {
    return { label: 'Null embeddings', status: 'ok', detail: 'skipped (--skip-embeddings)' };
  }

  const res = await db.query(
    `SELECT id, type, content, context FROM brainx_memories
     WHERE embedding IS NULL AND superseded_by IS NULL
     ORDER BY created_at DESC LIMIT 20`
  );

  if (res.rows.length === 0) return { label: 'Null embeddings', status: 'ok', detail: 'all have embeddings' };
  if (dryRun) {
    return { label: 'Null embeddings', status: 'fixed', detail: `would regenerate ${res.rows.length}`,
      verbose: res.rows.map(r => `would embed: ${r.id}`) };
  }

  let embed;
  try { embed = require('./openai-rag').embed; }
  catch (err) { return { label: 'Null embeddings', status: 'fail', detail: `cannot load embed: ${err.message}` }; }

  let success = 0, failures = 0;
  const errors = [];
  for (const row of res.rows) {
    try {
      const text = `${row.type}: ${row.content} [context: ${row.context || ''}]`;
      const embedding = await embed(text);
      await db.query(`UPDATE brainx_memories SET embedding = $1::vector WHERE id = $2`,
        [JSON.stringify(embedding), row.id]);
      success++;
    } catch (err) {
      failures++;
      errors.push(`failed ${row.id}: ${err.message}`);
    }
  }

  const total = res.rows.length;
  if (failures === 0) return { label: 'Null embeddings', status: 'fixed', detail: `regenerated ${success}/${total}` };
  return { label: 'Null embeddings', status: 'warn', detail: `${success}/${total} (${failures} failed)`, verbose: errors };
}

// ─── Step 9: Auto-dedup high-similarity pairs ───

async function autoDedup(db, opts = {}) {
  const { dryRun = false } = opts;

  try {
    const countRes = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM brainx_memories
       WHERE embedding IS NOT NULL AND superseded_by IS NULL`
    );
    if ((countRes.rows[0]?.cnt || 0) < 2) {
      return { label: 'Auto-dedup', status: 'ok', detail: 'not enough memories' };
    }

    const res = await db.query(
      `WITH recent AS (
         SELECT id, type, agent, context, source_kind, embedding, created_at
         FROM brainx_memories
         WHERE embedding IS NOT NULL AND superseded_by IS NULL
         ORDER BY created_at DESC LIMIT 200
       )
       SELECT a.id AS old_id, b.id AS new_id,
              1 - (a.embedding <=> b.embedding) AS similarity
       FROM recent a, recent b
       WHERE a.id < b.id
         AND a.created_at < b.created_at
         AND a.type = b.type
         AND COALESCE(a.agent, '') = COALESCE(b.agent, '')
         AND COALESCE(a.context, '') <> ''
         AND COALESCE(a.context, '') = COALESCE(b.context, '')
         AND COALESCE(a.source_kind, '') = COALESCE(b.source_kind, '')
         AND 1 - (a.embedding <=> b.embedding) > 0.95
       ORDER BY similarity DESC LIMIT 50`
    );

    const count = res.rows.length;
    if (count === 0) return { label: 'Auto-dedup', status: 'ok', detail: 'no duplicates found' };

    if (dryRun) {
      return {
        label: 'Auto-dedup', status: 'fixed',
        detail: `would dedup ${count} pairs`,
        verbose: res.rows.slice(0, 10).map(r => `${r.old_id} → ${r.new_id} (${Number(r.similarity).toFixed(4)})`)
      };
    }

    for (const row of res.rows) {
      await db.query(
        `UPDATE brainx_memories SET superseded_by = $1 WHERE id = $2 AND superseded_by IS NULL`,
        [row.new_id, row.old_id]
      );
    }
    return { label: 'Auto-dedup', status: 'fixed', detail: `deduped ${count} pairs` };
  } catch (err) {
    return { label: 'Auto-dedup', status: 'fail', detail: err.message };
  }
}

// ─── Step 10: Cron re-registration check ───

async function checkCronRegistration(db, opts = {}) {
  const cronJobsPath = path.join(process.env.HOME || '', '.openclaw', 'cron', 'jobs.json');
  try {
    const raw = fs.readFileSync(cronJobsPath, 'utf8');
    const data = JSON.parse(raw);
    const jobs = data.jobs || [];
    const normalize = (job) => ((job.name || '') + ' ' + ((job.payload && job.payload.message) || '')).toLowerCase();

    const reviewLoop = jobs.find((job) => String(job?.name || '').trim().toLowerCase() === 'brainx review loop');
    const maintenance = jobs.find((job) => String(job?.name || '').trim().toLowerCase() === 'brainx maintenance');
    if (reviewLoop || maintenance) {
      const detail = 'orchestrated pipeline detected: review_loop=' +
        (reviewLoop?.enabled ? 'on' : reviewLoop ? 'off' : 'missing') +
        ', maintenance=' +
        (maintenance?.enabled ? 'on' : maintenance ? 'off' : 'missing');
      return {
        label: 'Cron registration',
        status: reviewLoop?.enabled && maintenance?.enabled ? 'ok' : 'fail',
        detail
      };
    }

    const consolidated = jobs.find((job) => {
      const combined = normalize(job);
      return combined.includes('brainx daily core pipeline v5') ||
             (combined.includes('brainx') && combined.includes('daily core pipeline'));
    });

    if (consolidated) {
      const detail = consolidated.enabled
        ? 'consolidated pipeline detected: BrainX Daily Core Pipeline V5 enabled'
        : 'consolidated pipeline detected but disabled: BrainX Daily Core Pipeline V5';
      return {
        label: 'Cron registration',
        status: consolidated.enabled ? 'ok' : 'fail',
        detail
      };
    }

    const keywords = [
      { name: 'Memory Distiller', patterns: ['distiller'] },
      { name: 'Memory Bridge', patterns: ['memory bridge'] },
      { name: 'Lifecycle Daily', patterns: ['lifecycle'] },
      { name: 'Session Harvester', patterns: ['harvester'] },
      { name: 'Cross-Agent Learning', patterns: ['cross-agent'] },
      { name: 'Contradiction Detector', patterns: ['contradiction'] }
    ];

    let found = 0;
    let enabled = 0;
    const missing = [];

    for (const expected of keywords) {
      const match = jobs.find(j => {
        const combined = normalize(j);
        return expected.patterns.some(p => combined.includes(p));
      });
      if (match) {
        found++;
        if (match.enabled) enabled++;
      } else {
        missing.push(expected.name);
      }
    }

    const detail = `${found}/6 legacy component jobs registered, ${enabled} enabled` +
      (missing.length > 0 ? ` (missing: ${missing.join(', ')})` : '');

    if (found >= 5 && enabled >= 5) {
      return { label: 'Cron registration', status: 'ok', detail };
    }
    if (missing.length >= 3) {
      return { label: 'Cron registration', status: 'fail', detail };
    }
    return { label: 'Cron registration', status: 'warn', detail };
  } catch (err) {
    return { label: 'Cron registration', status: 'warn', detail: 'cannot read cron config' };
  }
}

async function reconcilePromotionGovernance(db, opts = {}) {
  const { dryRun = false } = opts;
  const canonical = readCanonicalRules();
  if (!canonical.exists) {
    return {
      label: 'Promotion governance',
      status: 'fail',
      detail: `canonical sink missing: ${canonical.filePath}`
    };
  }

  const pendingRes = await db.query(
    `SELECT id, content, verification_state, superseded_by
     FROM brainx_memories
     WHERE 'promotion-suggestion' = ANY(COALESCE(tags, '{}'))
       AND COALESCE(status, 'pending') NOT IN ('promoted', 'applied', 'rejected', 'wont_fix')
     ORDER BY created_at DESC`
  );
  const promotedRes = await db.query(
    `SELECT id, content
     FROM brainx_memories
     WHERE 'promotion-suggestion' = ANY(COALESCE(tags, '{}'))
       AND COALESCE(status, 'pending') IN ('promoted', 'applied')
       AND COALESCE(promoted_to, '') = ''`
  );
  const promotedRulesRes = await db.query(
    `SELECT content
     FROM brainx_memories
     WHERE 'promotion-suggestion' = ANY(COALESCE(tags, '{}'))
       AND COALESCE(status, '') IN ('promoted', 'applied')
       AND COALESCE(promoted_to, '') <> ''`
  );
  const promotedRules = new Set(promotedRulesRes.rows.map((row) => normalizeRule(extractSuggestionMetadata(row.content).rule)));

  const rejectPendingIds = [];
  const backfillPromoted = [];
  const demotePromotedIds = [];
  const verbose = [];

  for (const row of pendingRes.rows) {
    const meta = extractSuggestionMetadata(row.content);
    const duplicateOfCanonical = Boolean(findCanonicalRuleMatch(meta.rule, canonical, meta.targetKey));
    const duplicateOfPromoted = promotedRules.has(normalizeRule(meta.rule));
    const staleDuplicate = row.verification_state === 'obsolete' || row.superseded_by;
    if (duplicateOfCanonical || duplicateOfPromoted || staleDuplicate || isLowSignalPromotionRule(meta.rule)) {
      rejectPendingIds.push(row.id);
      if (verbose.length < 25) {
        verbose.push(`reject_pending=${row.id}:${duplicateOfCanonical ? 'canonical' : duplicateOfPromoted ? 'promoted' : staleDuplicate ? 'stale' : 'low_signal'}`);
      }
    }
  }

  for (const row of promotedRes.rows) {
    const meta = extractSuggestionMetadata(row.content);
    const match = findCanonicalRuleMatch(meta.rule, canonical, meta.targetKey);
    if (match) {
      backfillPromoted.push({ id: row.id, promotedTo: targetKeyToPromotedTo(match.targetKey) });
      if (verbose.length < 25) verbose.push(`backfill_promoted=${row.id}:${match.targetKey}`);
    } else {
      demotePromotedIds.push(row.id);
      if (verbose.length < 25) verbose.push(`demote_false_promoted=${row.id}`);
    }
  }

  if (!rejectPendingIds.length && !backfillPromoted.length && !demotePromotedIds.length) {
    return { label: 'Promotion governance', status: 'ok', detail: 'promotion suggestion sink is consistent' };
  }

  if (dryRun) {
    return {
      label: 'Promotion governance',
      status: 'fixed',
      detail: `would reject ${rejectPendingIds.length} pending, backfill ${backfillPromoted.length} promoted, demote ${demotePromotedIds.length} false promoted`,
      verbose
    };
  }

  if (rejectPendingIds.length > 0) {
    await db.query(
      `UPDATE brainx_memories
       SET status = 'wont_fix',
           verification_state = 'obsolete',
           feedback_score = LEAST(COALESCE(feedback_score, 0), -2),
           resolved_at = COALESCE(resolved_at, NOW()),
           resolution_notes = CONCAT(COALESCE(resolution_notes, ''), CASE WHEN COALESCE(resolution_notes, '') = '' THEN '' ELSE E'\n' END, 'promotion governance cleanup: low-signal, duplicate, or stale suggestion')
       WHERE id = ANY($1::text[])`,
      [rejectPendingIds]
    );
  }

  for (const entry of backfillPromoted) {
    await db.query(
      `UPDATE brainx_memories
       SET promoted_to = $2,
           resolved_at = COALESCE(resolved_at, NOW()),
           resolution_notes = CONCAT(COALESCE(resolution_notes, ''), CASE WHEN COALESCE(resolution_notes, '') = '' THEN '' ELSE E'\n' END, 'promotion governance reconciliation: backfilled canonical sink target')
       WHERE id = $1`,
      [entry.id, entry.promotedTo]
    );
  }

  if (demotePromotedIds.length > 0) {
    await db.query(
      `UPDATE brainx_memories
       SET status = 'wont_fix',
           verification_state = 'obsolete',
           feedback_score = LEAST(COALESCE(feedback_score, 0), -2),
           resolved_at = COALESCE(resolved_at, NOW()),
           resolution_notes = CONCAT(COALESCE(resolution_notes, ''), CASE WHEN COALESCE(resolution_notes, '') = '' THEN '' ELSE E'\n' END, 'promotion governance reconciliation: status promoted without canonical sink target')
       WHERE id = ANY($1::text[])`,
      [demotePromotedIds]
    );
  }

  return {
    label: 'Promotion governance',
    status: 'fixed',
    detail: `rejected ${rejectPendingIds.length} pending, backfilled ${backfillPromoted.length} promoted, demoted ${demotePromotedIds.length} false promoted`,
    verbose
  };
}

// ─── Runtime telemetry hygiene ───

async function closeRuntimeScoringBacklog(db, opts = {}) {
  const { dryRun = false } = opts;
  const staleHours = Math.max(1, Number(opts.runtimeScoringStaleHours || process.env.BRAINX_RUNTIME_SCORING_STALE_HOURS || 6) || 6);

  let rows;
  try {
    const res = await db.query(
      [
        'SELECT surface,',
        '       COUNT(*)::int AS total,',
        '       COUNT(*) FILTER (WHERE COALESCE(selected_count, 0) > 0)::int AS selected,',
        '       MIN(injected_at) AS oldest,',
        '       MAX(injected_at) AS newest',
        '  FROM brainx_runtime_injections',
        ' WHERE scored_at IS NULL',
        '   AND injected_at < NOW() - ($1::int || \' hours\')::interval',
        ' GROUP BY surface',
        ' ORDER BY total DESC, surface ASC',
      ].join('\n'),
      [staleHours],
    );
    rows = res.rows || [];
  } catch (err) {
    return { label: 'Runtime scoring backlog', status: 'fail', detail: err.message };
  }

  const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
  const selected = rows.reduce((sum, row) => sum + Number(row.selected || 0), 0);
  if (total === 0) {
    return { label: 'Runtime scoring backlog', status: 'ok', detail: 'no stale unscored rows >' + staleHours + 'h' };
  }

  const verbose = rows.map((row) =>
    (row.surface || 'unknown') + ' total=' + row.total + ' selected=' + row.selected + ' oldest=' + row.oldest + ' newest=' + row.newest
  );

  if (dryRun) {
    return {
      label: 'Runtime scoring backlog',
      status: 'fixed',
      detail: 'would close ' + total + ' stale scores (' + selected + ' selected) >' + staleHours + 'h',
      verbose,
    };
  }

  try {
    const res = await db.query(
      [
        'WITH stale AS (',
        '  SELECT id',
        '    FROM brainx_runtime_injections',
        '   WHERE scored_at IS NULL',
        '     AND injected_at < NOW() - ($1::int || \' hours\')::interval',
        '),',
        'updated AS (',
        '  UPDATE brainx_runtime_injections ri',
        '     SET referenced_count = 0,',
        '         referenced_ids = \'{}\'::text[],',
        '         soft_referenced_count = 0,',
        '         soft_referenced_ids = \'{}\'::text[],',
        '         response_sha = LEFT(md5(\'brainx-runtime-maintenance-expired-no-response:\' || ri.id::text), 16),',
        '         scored_at = NOW(),',
        '         decision_summary = COALESCE(ri.decision_summary, \'{}\'::jsonb) ||',
        '           jsonb_build_object(',
        '             \'scoring_fallback\',',
        '             jsonb_build_object(',
        '               \'reason\', \'maintenance_expired_no_response\',',
        '               \'stale_hours\', $1::int,',
        '               \'closed_at\', NOW()',
        '             )',
        '           )',
        '    FROM stale',
        '   WHERE ri.id = stale.id',
        '   RETURNING ri.id',
        ')',
        'SELECT COUNT(*)::int AS closed FROM updated',
      ].join('\n'),
      [staleHours],
    );
    const closed = Number(res.rows?.[0]?.closed || 0);
    return {
      label: 'Runtime scoring backlog',
      status: 'fixed',
      detail: 'closed ' + closed + ' stale scores (' + selected + ' selected) >' + staleHours + 'h',
      verbose,
    };
  } catch (err) {
    return { label: 'Runtime scoring backlog', status: 'fail', detail: err.message };
  }
}

const FIX_STEP_REGISTRY = [
  { id: 'migrations', label: 'Migrations', run: applyMigrations },
  { id: 'expired-cleanup', label: 'Expired cleanup', run: cleanExpired },
  { id: 'orphaned-refs', label: 'Orphaned refs', run: fixOrphans },
  { id: 'legacy-provenance', label: 'Legacy provenance', run: backfillProvenance },
  { id: 'sensitivity-calibration', label: 'Sensitivity calibration', run: recalibrateSensitivity },
  { id: 'durable-confidence', label: 'Durable confidence', run: curateDurableConfidence },
  { id: 'stale-demotion', label: 'Stale demotion', run: demoteStaleTiers },
  { id: 'null-embeddings', label: 'Null embeddings', run: regenerateEmbeddings },
  { id: 'auto-dedup', label: 'Auto-dedup', run: autoDedup },
  { id: 'promotion-governance', label: 'Promotion governance', run: reconcilePromotionGovernance },
  { id: 'runtime-scoring-backlog', label: 'Runtime scoring backlog', run: closeRuntimeScoringBacklog },
  { id: 'cron-registration', label: 'Cron registration', run: checkCronRegistration },
];

function resolveFixSteps(onlySteps) {
  if (!onlySteps || onlySteps.length === 0) {
    return { steps: FIX_STEP_REGISTRY, unknown: [] };
  }

  const selected = [];
  const unknown = [];
  for (const id of onlySteps) {
    const step = FIX_STEP_REGISTRY.find((entry) => entry.id === id);
    if (!step) {
      unknown.push(id);
      continue;
    }
    if (!selected.some((entry) => entry.id === step.id)) {
      selected.push(step);
    }
  }
  return { steps: selected, unknown };
}

// ─── Run all fixes ───

async function runAllFixes(db, opts = {}) {
  const { steps, unknown } = resolveFixSteps(opts.onlySteps);
  if (unknown.length > 0) {
    return [{
      label: 'Fix selection',
      status: 'fail',
      detail: `unknown steps: ${unknown.join(', ')}`,
      verbose: [`available: ${FIX_STEP_REGISTRY.map((entry) => entry.id).join(', ')}`]
    }];
  }

  const results = [];
  for (const step of steps) {
    results.push(await step.run(db, opts));
  }
  return results;
}

// ─── Unicode box formatting (clack style) ───

const SYM_STATUS = { ok: '✓', fixed: '✓', warn: '⚠', fail: '✗' };

function formatFixReport(results, verbose = false, dryRun = false) {
  const W = 58; // minimum inner content width
  const total = results.length;

  // Pre-compute all lines to find actual max width
  const maxLabel = 22;
  const computedLines = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const step = `[${i + 1}/${total}]`;
    const sym = SYM_STATUS[r.status] || ' ';
    const pad = Math.max(1, maxLabel - r.label.length);
    const dots = ' ' + '.'.repeat(pad) + ' ';
    const line = `  ${sym} ${step} ${r.label}${dots}${r.detail}`;
    const verboseLines = (verbose && r.verbose) ? r.verbose.map(v => `            ${v}`) : [];
    computedLines.push({ line, verboseLines });
  }

  const allLines = computedLines.flatMap(cl => [cl.line, ...cl.verboseLines]);
  const maxLine = Math.max(W, ...allLines.map(l => l.length + 2));

  const out = [];
  const heading = dryRun ? '┌  BrainX Fix (dry-run)' : '┌  BrainX Fix';
  out.push('');
  out.push(heading);
  out.push('│');

  const titleBar = `◇  Repairs ` + '─'.repeat(Math.max(1, maxLine - 11)) + '╮';
  out.push(titleBar);
  out.push(`│${' '.repeat(maxLine + 1)}│`);

  for (const cl of computedLines) {
    const pad = maxLine - cl.line.length;
    out.push(`│${cl.line}${' '.repeat(Math.max(1, pad + 1))}│`);
    for (const vl of cl.verboseLines) {
      const vpad = maxLine - vl.length;
      out.push(`│${vl}${' '.repeat(Math.max(1, vpad + 1))}│`);
    }
  }

  out.push(`│${' '.repeat(maxLine + 1)}│`);
  out.push(`├${'─'.repeat(maxLine + 1)}╯`);
  out.push('│');

  const hasFailure = results.some(r => r.status === 'fail');
  if (hasFailure) {
    out.push('└  Some repairs failed. Check errors above.');
  } else {
    out.push('└  All repairs complete. Run `brainx doctor` to verify.');
  }

  return out.join('\n');
}

function formatFixReportJson(results) {
  return JSON.stringify({
    ok: !results.some(r => r.status === 'fail'),
    steps: results.map(r => ({
      label: r.label,
      status: r.status,
      detail: r.detail,
      verbose: r.verbose || null
    }))
  }, null, 2);
}

// ─── Main entry point ───

async function cmdFix(args, deps = {}) {
  let db;
  try {
    db = deps.db || require('./db');
  } catch (err) {
    console.log('');
    console.log('┌  BrainX Fix');
    console.log('│');
    console.log('└  ✗ Database connection failed: ' + err.message);
    return;
  }

  const opts = {
    dryRun: args['dry-run'] || args.dryRun || false,
    verbose: args.verbose || false,
    skipEmbeddings: args['skip-embeddings'] || args.skipEmbeddings || false,
    onlySteps: parseOnlySteps(args.only)
  };

  const results = await runAllFixes(db, opts);

  if (args.json) {
    console.log(formatFixReportJson(results));
  } else {
    console.log(formatFixReport(results, opts.verbose, opts.dryRun));
  }
}

module.exports = {
  runAllFixes,
  formatFixReport,
  formatFixReportJson,
  cmdFix,
  parseOnlySteps,
  resolveFixSteps
};
