/**
 * BrainX Auto-Inject Hook Handler
 *
 * Runs on agent:bootstrap — queries PostgreSQL for hot/warm memories
 * and injects them into the agent's MEMORY.md + BRAINX_CONTEXT.md.
 */

import { createRequire } from "module";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

const BRAINX_DIR = "/home/clawd/.openclaw/skills/brainx";
const brainxRequire = createRequire(path.join(BRAINX_DIR, "index.js"));

// ─── Agent profiles for context-aware injection ────────────────

import { readFileSync } from "node:fs";

let agentProfiles = {};
const AGENT_PROFILES_PATH = path.join(BRAINX_DIR, "hook", "agent-profiles.json");

function refreshAgentProfiles() {
  try {
    const raw = readFileSync(AGENT_PROFILES_PATH, "utf-8");
    agentProfiles = JSON.parse(raw);
  } catch {
    // No profiles file — all agents get default (unfiltered) injection
    agentProfiles = {};
  }
}

const DEFAULT_SAFE_PROFILE = {
  contexts: [],
  excludeTypes: ["learning", "note"],
  boostTypes: ["fact", "decision", "gotcha"],
  scoringWeights: {
    recency: 0.2,
    relevance: 0.5,
    importance: 0.3,
  },
  allowCrossAgent: false,
  crossAgentTagRequired: true,
  crossAgentRatio: 0,
};

// Section markers for MEMORY.md — content between these is replaced each run
const BRAINX_START = "<!-- BRAINX:START -->";
const BRAINX_END = "<!-- BRAINX:END -->";

// ─── Env loading ───────────────────────────────────────────────

function loadEnv() {
  try {
    const dotenv = brainxRequire("dotenv");
    dotenv.config({ path: path.join(BRAINX_DIR, ".env"), quiet: true });
  } catch {}
}

// ─── Singleton pool ────────────────────────────────────────────

let _pool = null;
let _poolUrl = null;

function getPool(dbUrl) {
  if (_pool && _poolUrl === dbUrl) return _pool;
  if (_pool) { _pool.end().catch(() => {}); }
  try {
    const { Pool } = brainxRequire("pg");
    _pool = new Pool({ connectionString: dbUrl, max: 3, idleTimeoutMillis: 30000 });
    _poolUrl = dbUrl;
    _pool.on("error", (err) => {
      console.error("[brainx-inject] Pool background error:", err.message);
      _pool = null;
      _poolUrl = null;
    });
    return _pool;
  } catch (err) {
    console.error("[brainx-inject] Failed to create pool:", err.message);
    _pool = null;
    _poolUrl = null;
    throw err;
  }
}

// ─── Helpers ───────────────────────────────────────────────────

function extractAgentId(sessionKey) {
  if (!sessionKey) return "unknown";
  const parts = sessionKey.split(":");
  return parts.length >= 2 ? parts[1] : "unknown";
}

function ts() {
  // Keep the timestamp stable within the same day to reduce prompt-cache churn.
  return new Date().toISOString().slice(0, 10);
}

function truncate(str, max = 150) {
  if (!str || str.length <= max) return str || "";
  return str.slice(0, max - 3) + "...";
}

async function writeIfChanged(filePath, newContent) {
  try {
    const existing = await fs.readFile(filePath, "utf-8");
    if (existing === newContent) return false;
  } catch {
    // File does not exist yet.
  }
  await fs.writeFile(filePath, newContent, "utf-8");
  return true;
}

function getUtcDateOffset(days = 0) {
  const date = new Date(Date.now() + (days * 24 * 60 * 60 * 1000));
  return date.toISOString().slice(0, 10);
}

function renderDailyMemoryStub(date) {
  return `# ${date}\n\n## Index\n| # | Type | Summary |\n|---|------|---------|\n`;
}

async function ensureDailyMemoryFiles(workspaceDir) {
  const memoryDir = path.join(workspaceDir, "memory");
  await fs.mkdir(memoryDir, { recursive: true });

  for (const date of [getUtcDateOffset(0), getUtcDateOffset(-1)]) {
    const filePath = path.join(memoryDir, `${date}.md`);
    try {
      await fs.writeFile(filePath, renderDailyMemoryStub(date), {
        encoding: "utf-8",
        flag: "wx"
      });
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }
  }
}

// ─── Retry helpers ─────────────────────────────────────────────

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 5000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function calculateDelay(attempt) {
  const exponential = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * 500;
  return Math.min(exponential + jitter, MAX_DELAY_MS);
}

async function withRetry(operation, context = "operation") {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const isRetryable = err.code === 'ECONNREFUSED' || 
                          err.code === 'ETIMEDOUT' ||
                          err.code === 'ECONNRESET' ||
                          err.message?.includes('connection') ||
                          err.message?.includes('timeout');
      
      if (!isRetryable || attempt >= MAX_RETRIES - 1) {
        throw err;
      }
      
      const delay = calculateDelay(attempt);
      console.log(`[brainx-inject] ${context} failed (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${Math.round(delay)}ms...`);
      await sleep(delay);
    }
  }
  throw lastError;
}

// ─── DB queries (with retry wrapper) ───────────────────────────

async function queryTopMemories(pool, { limit = 8, minImportance = 5, agentName = null }) {
  // Legacy helper kept for compatibility. The active bootstrap path is now
  // local-first and leaves cross-agent retrieval for explicit fallback recall.
  const crossSlots = Math.max(2, Math.floor(limit * 0.3));  // ~30% for other agents
  const ownSlots = limit - crossSlots;

  return withRetry(async () => {
    // 1. Own agent memories (or global if no agent)
    const ownFilter = agentName
      ? `AND (agent = $3 OR agent IS NULL)`
      : '';
    const ownParams = agentName
      ? [minImportance, ownSlots, agentName]
      : [minImportance, ownSlots];
    const { rows: ownRows } = await pool.query(
      `SELECT content, tier, importance, type, agent, context
       FROM brainx_memories
       WHERE tier IN ('hot', 'warm')
         AND importance >= $1
         AND superseded_by IS NULL
         AND COALESCE(status, 'pending') NOT IN ('resolved', 'wont_fix')
         AND (expires_at IS NULL OR expires_at > NOW())
         AND COALESCE(verification_state, 'hypothesis') != 'obsolete'
         ${ownFilter}
       ORDER BY importance DESC, last_seen DESC NULLS LAST, created_at DESC
       LIMIT $2`,
      ownParams
    );

    // 2. Cross-agent memories (from OTHER agents, prioritizing cross-agent tagged)
    const crossFilter = agentName
      ? `AND agent IS DISTINCT FROM $3 AND agent IS NOT NULL`
      : '';
    const crossParams = agentName
      ? [minImportance, crossSlots, agentName]
      : [minImportance, crossSlots];
    const { rows: crossRows } = await pool.query(
      `SELECT content, tier, importance, type, agent, context
       FROM brainx_memories
       WHERE tier IN ('hot', 'warm')
         AND importance >= $1
         AND superseded_by IS NULL
         AND COALESCE(status, 'pending') NOT IN ('resolved', 'wont_fix')
         AND (expires_at IS NULL OR expires_at > NOW())
         AND COALESCE(verification_state, 'hypothesis') != 'obsolete'
         ${crossFilter}
       ORDER BY
         CASE WHEN 'cross-agent' = ANY(tags) THEN 1 ELSE 0 END DESC,
         importance DESC, last_seen DESC NULLS LAST, created_at DESC
       LIMIT $2`,
      crossParams
    );

    return [...ownRows, ...crossRows];
  }, "queryTopMemories");
}

async function queryAgentMemories(
  pool,
  agentName,
  { limit = 5, minImportance = 5 }
) {
  return withRetry(async () => {
    const allowedStates = ["verified", "changelog"];
    const { rows } = await pool.query(
      `SELECT content, tier, importance, type, context
       FROM brainx_memories
       WHERE agent = $1
         AND importance >= $2
         AND COALESCE(verification_state, 'hypothesis') = ANY($3::text[])
         AND superseded_by IS NULL
         AND COALESCE(status, 'pending') NOT IN ('resolved', 'wont_fix')
         AND (expires_at IS NULL OR expires_at > NOW())
         AND COALESCE(verification_state, 'hypothesis') != 'obsolete'
       ORDER BY
         CASE COALESCE(verification_state, 'hypothesis')
           WHEN 'verified' THEN 1
           WHEN 'changelog' THEN 0
           ELSE -1
         END DESC,
         importance DESC, last_seen DESC NULLS LAST
       LIMIT $4`,
      [agentName, minImportance, allowedStates, limit]
    );
    return rows;
  }, "queryAgentMemories");
}

async function queryByType(pool, type, { limit = 10, minImportance = 5 }) {
  return withRetry(async () => {
    const { rows } = await pool.query(
      `SELECT content, tier, importance, type, agent, context
       FROM brainx_memories
       WHERE type = $1
         AND tier IN ('hot', 'warm')
         AND importance >= $2
         AND superseded_by IS NULL
         AND COALESCE(status, 'pending') NOT IN ('resolved', 'wont_fix')
         AND (expires_at IS NULL OR expires_at > NOW())
         AND COALESCE(verification_state, 'hypothesis') != 'obsolete'
       ORDER BY importance DESC, last_seen DESC NULLS LAST
       LIMIT $3`,
      [type, minImportance, limit]
    );
    return rows;
  }, "queryByType");
}

async function queryFacts(pool, { limit = 25 }) {
  return withRetry(async () => {
    const { rows } = await pool.query(
      `SELECT content, tier, importance, context, tags::text AS tags
       FROM brainx_memories
       WHERE type = 'fact'
         AND superseded_by IS NULL
         AND tier IN ('hot', 'warm')
         AND COALESCE(status, 'pending') NOT IN ('resolved', 'wont_fix')
         AND (expires_at IS NULL OR expires_at > NOW())
         AND COALESCE(verification_state, 'hypothesis') != 'obsolete'
       ORDER BY importance DESC, last_seen DESC NULLS LAST
       LIMIT $1`,
      [limit]
    );
    return rows;
  }, "queryFacts");
}

// ─── Agent-aware query (uses agent-profiles.json) ──────────────

function getAgentProfile(agentName) {
  return agentProfiles[agentName] || DEFAULT_SAFE_PROFILE;
}

function normalizeScoringWeights(rawWeights) {
  const defaults = DEFAULT_SAFE_PROFILE.scoringWeights;
  const candidates = rawWeights && typeof rawWeights === "object" ? rawWeights : {};
  const weights = {
    recency:
      typeof candidates.recency === "number" && Number.isFinite(candidates.recency) && candidates.recency >= 0
        ? candidates.recency
        : defaults.recency,
    relevance:
      typeof candidates.relevance === "number" && Number.isFinite(candidates.relevance) && candidates.relevance >= 0
        ? candidates.relevance
        : defaults.relevance,
    importance:
      typeof candidates.importance === "number" && Number.isFinite(candidates.importance) && candidates.importance >= 0
        ? candidates.importance
        : defaults.importance,
  };

  const total = weights.recency + weights.relevance + weights.importance;
  if (total <= 0) {
    return { ...defaults };
  }

  return {
    recency: weights.recency / total,
    relevance: weights.relevance / total,
    importance: weights.importance / total,
  };
}

function normalizeAgentProfile(agentName) {
  const raw = getAgentProfile(agentName) || DEFAULT_SAFE_PROFILE;
  const contexts = Array.isArray(raw.contexts) ? raw.contexts.filter(Boolean) : [];
  const excludeTypes = Array.isArray(raw.excludeTypes) ? raw.excludeTypes.filter(Boolean) : [];
  const boostTypes = Array.isArray(raw.boostTypes) ? raw.boostTypes.filter(Boolean) : [];
  const scoringWeights = normalizeScoringWeights(raw.scoringWeights);
  const allowCrossAgent = raw.allowCrossAgent === true;
  const crossAgentTagRequired = raw.crossAgentTagRequired !== false;
  const ratio =
    typeof raw.crossAgentRatio === "number" && Number.isFinite(raw.crossAgentRatio)
      ? raw.crossAgentRatio
      : 0.3;
  const crossAgentRatio = Math.max(0, Math.min(0.5, ratio));

  return {
    contexts,
    excludeTypes,
    boostTypes,
    scoringWeights,
    allowCrossAgent,
    crossAgentTagRequired,
    crossAgentRatio,
  };
}

function computeSlotPlan(limit, profile) {
  if (!profile.allowCrossAgent || limit <= 1) {
    return { ownSlots: Math.max(limit, 0), crossSlots: 0 };
  }

  const desiredCross = Math.floor(limit * profile.crossAgentRatio);
  const crossSlots = Math.max(1, Math.min(limit - 1, desiredCross));
  const ownSlots = Math.max(limit - crossSlots, 1);
  return { ownSlots, crossSlots };
}

function buildProfileQueryParts(profile, startParamIdx) {
  let paramIdx = startParamIdx;
  const params = [];
  const filters = [];

  if (profile.excludeTypes.length > 0) {
    const placeholders = profile.excludeTypes.map(() => `$${paramIdx++}`).join(",");
    params.push(...profile.excludeTypes);
    filters.push(`type NOT IN (${placeholders})`);
  }

  let contextScoreExpr = "0.0";
  if (profile.contexts.length > 0) {
    const conditions = [];
    const scoreTerms = [];
    for (const contextTerm of profile.contexts) {
      const placeholder = `$${paramIdx++}`;
      const condition = `LOWER(COALESCE(context, '')) LIKE LOWER(${placeholder})`;
      conditions.push(condition);
      scoreTerms.push(`CASE WHEN ${condition} THEN 1 ELSE 0 END`);
      params.push(`%${contextTerm}%`);
    }
    const combinedConditions = conditions.join(" OR ");
    filters.push(`(${combinedConditions})`);
    contextScoreExpr = `((${scoreTerms.join(" + ")})::float / ${profile.contexts.length})`;
  }

  let boostTypeScoreExpr = "0.0";
  if (profile.boostTypes.length > 0) {
    const placeholders = profile.boostTypes.map(() => `$${paramIdx++}`).join(",");
    params.push(...profile.boostTypes);
    boostTypeScoreExpr = `CASE WHEN type IN (${placeholders}) THEN 1.0 ELSE 0.0 END`;
  }

  const relevanceSignals = [];
  if (profile.contexts.length > 0) relevanceSignals.push(contextScoreExpr);
  if (profile.boostTypes.length > 0) relevanceSignals.push(boostTypeScoreExpr);
  const relevanceScoreExpr =
    relevanceSignals.length > 0
      ? `((${relevanceSignals.join(" + ")}) / ${relevanceSignals.length})`
      : "0.0";

  return {
    filters,
    params,
    nextParamIdx: paramIdx,
    relevanceScoreExpr,
  };
}

function buildWeightedScoreExpr(profile, queryParts) {
  // Stabilize recency ranking within the current hour to avoid noisy reorderings
  // between nearby bootstraps.
  const recencyScoreExpr = `EXP(
    -GREATEST(
      EXTRACT(EPOCH FROM (DATE_TRUNC('hour', NOW()) - COALESCE(last_seen, created_at))) / 86400.0,
      0
    ) / 30.0
  )`;
  const importanceScoreExpr = `LEAST(GREATEST(importance, 0), 10)::float / 10.0`;
  const weights = profile.scoringWeights || DEFAULT_SAFE_PROFILE.scoringWeights;

  return `(
    (${weights.relevance} * ${queryParts.relevanceScoreExpr}) +
    (${weights.importance} * ${importanceScoreExpr}) +
    (${weights.recency} * ${recencyScoreExpr})
  )`;
}

async function queryScopedMemories(
  pool,
  agentName,
  { limit = 8, minImportance = 5, type = null, profile = null, strictVerified = false }
) {
  const normalizedProfile = profile || normalizeAgentProfile(agentName);
  const { ownSlots, crossSlots } = computeSlotPlan(limit, normalizedProfile);

  return withRetry(async () => {
    const runScopedQuery = async ({ scope, slotLimit }) => {
      if (slotLimit <= 0) return [];

      let paramIdx = 1;
      const params = [];
      const where = [
        `tier IN ('hot', 'warm')`,
        `importance >= $${paramIdx++}`,
        `superseded_by IS NULL`,
        `COALESCE(status, 'pending') NOT IN ('resolved', 'wont_fix')`,
        `(expires_at IS NULL OR expires_at > NOW())`,
      ];
      params.push(minImportance);

      if (type) {
        where.push(`type = $${paramIdx++}`);
        params.push(type);
      }

      const allowedStates = strictVerified || scope === "cross"
        ? ["verified"]
        : ["verified", "changelog"];
      where.push(`COALESCE(verification_state, 'hypothesis') = ANY($${paramIdx++}::text[])`);
      params.push(allowedStates);

      const queryParts = buildProfileQueryParts(normalizedProfile, paramIdx);
      paramIdx = queryParts.nextParamIdx;
      params.push(...queryParts.params);
      where.push(...queryParts.filters);
      const weightedScoreExpr = buildWeightedScoreExpr(normalizedProfile, queryParts);

      if (scope === "own") {
        if (agentName && agentName !== "unknown") {
          where.push(`(agent = $${paramIdx++} OR agent IS NULL)`);
          params.push(agentName);
        } else {
          where.push(`agent IS NULL`);
        }
      } else {
        if (!normalizedProfile.allowCrossAgent) return [];
        if (agentName && agentName !== "unknown") {
          where.push(`agent IS DISTINCT FROM $${paramIdx++} AND agent IS NOT NULL`);
          params.push(agentName);
        } else {
          where.push(`agent IS NOT NULL`);
        }
        if (normalizedProfile.crossAgentTagRequired) {
          where.push(`'cross-agent' = ANY(COALESCE(tags, '{}'))`);
        }
      }

      const order = [];
      if (scope === "cross" && !normalizedProfile.crossAgentTagRequired) {
        order.push(`CASE WHEN 'cross-agent' = ANY(COALESCE(tags, '{}')) THEN 1 ELSE 0 END DESC`);
      }
      order.push(`CASE COALESCE(verification_state, 'hypothesis') WHEN 'verified' THEN 1 ELSE 0 END DESC`);
      order.push(`${weightedScoreExpr} DESC`);
      order.push(`importance DESC`);
      order.push(`last_seen DESC NULLS LAST`);
      order.push(`created_at DESC`);

      const limitParam = `$${paramIdx++}`;
      params.push(slotLimit);

      const sql = `SELECT content, tier, importance, type, agent, context
       FROM brainx_memories
       WHERE ${where.join("\n         AND ")}
       ORDER BY ${order.join(", ")}
       LIMIT ${limitParam}`;

      const { rows } = await pool.query(sql, params);
      return rows;
    };

    const ownRows = await runScopedQuery({ scope: "own", slotLimit: ownSlots });
    const crossRows =
      crossSlots > 0
        ? await runScopedQuery({ scope: "cross", slotLimit: crossSlots })
        : [];

    return [...ownRows, ...crossRows];
  }, type ? `queryScopedMemories:${type}` : "queryScopedMemories");
}

async function queryAgentAwareMemories(pool, agentName, { limit = 8, minImportance = 5 }) {
  return queryScopedMemories(pool, agentName, {
    limit,
    minImportance,
    profile: normalizeAgentProfile(agentName),
    strictVerified: true,
  });
}

async function queryAgentAwareByType(
  pool,
  agentName,
  type,
  { limit = 10, minImportance = 5 }
) {
  return queryScopedMemories(pool, agentName, {
    limit,
    minImportance,
    type,
    profile: normalizeAgentProfile(agentName),
    strictVerified: true,
  });
}

// ─── Formatting ────────────────────────────────────────────────

function formatMemoryLine(m, maxLen = 150) {
  const meta = `[${m.tier}/imp:${m.importance}]`;
  return `- **${meta}** ${truncate(m.content, maxLen)}`;
}

function formatMemoryBlock(m) {
  const parts = [`[tier:${m.tier} imp:${m.importance} type:${m.type}`];
  if (m.agent) parts[0] += ` agent:${m.agent}`;
  if (m.context) parts[0] += ` ctx:${m.context}`;
  parts[0] += "]";
  parts.push(truncate(m.content, 2000));
  return parts.join("\n");
}

// ─── MEMORY.md injection ──────────────────────────────────────

function buildMemorySection(agentName, timestamp, teamMems, ownMems) {
  const lines = [BRAINX_START, "", "## BrainX Context (Auto-Injected)", ""];
  lines.push(`**Agent:** ${agentName} | **Updated:** ${timestamp}`);
  lines.push("");

  if (teamMems.length > 0) {
    // Split team memories: own-agent vs cross-agent for balanced display
    const ownTeam = teamMems.filter(m => m.agent === agentName || !m.agent);
    const crossTeam = teamMems.filter(m => m.agent && m.agent !== agentName);

    lines.push("### Top Memories");
    for (const m of ownTeam.slice(0, 5)) {
      lines.push(formatMemoryLine(m));
    }
    lines.push("");

    if (crossTeam.length > 0) {
      lines.push("### Cross-Agent Intel");
      for (const m of crossTeam.slice(0, 3)) {
        lines.push(`- **[${m.agent}/${m.tier}/imp:${m.importance}]** ${(m.content || '').slice(0, 120)}...`);
      }
      lines.push("");
    }
  }

  if (ownMems.length > 0) {
    lines.push(`### My Memories (${agentName})`);
    for (const m of ownMems.slice(0, 4)) {
      lines.push(formatMemoryLine(m));
    }
    lines.push("");
  }

  if (teamMems.length === 0 && ownMems.length === 0) {
    lines.push("*No hot/warm memories with importance >= 5.*");
    lines.push("");
  }

  lines.push(
    `> Full context: \`cat BRAINX_CONTEXT.md\` | Topics: \`cat brainx-topics/<topic>.md\` | Canonical docs: \`brainx knowledge-locate --query "<task>"\``
  );
  lines.push("", BRAINX_END);
  return lines.join("\n");
}

async function updateMemoryMd(workspaceDir, section) {
  const memPath = path.join(workspaceDir, "MEMORY.md");
  let content = "";
  try {
    content = await fs.readFile(memPath, "utf-8");
  } catch {
    // File doesn't exist — will create with just the section
  }

  // Use lastIndexOf: MEMORY.md templates may reference the markers in
  // instructional text — the real injection block is always the last occurrence.
  const startIdx = content.lastIndexOf(BRAINX_START);
  const endIdx = content.lastIndexOf(BRAINX_END);

  if (startIdx !== -1 && endIdx !== -1) {
    // Replace existing section
    content =
      content.slice(0, startIdx) +
      section +
      content.slice(endIdx + BRAINX_END.length);
  } else {
    // Append
    content = content.trimEnd() + "\n\n" + section + "\n";
  }

  await writeIfChanged(memPath, content);
}

// ─── BRAINX_CONTEXT.md + topic files (backward compat) ───────

async function writeTopicFile(dir, filename, title, memories, timestamp) {
  const filePath = path.join(dir, filename);
  if (memories.length === 0) {
    await writeIfChanged(filePath, `# ${title} — None found\n`);
    return 0;
  }
  const lines = [`# ${title}`, "", `**Updated:** ${timestamp}`, ""];
  for (const m of memories) {
    lines.push(formatMemoryBlock(m));
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  await writeIfChanged(filePath, lines.join("\n"));
  return memories.length;
}

async function writeBrainxContext(
  workspaceDir,
  agentName,
  timestamp,
  counts,
  facts,
  ownMems,
  options = {}
) {
  const includeLearnings = options.includeLearnings === true;
  const topicsDir = path.join(workspaceDir, "brainx-topics");
  const contextPath = path.join(workspaceDir, "BRAINX_CONTEXT.md");

  // Compact index — always loaded
  const lines = [
    "# BrainX Context (Auto-Injected)",
    "",
    `**Agent:** ${agentName} | **Updated:** ${timestamp}`,
    "**Mode:** Compact index — read topic files with `cat brainx-topics/<file>.md` when you need detail",
    '**Task-specific canonical docs:** use `brainx knowledge-locate --query "<task>"` and read the suggested `.md` files in full before drafting when precision matters',
    "",
  ];

  // Facts summary
  lines.push(
    `## Facts (${counts.facts}) -> \`brainx-topics/facts.md\``
  );
  if (facts.length > 0) {
    for (const f of facts.slice(0, 5)) {
      lines.push(`  - [${f.tier}] ${truncate(f.content, 100)}`);
    }
  } else {
    lines.push("  *Empty*");
  }
  lines.push("");

  // Own memories summary
  lines.push(
    `## My memories (${counts.own}) -> \`brainx-topics/own.md\``
  );
  if (ownMems.length > 0) {
    for (const m of ownMems.slice(0, 3)) {
      lines.push(`  - ${truncate(m.content, 100)}`);
    }
  } else {
    lines.push("  *No own memories*");
  }
  lines.push("");

  // Topics directory table
  lines.push("## Topics");
  lines.push("");
  lines.push("| Topic | Items | File |");
  lines.push("|-------|-------|------|");
  lines.push(
    `| Decisions | ${counts.decisions} | \`brainx-topics/decisions.md\` |`
  );
  lines.push(
    `| Gotchas | ${counts.gotchas} | \`brainx-topics/gotchas.md\` |`
  );
  if (includeLearnings) {
    lines.push(
      `| Learnings | ${counts.learnings} | \`brainx-topics/learnings.md\` |`
    );
  }
  lines.push(`| Team | ${counts.team} | \`brainx-topics/team.md\` |`);
  lines.push(`| Facts | ${counts.facts} | \`brainx-topics/facts.md\` |`);
  lines.push(`| Own | ${counts.own} | \`brainx-topics/own.md\` |`);
  lines.push("");

  lines.push("---");
  lines.push(
    '**Save fact:** `brainx add --type fact --tier hot --importance 8 --context "project:NAME" --content "..."`'
  );

  const content = lines.join("\n") + "\n";
  await writeIfChanged(contextPath, content);
  return content.length;
}

// ─── Telemetry ─────────────────────────────────────────────────

async function logInjection(pool, agentName, ownCount, teamCount, totalChars) {
  try {
    await pool.query(
      `INSERT INTO brainx_pilot_log (agent, own_memories, team_memories, total_chars, injected_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [agentName, ownCount, teamCount, totalChars]
    );
  } catch {}
}

// ─── Main handler ──────────────────────────────────────────────

const handler = async (event) => {
  if (event.type !== "agent" || event.action !== "bootstrap") return;

  const t0 = Date.now();

  try {
    loadEnv();
    refreshAgentProfiles();

    const workspaceDir = event.context?.workspaceDir;
    if (!workspaceDir) {
      console.error("[brainx-inject] No workspaceDir in event context, skipping");
      return;
    }

    await ensureDailyMemoryFiles(workspaceDir);

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      console.error("[brainx-inject] DATABASE_URL not set, skipping");
      return;
    }

    // Extract agent ID from multiple sources (event context, session key, env)
    const agentName = event.agentId || event.agent || extractAgentId(event.sessionKey) || process.env.OPENCLAW_AGENT_ID || 'unknown';
    const timestamp = ts();
    const includeLearnings = process.env.BRAINX_BOOTSTRAP_INCLUDE_LEARNINGS === "true";

    const pool = getPool(dbUrl);

    {
      // Run all queries in parallel (team memories are now agent-aware)
      const [topMems, ownMems, facts, decisions, learnings, gotchas] =
        await Promise.all([
          queryAgentAwareMemories(pool, agentName, { limit: 12, minImportance: 7 }),
          queryAgentMemories(pool, agentName, { limit: 5, minImportance: 5 }),
          queryAgentAwareByType(pool, agentName, "fact", { limit: 25, minImportance: 5 }),
          queryAgentAwareByType(pool, agentName, "decision", { limit: 8, minImportance: 5 }),
          includeLearnings
            ? queryAgentAwareByType(pool, agentName, "learning", { limit: 8, minImportance: 5 })
            : Promise.resolve([]),
          queryAgentAwareByType(pool, agentName, "gotcha", { limit: 10, minImportance: 3 }),
        ]);
      const crossTeamMems = topMems.filter((m) => m.agent && m.agent !== agentName);

      // 1. Update MEMORY.md (primary injection path)
      const memSection = buildMemorySection(
        agentName,
        timestamp,
        topMems,
        ownMems
      );
      await updateMemoryMd(workspaceDir, memSection);

      // 2. Write topic files (backward compat)
      const topicsDir = path.join(workspaceDir, "brainx-topics");
      await fs.mkdir(topicsDir, { recursive: true });

      const [, , , , ,] = await Promise.all([
        writeTopicFile(
          topicsDir,
          "facts.md",
          "Project Facts",
          facts,
          timestamp
        ),
        writeTopicFile(
          topicsDir,
          "decisions.md",
          "Decisions",
          decisions,
          timestamp
        ),
        includeLearnings
          ? writeTopicFile(
              topicsDir,
              "learnings.md",
              "Learnings & Insights",
              learnings,
              timestamp
            )
          : Promise.resolve(0),
        writeTopicFile(
          topicsDir,
          "team.md",
          "Team Knowledge (High Importance)",
          crossTeamMems,
          timestamp
        ),
        writeTopicFile(
          topicsDir,
          "own.md",
          `Agent: ${agentName} — My Memories`,
          ownMems,
          timestamp
        ),
      ]);

      const counts = {
        facts: facts.length,
        decisions: decisions.length,
        learnings: learnings.length,
        team: crossTeamMems.length,
        own: ownMems.length,
        gotchas: gotchas.length,
      };

      // 3. Write BRAINX_CONTEXT.md (compact index)
      const indexChars = await writeBrainxContext(
        workspaceDir,
        agentName,
        timestamp,
        counts,
        facts,
        ownMems,
        { includeLearnings }
      );

      // Write gotchas topic with real data from DB
      await writeTopicFile(topicsDir, "gotchas.md", "Gotchas & Traps", gotchas, timestamp);

      // 4. Telemetry
      await logInjection(
        pool,
        agentName,
        ownMems.length,
        crossTeamMems.length,
        memSection.length + indexChars
      );

      const elapsed = Date.now() - t0;
      console.log(
        `[brainx-inject] agent=${agentName} team=${crossTeamMems.length} own=${ownMems.length} facts=${facts.length} decisions=${decisions.length} ${elapsed}ms`
      );
    }
  } catch (err) {
    const elapsed = Date.now() - t0;
    const errorMsg = err instanceof Error ? err.message : String(err);
    
    // Log error but don't crash the agent bootstrap
    console.error(`[brainx-inject] Failed after ${elapsed}ms: ${errorMsg}`);
    
    // Write a minimal fallback to MEMORY.md so the agent knows BrainX had issues
    try {
      const workspaceDir = event.context?.workspaceDir;
      if (workspaceDir) {
        const fallbackSection = `${BRAINX_START}\n\n## BrainX Context (Auto-Injected)\n\n**⚠️ BrainX injection failed:** ${errorMsg}\n\n> Run \`brainx health\` to check status\n\n${BRAINX_END}`;
        await updateMemoryMd(workspaceDir, fallbackSection);
      }
    } catch (fallbackErr) {
      // If even fallback fails, just log it
      console.error("[brainx-inject] Fallback write also failed:", fallbackErr);
    }
  }
};

export default handler;
