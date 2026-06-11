#!/usr/bin/env node
/*
 * ACP rotation tuning audit (READ-ONLY).
 *
 * Closes the loop on the context-budget rotation guard: measures rotation
 * frequency per Claude ACP agent and how hot each session runs, then flags
 * churn (rotating too often) or risk (riding near the real window without
 * rotating) and recommends a threshold adjustment. It NEVER mutates anything.
 *
 * Output: JSON (default) or --human. Schedule: daily-core step.
 * Marker: OPENCLAW_ACP_ROTATION_TUNING_AUDIT_20260531
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const db = require("/home/clawd/.openclaw/skills/brainx/lib/db.js");

const HOME = "/home/clawd";
const AGENTS = ["clawma","raider","claude-cli","echo","sonnet","raider-private","blade","xefora","artemis"];
// Mirror the live runtime guard exactly (manager-Cs6wHMF2.js:676): env override
// OPENCLAW_CLAUDE_ACP_CONTEXT_GUARD_RATIO if valid (0<r<1), else default 0.30.
// Was hardcoded 0.65 (stale) until 2026-06-02 — produced false thresholds (650K)
// and bogus "raise ratio" flags after the runtime was lowered to 0.30 on 2026-05-31.
const RATIO = (() => { const _r = parseFloat(process.env.OPENCLAW_CLAUDE_ACP_CONTEXT_GUARD_RATIO); return Number.isFinite(_r) && _r > 0 && _r < 1 ? _r : 0.30; })();
const CHURN_PER_DAY = 12;      // > this/day = churn signal
const RISK_FRAC = 0.92;        // maxTok > this * window with no recent rotation = riding hot
const human = process.argv.includes("--human");

function sessionStats(agent) {
  const f = path.join(HOME, ".openclaw", "agents", agent, "sessions", "sessions.json");
  let maxTok = 0, window = 0, compactions = 0;
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const v of Object.values(j)) {
      if (v && typeof v === "object") {
        const t = Number(v.totalTokens || (v.usage && v.usage.totalTokens) || 0);
        if (t > maxTok) maxTok = t;
        if (Number(v.contextTokens) > window) window = Number(v.contextTokens);
        compactions += Number(v.compactionCount || 0);
      }
    }
  } catch {}
  return { maxTok, window, compactions };
}

async function main() {
  let perAgentRot = {};
  try {
    const r = await db.query(
      "SELECT agent, count(*) FILTER (WHERE detected_at > NOW() - INTERVAL '24 hours') d1, " +
      "count(*) FILTER (WHERE detected_at > NOW() - INTERVAL '7 days') d7 " +
      "FROM brainx_session_rotation_events WHERE trigger_reason = 'runtime-context-budget-rotation' GROUP BY agent"
    );
    for (const row of r.rows) perAgentRot[row.agent] = { d1: Number(row.d1), d7: Number(row.d7) };
  } catch (e) { perAgentRot.__error = e.message; }

  const findings = [];
  for (const a of AGENTS) {
    const s = sessionStats(a);
    const rot = perAgentRot[a] || { d1: 0, d7: 0 };
    const threshold = s.window ? Math.floor(s.window * RATIO) : null;
    const flags = [];
    if (rot.d1 > CHURN_PER_DAY) flags.push(`churn: ${rot.d1} rotations/24h (>${CHURN_PER_DAY}) — consider raising RATIO above ${RATIO}`);
    if (s.window && s.maxTok > s.window * RISK_FRAC && rot.d1 === 0)
      flags.push(`risk: maxTok ${s.maxTok} > ${Math.round(RISK_FRAC*100)}% of window ${s.window} with 0 rotations/24h — boundary may be too rare; check long turns`);
    if (s.compactions > 0) flags.push(`native CLI compaction fired (compactionCount=${s.compactions}) — guard threshold too high or boundary too rare`);
    findings.push({ agent: a, window: s.window, threshold, maxTok: s.maxTok, rot24h: rot.d1, rot7d: rot.d7, compactions: s.compactions, flags });
  }

  const flagged = findings.filter(f => f.flags.length);
  const out = {
    ok: true,
    marker: "OPENCLAW_ACP_ROTATION_TUNING_AUDIT_20260531",
    ratio: RATIO,
    generatedAt: new Date().toISOString(),
    healthy: flagged.length === 0,
    flaggedCount: flagged.length,
    findings,
  };

  if (human) {
    console.log(`ACP rotation tuning audit — ratio=${RATIO} — ${flagged.length} flagged`);
    for (const f of findings) {
      const base = `  ${f.agent.padEnd(16)} win=${f.window||"?"} thr=${f.threshold||"?"} maxTok=${f.maxTok} rot24h=${f.rot24h} rot7d=${f.rot7d}`;
      console.log(base + (f.flags.length ? "\n     ⚠ " + f.flags.join("\n     ⚠ ") : ""));
    }
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
}

main()
  .catch((e) => { console.error(JSON.stringify({ ok: false, error: e?.message || String(e) })); process.exit(1); })
  .finally(async () => { try { await db.close?.(); await db.pool?.end?.(); } catch {} });
