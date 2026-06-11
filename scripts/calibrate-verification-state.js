#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true, quiet: true });

const db = require('../lib/db');

function parseArgs(argv) {
  return {
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    limit: parseInt((argv.find((arg) => arg.startsWith('--limit=')) || '').split('=')[1] || '500', 10) || 500,
    minImportance: parseInt((argv.find((arg) => arg.startsWith('--min-importance=')) || '').split('=')[1] || '9', 10) || 9,
  };
}

const REJECT_PATTERNS = [
  /\bactualmente\b|\bahora\b|\bhoy\b|\bcurrently\b|\btoday\b/i,
  /\bpost id\b|\bart[íi]culo\b|\barticle\b|\bdraft\b|\bpublished\b|\bpublicado\b|\bfaq\b|\bwords\b|\bscore\b/i,
  /\breporte?\b|\breport\b|\bhealth\b|\bdegradad[oa]\b/i,
  /\bel usuario aprob[óo]\b|\bse acord[óo] proceder\b|\bse decidi[óo] proceder\b/i,
  /\bse decidi[óo] pausar\b|\bpausar el\b|\bseguir enviando\b|\breescribirlo\b/i,
  /\bbackfill\b|\bdeploy(?:ed)?\b|\bcompletad[oa]\b|\bfixed\b|\bfix aplicado\b/i,
  /\bse movi[óo]\b|\bse cre[óo]\b|\bse agreg[óo]\b|\bse elimin[óo]\b/i,
  /\brama\b|\bbranch\b|\bnew-closer\b/i,
  /\best[aá] corriendo con\b|\bsesiones activas\b|\balrededor de \d+\b|\boperativ[oa]s?\b/i,
  /\b202\d\b/,
];

const DURABLE_PATTERNS = [
  /\bno (?:intentar|compartir|modificar|usar)\b/i,
  /\bnunca\b|\bsiempre\b|\bevitar\b/i,
  /\bendpoint\b|\btoken\b|\bapi\b|\bnginx\b|\bgateway\b|\bopenclaw\.json\b|\b\.env\b/i,
  /\bredirect url\b|\boauth\b|\bslack\b|\bfigma\b|\brailway\b|\bvs code\b/i,
  /\bpuerto\b|\bport\b|\breverse proxy\b|\bbearer\b/i,
  /\bsecretos? hardcodead\b|\bsecrets? hardcoded\b/i,
  /\bxss\b|\bvulnerabil/i,
  /\bno est[aá] soportad/i,
  /\bconectarse directamente\b|\bmover los secretos\b/i,
];

function normalizeSpace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function isDurableCandidate(row) {
  const content = normalizeSpace(row.content);
  if (!content || content.length < 40 || content.length > 700) {
    return { keep: false, reason: 'length' };
  }

  if (REJECT_PATTERNS.some((pattern) => pattern.test(content))) {
    return { keep: false, reason: 'ephemeral_pattern' };
  }

  const sourceKind = String(row.source_kind || '');
  const durableBySource = ['consolidated', 'tool_verified', 'regex_extraction'].includes(sourceKind);
  const durableByContent = DURABLE_PATTERNS.some((pattern) => pattern.test(content));

  if (!durableBySource && !durableByContent) {
    return { keep: false, reason: 'weak_source_or_content' };
  }

  if (Number(row.importance || 0) < 9) {
    return { keep: false, reason: 'importance' };
  }

  if (Number(row.feedback_score || 0) < 0) {
    return { keep: false, reason: 'negative_feedback' };
  }

  return { keep: true, reason: durableBySource ? 'strong_source' : 'durable_content' };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { rows } = await db.query(
    `SELECT id, type, source_kind, importance, feedback_score, verification_state, content
     FROM brainx_memories
     WHERE superseded_by IS NULL
       AND verification_state = 'changelog'
       AND type IN ('fact', 'decision', 'gotcha')
       AND importance >= $1
     ORDER BY importance DESC, last_seen DESC NULLS LAST
     LIMIT $2`,
    [args.minImportance, args.limit]
  );

  const approved = [];
  const rejected = [];
  const reasonCounts = {};

  for (const row of rows) {
    const verdict = isDurableCandidate(row);
    reasonCounts[verdict.reason] = (reasonCounts[verdict.reason] || 0) + 1;
    if (verdict.keep) {
      approved.push({ ...row, calibration_reason: verdict.reason });
    } else {
      rejected.push({ ...row, calibration_reason: verdict.reason });
    }
  }

  if (args.apply && approved.length > 0) {
    const ids = approved.map((row) => row.id);
    await db.query(
      `UPDATE brainx_memories
       SET verification_state = 'verified',
           tags = CASE
             WHEN NOT (COALESCE(tags, '{}') @> ARRAY['calibrated_verified']) THEN COALESCE(tags, '{}') || ARRAY['calibrated_verified']
             ELSE tags
           END,
           resolution_notes = CONCAT(COALESCE(resolution_notes, ''), CASE WHEN COALESCE(resolution_notes, '') = '' THEN '' ELSE E'\n' END, 'verification calibrated to verified')
       WHERE id = ANY($1::text[])`,
      [ids]
    );
  }

  const result = {
    ok: true,
    apply: args.apply,
    scanned: rows.length,
    promoted: approved.length,
    skipped: rejected.length,
    reasonCounts,
    samplePromoted: approved.slice(0, 12).map(({ id, type, source_kind, importance, calibration_reason, content }) => ({
      id,
      type,
      source_kind,
      importance,
      calibration_reason,
      content: content.slice(0, 180),
    })),
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`scanned=${result.scanned} promoted=${result.promoted} skipped=${result.skipped}`);
    for (const [reason, count] of Object.entries(reasonCounts)) {
      console.log(`- ${reason}: ${count}`);
    }
    if (approved.length > 0) {
      console.log('\nsample promoted:');
      for (const row of result.samplePromoted) {
        console.log(`- ${row.id} [${row.type}/${row.source_kind}] ${row.content}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
