/**
 * BrainX V4 Auto-Inject Hook Handler
 *
 * Runs on agent:bootstrap — queries PostgreSQL for hot/warm memories
 * and injects them into the agent's MEMORY.md + BRAINX_CONTEXT.md.
 */

import { createRequire } from "module";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

const BRAINX_DIR = "/home/clawd/.openclaw/skills/brainx-v4";
const brainxRequire = createRequire(path.join(BRAINX_DIR, "index.js"));

// Section markers for MEMORY.md — content between these is replaced each run
const BRAINX_START = "<!-- BRAINX:START -->";
const BRAINX_END = "<!-- BRAINX:END -->";

// ─── Env loading ───────────────────────────────────────────────

function loadEnv() {
  try {
    const dotenv = brainxRequire("dotenv");
    dotenv.config({ path: path.join(BRAINX_DIR, ".env") });
  } catch {}
}

// ─── Helpers ───────────────────────────────────────────────────

function extractAgentId(sessionKey) {
  if (!sessionKey) return "unknown";
  const parts = sessionKey.split(":");
  return parts.length >= 2 ? parts[1] : "unknown";
}

function ts() {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function truncate(str, max = 150) {
  if (!str || str.length <= max) return str || "";
  return str.slice(0, max - 3) + "...";
}

// ─── DB queries ────────────────────────────────────────────────

async function queryTopMemories(pool, { limit = 8, minImportance = 5 }) {
  const { rows } = await pool.query(
    `SELECT content, tier, importance, type, agent, context
     FROM brainx_memories
     WHERE tier IN ('hot', 'warm')
       AND importance >= $1
       AND superseded_by IS NULL
     ORDER BY importance DESC, last_seen DESC NULLS LAST, created_at DESC
     LIMIT $2`,
    [minImportance, limit]
  );
  return rows;
}

async function queryAgentMemories(
  pool,
  agentName,
  { limit = 5, minImportance = 5 }
) {
  const { rows } = await pool.query(
    `SELECT content, tier, importance, type, context
     FROM brainx_memories
     WHERE agent = $1
       AND importance >= $2
       AND superseded_by IS NULL
     ORDER BY importance DESC, last_seen DESC NULLS LAST
     LIMIT $3`,
    [agentName, minImportance, limit]
  );
  return rows;
}

async function queryByType(pool, type, { limit = 10, minImportance = 5 }) {
  const { rows } = await pool.query(
    `SELECT content, tier, importance, type, agent, context
     FROM brainx_memories
     WHERE type = $1
       AND tier IN ('hot', 'warm')
       AND importance >= $2
       AND superseded_by IS NULL
     ORDER BY importance DESC, last_seen DESC NULLS LAST
     LIMIT $3`,
    [type, minImportance, limit]
  );
  return rows;
}

async function queryFacts(pool, { limit = 25 }) {
  const { rows } = await pool.query(
    `SELECT content, tier, importance, context, tags::text AS tags
     FROM brainx_memories
     WHERE type = 'fact'
       AND superseded_by IS NULL
       AND tier IN ('hot', 'warm')
     ORDER BY importance DESC, last_seen DESC NULLS LAST
     LIMIT $1`,
    [limit]
  );
  return rows;
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
    lines.push("### Top Memories");
    for (const m of teamMems.slice(0, 6)) {
      lines.push(formatMemoryLine(m));
    }
    lines.push("");
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
    `> Full context: \`cat BRAINX_CONTEXT.md\` | Topics: \`cat brainx-topics/<topic>.md\``
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

  const startIdx = content.indexOf(BRAINX_START);
  const endIdx = content.indexOf(BRAINX_END);

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

  await fs.writeFile(memPath, content, "utf-8");
}

// ─── BRAINX_CONTEXT.md + topic files (backward compat) ───────

async function writeTopicFile(dir, filename, title, memories, timestamp) {
  const filePath = path.join(dir, filename);
  if (memories.length === 0) {
    await fs.writeFile(filePath, `# ${title} — None found\n`, "utf-8");
    return 0;
  }
  const lines = [`# ${title}`, "", `**Updated:** ${timestamp}`, ""];
  for (const m of memories) {
    lines.push(formatMemoryBlock(m));
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  await fs.writeFile(filePath, lines.join("\n"), "utf-8");
  return memories.length;
}

async function writeBrainxContext(
  workspaceDir,
  agentName,
  timestamp,
  counts,
  facts,
  ownMems
) {
  const topicsDir = path.join(workspaceDir, "brainx-topics");
  const contextPath = path.join(workspaceDir, "BRAINX_CONTEXT.md");

  // Compact index — always loaded
  const lines = [
    "# BrainX V4 Context (Auto-Injected)",
    "",
    `**Agent:** ${agentName} | **Updated:** ${timestamp}`,
    "**Mode:** Compact index — read topic files with `cat brainx-topics/<file>.md` when you need detail",
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
  lines.push(
    `| Learnings | ${counts.learnings} | \`brainx-topics/learnings.md\` |`
  );
  lines.push(`| Team | ${counts.team} | \`brainx-topics/team.md\` |`);
  lines.push(`| Facts | ${counts.facts} | \`brainx-topics/facts.md\` |`);
  lines.push(`| Own | ${counts.own} | \`brainx-topics/own.md\` |`);
  lines.push("");

  lines.push("---");
  lines.push(
    '**Save fact:** `brainx add --type fact --tier hot --importance 8 --context "project:NAME" --content "..."`'
  );

  await fs.writeFile(contextPath, lines.join("\n") + "\n", "utf-8");
  return lines.join("\n").length;
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

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      console.error("[brainx-inject] DATABASE_URL not set, skipping");
      return;
    }

    const workspaceDir = event.context?.workspaceDir;
    if (!workspaceDir) {
      console.error("[brainx-inject] No workspaceDir in event context, skipping");
      return;
    }

    const agentName = extractAgentId(event.sessionKey);
    const timestamp = ts();

    const { Pool } = brainxRequire("pg");
    const pool = new Pool({ connectionString: dbUrl });

    try {
      // Run all queries in parallel
      const [teamMems, ownMems, facts, decisions, learnings] =
        await Promise.all([
          queryTopMemories(pool, { limit: 8, minImportance: 5 }),
          queryAgentMemories(pool, agentName, { limit: 5, minImportance: 5 }),
          queryFacts(pool, { limit: 25 }),
          queryByType(pool, "decision", { limit: 8, minImportance: 5 }),
          queryByType(pool, "learning", { limit: 8, minImportance: 5 }),
        ]);

      // 1. Update MEMORY.md (primary injection path)
      const memSection = buildMemorySection(
        agentName,
        timestamp,
        teamMems,
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
        writeTopicFile(
          topicsDir,
          "learnings.md",
          "Learnings & Insights",
          learnings,
          timestamp
        ),
        writeTopicFile(
          topicsDir,
          "team.md",
          "Team Knowledge (High Importance)",
          teamMems,
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
        team: teamMems.length,
        own: ownMems.length,
        gotchas: 0,
      };

      // 3. Write BRAINX_CONTEXT.md (compact index)
      const indexChars = await writeBrainxContext(
        workspaceDir,
        agentName,
        timestamp,
        counts,
        facts,
        ownMems
      );

      // Also write an empty gotchas topic (queried by type 'gotcha' — may not exist)
      await writeTopicFile(topicsDir, "gotchas.md", "Gotchas & Traps", [], timestamp);

      // 4. Telemetry
      await logInjection(
        pool,
        agentName,
        ownMems.length,
        teamMems.length,
        memSection.length + indexChars
      );

      const elapsed = Date.now() - t0;
      console.log(
        `[brainx-inject] agent=${agentName} team=${teamMems.length} own=${ownMems.length} facts=${facts.length} decisions=${decisions.length} ${elapsed}ms`
      );
    } finally {
      await pool.end();
    }
  } catch (err) {
    console.error(
      "[brainx-inject] Error:",
      err instanceof Error ? err.message : String(err)
    );
  }
};

export default handler;
