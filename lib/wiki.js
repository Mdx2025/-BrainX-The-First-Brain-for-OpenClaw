"use strict";

try {
  const dotenv = require("dotenv");
  dotenv.config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
} catch (_) {}

const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const db = require("./db");

const ROOT = path.join(__dirname, "..");
const AUTO_BLOCK_RE = /<!--\s*BRAINX:AUTO:START\s*-->[\s\S]*?<!--\s*BRAINX:AUTO:END\s*-->/g;
const KNOWLEDGE_ROOT = path.join(ROOT, "knowledge");
const WIKI_MARKER = ".brainx-wiki";
const DEFAULT_CORE_PLUGINS = [
  "backlink",
  "file-explorer",
  "global-search",
  "outgoing-link",
  "tag-pane",
  "templates",
];

function envInt(name, fallback, { min, max } = {}) {
  const raw = process.env[name];
  const parsed = raw == null || raw === "" ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  let next = parsed;
  if (typeof min === "number") next = Math.max(min, next);
  if (typeof max === "number") next = Math.min(max, next);
  return next;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (typeof raw !== "string") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncate(value, maxChars) {
  const text = normalizeWhitespace(value);
  if (!maxChars || text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

function shortText(value, maxChars = 220) {
  const cleaned = String(value ?? "").replace(/^\s*(?:#{1,6}\s+.+(?:\r?\n|$))+/u, "");
  const text = normalizeWhitespace(cleaned);
  if (!text) return "";
  const firstSentence = text.split(/(?<=[.!?])\s+/)[0] || text;
  return truncate(firstSentence, maxChars);
}

function sha1(text) {
  return crypto.createHash("sha1").update(String(text)).digest("hex");
}

function slugify(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "untitled";
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  const raw = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return raw
    .split(",")
    .map((item) => item.replace(/^['"]|['"]$/g, "").trim())
    .filter(Boolean);
}

function parseFrontmatter(raw) {
  const match = String(raw).match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { meta: {}, body: String(raw) };

  const meta = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    if (["tags"].includes(key)) meta[key] = normalizeList(value);
    else if (["importance"].includes(key)) meta[key] = Number.parseInt(value, 10);
    else meta[key] = value.replace(/^['"]|['"]$/g, "");
  }

  return { meta, body: String(raw).slice(match[0].length) };
}

function stripAutoManagedBlocks(raw) {
  return String(raw).replace(AUTO_BLOCK_RE, "").trim();
}

function stripLeadingH1(body, fallbackTitle) {
  const lines = String(body).split(/\r?\n/);
  if (lines.length && /^#\s+/.test(lines[0])) {
    return {
      title: lines[0].replace(/^#\s+/, "").trim() || fallbackTitle,
      body: lines.slice(1).join("\n").trim(),
    };
  }
  return { title: fallbackTitle, body: String(body).trim() };
}

function humanizeFilename(fileName) {
  return String(fileName)
    .replace(/\.md$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Untitled";
}

function splitSections(body, fileTitle) {
  const matches = [...String(body).matchAll(/^(##|###)\s+(.+)$/gm)];
  if (!matches.length) {
    const text = normalizeWhitespace(body);
    return text ? [{ key: "root", title: fileTitle, content: text }] : [];
  }

  const sections = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const next = matches[index + 1];
    const start = match.index;
    const end = next ? next.index : body.length;
    const chunk = String(body).slice(start, end).trim();
    const title = normalizeWhitespace(match[2]);
    const cleanedChunk = chunk.replace(/^(##|###)\s+.+\n?/, "").trim();
    if (!cleanedChunk || cleanedChunk.length < 48) continue;
    sections.push({
      key: `${index + 1}-${slugify(title)}`,
      title,
      content: cleanedChunk,
    });
  }
  return sections;
}

function shouldSkipKnowledgeFile(relPath) {
  const base = path.basename(relPath);
  if (!base.endsWith(".md")) return true;
  if (base === "README.md" || base === "INDEX.md") return true;
  if (base.startsWith("_")) return true;
  return false;
}

async function walkMarkdownFiles(rootDir) {
  const files = [];

  async function visit(currentDir) {
    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith("_")) continue;
        await visit(fullPath);
        continue;
      }
      const relPath = path.relative(rootDir, fullPath).replace(/\\/g, "/");
      if (!shouldSkipKnowledgeFile(relPath)) {
        files.push({ fullPath, relPath });
      }
    }
  }

  await visit(rootDir);
  return files.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeText(filePath, content) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, String(content).replace(/\s+$/, "") + "\n", "utf8");
}

async function writeJson(filePath, payload) {
  await writeText(filePath, JSON.stringify(payload, null, 2));
}

function yamlScalar(value) {
  if (value == null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value);
  if (!text || /[:#[\]{}]|^\s|\s$|\n/.test(text)) {
    return JSON.stringify(text);
  }
  return text;
}

function renderFrontmatter(data) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlScalar(item)}`);
      continue;
    }
    if (typeof value === "object") {
      lines.push(`${key}: ${yamlScalar(JSON.stringify(value))}`);
      continue;
    }
    lines.push(`${key}: ${yamlScalar(value)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

function wikiLink(targetPath, alias) {
  const normalized = String(targetPath).replace(/\\/g, "/");
  return alias ? `[[${normalized}|${alias}]]` : `[[${normalized}]]`;
}

function deriveDomainAndTopic(relPath) {
  const relNoExt = relPath.replace(/\.md$/i, "");
  const parts = relNoExt.split("/");
  const domain = parts[0] || "general";
  const topic = parts.slice(1).join("/") || path.basename(relNoExt);
  return { domain, topic };
}

function ageDaysFrom(timestampMs) {
  if (!Number.isFinite(timestampMs)) return null;
  return Math.floor((Date.now() - timestampMs) / (24 * 60 * 60 * 1000));
}

function resolveWikiConfig(overrides = {}) {
  const vaultDir = path.resolve(
    overrides.vaultDir ||
      process.env.BRAINX_WIKI_VAULT_DIR ||
      path.join(os.homedir(), "brainx-vault"),
  );
  const knowledgeRoot = path.resolve(
    overrides.knowledgeRoot ||
      process.env.BRAINX_WIKI_KNOWLEDGE_ROOT ||
      KNOWLEDGE_ROOT,
  );
  const maxMemories = Math.max(
    20,
    Number.parseInt(overrides.maxMemories ?? process.env.BRAINX_WIKI_MAX_MEMORIES ?? "240", 10) || 240,
  );
  const minMemoryImportance = Math.max(
    1,
    Math.min(10, Number.parseInt(overrides.minMemoryImportance ?? process.env.BRAINX_WIKI_MIN_MEMORY_IMPORTANCE ?? "7", 10) || 7),
  );
  const digestMaxItems = Math.max(
    4,
    Number.parseInt(overrides.digestMaxItems ?? process.env.BRAINX_WIKI_DIGEST_MAX_ITEMS ?? "6", 10) || 6,
  );
  const maxKnowledgeSections = Math.max(
    1,
    Number.parseInt(overrides.maxKnowledgeSections ?? process.env.BRAINX_WIKI_MAX_KNOWLEDGE_SECTIONS ?? "3", 10) || 3,
  );
  const staleDays = Math.max(
    1,
    Number.parseInt(overrides.staleDays ?? process.env.BRAINX_WIKI_STALE_DAYS ?? "45", 10) || 45,
  );
  const lowConfidenceThreshold = Number.parseFloat(
    overrides.lowConfidenceThreshold ?? process.env.BRAINX_WIKI_LOW_CONFIDENCE_THRESHOLD ?? "0.78",
  );

  const markerDir = path.join(vaultDir, WIKI_MARKER);
  return {
    vaultDir,
    knowledgeRoot,
    maxMemories,
    minMemoryImportance,
    digestMaxItems,
    maxKnowledgeSections,
    staleDays,
    lowConfidenceThreshold: Number.isFinite(lowConfidenceThreshold) ? lowConfidenceThreshold : 0.78,
    obsidianEnabled: overrides.obsidianEnabled ?? envBool("BRAINX_WIKI_OBSIDIAN_ENABLED", true),
    markerDir,
    cacheDir: path.join(markerDir, "cache"),
    reportsDir: path.join(vaultDir, "reports", "brainx"),
    sourcesDir: path.join(vaultDir, "sources", "brainx"),
    synthesesDir: path.join(vaultDir, "syntheses", "brainx"),
    conceptsDir: path.join(vaultDir, "concepts", "brainx"),
    entitiesDir: path.join(vaultDir, "entities", "brainx"),
    obsidianDir: path.join(vaultDir, ".obsidian"),
    compileStatusPath: path.join(markerDir, "cache", "compile-status.json"),
    generatedFilesPath: path.join(markerDir, "cache", "generated-files.json"),
    claimsPath: path.join(markerDir, "cache", "claims.jsonl"),
    generalDigestPath: path.join(markerDir, "cache", "agent-digest.json"),
    agentDigestDir: path.join(markerDir, "cache", "agents"),
    xdgOpenPath: process.env.BRAINX_WIKI_XDG_OPEN || "xdg-open",
  };
}

async function ensureWikiVault(config) {
  await Promise.all([
    ensureDir(config.vaultDir),
    ensureDir(config.markerDir),
    ensureDir(config.cacheDir),
    ensureDir(config.sourcesDir),
    ensureDir(config.synthesesDir),
    ensureDir(config.conceptsDir),
    ensureDir(config.entitiesDir),
    ensureDir(config.reportsDir),
    ensureDir(config.agentDigestDir),
  ]);

  if (!config.obsidianEnabled) return;

  await ensureDir(config.obsidianDir);
  const appConfigPath = path.join(config.obsidianDir, "app.json");
  const corePluginsPath = path.join(config.obsidianDir, "core-plugins.json");
  const dailyNotesPath = path.join(config.obsidianDir, "daily-notes.json");

  if (!(await fileExists(appConfigPath))) {
    await writeJson(appConfigPath, {
      showLineNumber: true,
      spellcheck: true,
      attachmentFolderPath: "sources/brainx/assets",
      promptDelete: false,
      newFileLocation: "folder",
      newFileFolderPath: "notes",
    });
  }
  if (!(await fileExists(corePluginsPath))) {
    await writeJson(corePluginsPath, DEFAULT_CORE_PLUGINS);
  }
  if (!(await fileExists(dailyNotesPath))) {
    await writeJson(dailyNotesPath, {
      folder: "reports/brainx/dailies",
      format: "YYYY-MM-DD",
      template: "",
      autorun: false,
    });
  }
}

async function loadKnowledgeDocs(config) {
  const files = await walkMarkdownFiles(config.knowledgeRoot);
  const docs = [];

  for (const file of files) {
    const raw = await fs.readFile(file.fullPath, "utf8");
    const { meta, body } = parseFrontmatter(raw);
    const cleaned = stripAutoManagedBlocks(body);
    if (!cleaned) continue;

    const defaultTitle = humanizeFilename(path.basename(file.relPath));
    const { title, body: withoutTitle } = stripLeadingH1(cleaned, defaultTitle);
    const { domain, topic } = deriveDomainAndTopic(file.relPath);
    const stat = await fs.stat(file.fullPath);
    const sections = splitSections(withoutTitle, title)
      .slice(0, config.maxKnowledgeSections)
      .map((section) => ({
        ...section,
        summary: shortText(section.content, 220),
      }));

    docs.push({
      id: `knowledge:${file.relPath}`,
      relPath: file.relPath,
      fullPath: file.fullPath,
      title,
      body: withoutTitle,
      meta,
      tags: Array.from(
        new Set([
          "knowledge",
          "knowledge:canonical",
          `domain:${domain}`,
          `topic:${topic}`,
          ...normalizeList(meta.tags || []),
        ]),
      ),
      summary: shortText(withoutTitle, 260),
      sections,
      domain,
      topic,
      mtimeMs: stat.mtimeMs,
      stale: (ageDaysFrom(stat.mtimeMs) ?? 0) > config.staleDays,
      wikiPath: path.join("sources", "brainx", "knowledge", file.relPath).replace(/\\/g, "/"),
    });
  }

  return docs;
}

async function loadDurableMemories(config) {
  const result = await db.query(
    `SELECT
       id,
       type,
       content,
       context,
       tier,
       agent,
       importance,
       tags,
       status,
       category,
       pattern_key,
       recurrence_count,
       first_seen,
       last_seen,
       created_at,
       resolved_at,
       promoted_to,
       resolution_notes,
       source_kind,
       source_path,
       COALESCE(confidence_score, 0.7) AS confidence_score,
       expires_at,
       sensitivity,
       verification_state
     FROM brainx_memories
     WHERE superseded_by IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())
       AND tier IN ('hot', 'warm')
       AND importance >= $1
       AND verification_state IN ('verified', 'changelog')
     ORDER BY importance DESC, COALESCE(last_seen, created_at) DESC
     LIMIT $2`,
    [config.minMemoryImportance, config.maxMemories],
  );

  return result.rows.map((row) => {
    const timestamp = Date.parse(String(row.last_seen || row.created_at || row.first_seen || ""));
    const contextSlug = slugify(row.context || row.agent || row.category || row.type || "shared");
    return {
      ...row,
      tags: Array.isArray(row.tags) ? row.tags : [],
      confidence_score: Number(row.confidence_score || 0.7),
      ageDays: ageDaysFrom(timestamp),
      stale: Number.isFinite(timestamp) ? ageDaysFrom(timestamp) > config.staleDays : false,
      contextSlug,
      timestamp,
    };
  });
}

async function loadOpenQuestions(limit = 40) {
  const result = await db.query(
    `SELECT
       id,
       type,
       content,
       context,
       agent,
       importance,
       status,
       category,
       verification_state,
       source_kind,
       created_at,
       last_seen
     FROM brainx_memories
     WHERE superseded_by IS NULL
       AND (
         verification_state = 'hypothesis'
         OR status IN ('pending', 'in_progress')
       )
       AND COALESCE(status, 'pending') IN ('pending', 'in_progress')
       AND verification_state <> 'verified'
       AND NOT (source_kind = 'tool_verified' AND verification_state = 'changelog')
       AND NOT (content ~* '(^|\\b)(BUG RESUELTO|BUG/DEUDA resuelta|fixed on|final doc is at|documentation sync completed|documented .* bug)')
       AND (
         content ~* '(\\?|open question|unknown|unresolved|needs (decision|review|owner)|pending decision|pendiente|bloquead|blocker|tbd|todo|decidir|pregunta|sin resolver)'
         OR category IN ('question', 'blocker')
       )
     ORDER BY importance DESC, COALESCE(last_seen, created_at) DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

function buildKnowledgeClaims(docs) {
  const claims = [];
  for (const doc of docs) {
    claims.push({
      id: `claim:${sha1(doc.id + ":summary")}`,
      kind: "knowledge",
      type: "fact",
      title: doc.title,
      claim: doc.summary || shortText(doc.body, 240),
      confidence: 0.98,
      status: "verified",
      verificationState: "verified",
      sourceKind: "knowledge_canonical",
      sourcePath: doc.fullPath,
      page: doc.wikiPath,
      domain: doc.domain,
      topic: doc.topic,
      category: doc.meta.category || doc.domain,
      tags: doc.tags,
      evidence: [
        {
          kind: "file",
          relPath: doc.relPath,
          path: doc.fullPath,
        },
      ],
      freshnessDays: ageDaysFrom(doc.mtimeMs),
      stale: doc.stale,
    });

    for (const section of doc.sections) {
      claims.push({
        id: `claim:${sha1(doc.id + ":" + section.key)}`,
        kind: "knowledge",
        type: "fact",
        title: `${doc.title} — ${section.title}`,
        claim: shortText(section.content, 240),
        confidence: 0.97,
        status: "verified",
        verificationState: "verified",
        sourceKind: "knowledge_canonical",
        sourcePath: `${doc.fullPath}#${section.key}`,
        page: doc.wikiPath,
        domain: doc.domain,
        topic: doc.topic,
        category: doc.meta.category || doc.domain,
        tags: doc.tags,
        evidence: [
          {
            kind: "file-section",
            relPath: doc.relPath,
            path: doc.fullPath,
            section: section.title,
          },
        ],
        freshnessDays: ageDaysFrom(doc.mtimeMs),
        stale: doc.stale,
      });
    }
  }
  return claims;
}

function buildMemoryClaims(rows) {
  return rows.map((row) => ({
    id: `claim:${sha1(row.id)}`,
    memoryId: row.id,
    kind: "memory",
    type: row.type,
    title: shortText(row.content, 96),
    claim: shortText(row.content, 260),
    confidence: Number(row.confidence_score || 0.7),
    status: row.status || "pending",
    verificationState: row.verification_state || "hypothesis",
    sourceKind: row.source_kind || "unknown",
    sourcePath: row.source_path || null,
    page: row.agent
      ? path.join("entities", "brainx", "agents", `${slugify(row.agent)}.md`).replace(/\\/g, "/")
      : path.join("entities", "brainx", "contexts", `${row.contextSlug}.md`).replace(/\\/g, "/"),
    domain: row.category || "context",
    topic: row.context || row.agent || row.type,
    category: row.category || "context",
    tags: row.tags,
    importance: Number(row.importance || 0),
    agent: row.agent || null,
    context: row.context || null,
    evidence: [
      {
        kind: "memory",
        id: row.id,
        sourceKind: row.source_kind || "unknown",
        sourcePath: row.source_path || null,
      },
    ],
    freshnessDays: row.ageDays,
    stale: row.stale,
  }));
}

function scoreClaim(claim) {
  const freshnessScore =
    typeof claim.freshnessDays === "number" ? Math.max(0, 30 - claim.freshnessDays) : 10;
  const importanceScore = Number(claim.importance || 0) * 3;
  const confidenceScore = Number(claim.confidence || 0) * 20;
  const knowledgeBoost = claim.kind === "knowledge" ? 24 : 0;
  const decisionBoost = claim.type === "decision" ? 10 : claim.type === "gotcha" ? 8 : 0;
  const stalePenalty = claim.stale ? 12 : 0;
  return knowledgeBoost + importanceScore + confidenceScore + freshnessScore + decisionBoost - stalePenalty;
}

function topClaims(claims, predicate, limit) {
  return claims
    .filter((claim) => (typeof predicate === "function" ? predicate(claim) : true))
    .sort((a, b) => scoreClaim(b) - scoreClaim(a))
    .slice(0, limit);
}

function buildDigestPayload(name, claims, agentMemoryRows, config) {
  const canonical = topClaims(claims, (claim) => claim.kind === "knowledge", config.digestMaxItems);
  const decisions = topClaims(
    claims,
    (claim) => claim.type === "decision" || /decision|decisión|rule|policy|workflow/i.test(String(claim.title || "")),
    config.digestMaxItems,
  );
  const gotchas = topClaims(claims, (claim) => claim.type === "gotcha", config.digestMaxItems);
  const facts = topClaims(claims, (claim) => claim.type === "fact", config.digestMaxItems);
  const agentClaims = topClaims(
    buildMemoryClaims(agentMemoryRows),
    () => true,
    Math.min(4, config.digestMaxItems),
  );

  const payload = {
    kind: name === "shared" ? "shared" : "agent",
    agent: name === "shared" ? null : name,
    generatedAt: nowIso(),
    counts: {
      canonical: canonical.length,
      decisions: decisions.length,
      gotchas: gotchas.length,
      facts: facts.length,
      agentLocal: agentClaims.length,
    },
    highlights: {
      canonical: canonical.map((claim) => ({
        title: claim.title,
        claim: claim.claim,
        page: claim.page,
      })),
      decisions: decisions.map((claim) => ({
        title: claim.title,
        claim: claim.claim,
        page: claim.page,
      })),
      gotchas: gotchas.map((claim) => ({
        title: claim.title,
        claim: claim.claim,
        page: claim.page,
      })),
      facts: facts.map((claim) => ({
        title: claim.title,
        claim: claim.claim,
        page: claim.page,
      })),
      agentLocal: agentClaims.map((claim) => ({
        title: claim.title,
        claim: claim.claim,
        page: claim.page,
      })),
    },
  };

  payload.promptBlock = buildDigestPromptBlock(payload, 900);
  return payload;
}

function buildDigestPromptBlock(payload, maxChars = 900) {
  const lines = [
    "BrainX wiki digest — usa solo lo directamente relevante; si choca con logs/código/estado vivo, manda la evidencia viva.",
  ];

  const groups = [
    ["Canónico", payload?.highlights?.canonical || []],
    ["Decisiones", payload?.highlights?.decisions || []],
    ["Gotchas", payload?.highlights?.gotchas || []],
    ["Hechos", payload?.highlights?.facts || []],
    ["Local", payload?.highlights?.agentLocal || []],
  ];

  for (const [label, items] of groups) {
    if (!Array.isArray(items) || !items.length) continue;
    for (const item of items.slice(0, 2)) {
      lines.push(`- ${label}: ${truncate(item.claim || item.title, 180)}`);
    }
  }

  return truncate(lines.join("\n"), maxChars);
}

function renderKnowledgePage(doc) {
  const frontmatter = renderFrontmatter({
    brainx_kind: "source",
    brainx_source: "knowledge_canonical",
    brainx_relpath: doc.relPath,
    domain: doc.domain,
    topic: doc.topic,
    tags: doc.tags,
    updated_at: new Date(doc.mtimeMs).toISOString(),
  });

  const sectionList = doc.sections.length
    ? ["## Highlights", ...doc.sections.map((section) => `- ${section.title}: ${section.summary}`), ""].join("\n")
    : "";

  return [
    frontmatter,
    `# ${doc.title}`,
    "",
    `> Fuente canónica BrainX: \`${doc.relPath}\``,
    "",
    `## Summary`,
    doc.summary || "Sin resumen suficiente.",
    "",
    sectionList,
    "## Source Body",
    doc.body,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderMemoryList(rows) {
  if (!rows.length) return "_Sin entradas._";
  return rows
    .map((row) => {
      const parts = [
        `- ${truncate(row.content, 220)}`,
        `  - type: ${row.type}`,
        `  - importance: ${row.importance}`,
        `  - verification: ${row.verification_state || "hypothesis"}`,
      ];
      if (row.context) parts.push(`  - context: ${row.context}`);
      if (row.source_kind) parts.push(`  - source: ${row.source_kind}`);
      if (row.source_path) parts.push(`  - source_path: ${truncate(row.source_path, 180)}`);
      return parts.join("\n");
    })
    .join("\n");
}

function renderSynthesisPage(title, intro, rows) {
  return [
    renderFrontmatter({
      brainx_kind: "synthesis",
      brainx_source: "brainx_memories",
      updated_at: nowIso(),
    }),
    `# ${title}`,
    "",
    intro,
    "",
    renderMemoryList(rows),
  ].join("\n");
}

function renderAgentPage(agent, rows) {
  const decisions = rows.filter((row) => row.type === "decision");
  const gotchas = rows.filter((row) => row.type === "gotcha");
  const facts = rows.filter((row) => row.type === "fact");
  return [
    renderFrontmatter({
      brainx_kind: "entity",
      entity_type: "agent",
      entity_id: agent,
      updated_at: nowIso(),
    }),
    `# Agent: ${agent}`,
    "",
    `Resumen durable para \`${agent}\`. Esta página es compilada; la fuente de verdad sigue siendo BrainX DB + knowledge canónico.`,
    "",
    "## Decisions",
    renderMemoryList(decisions),
    "",
    "## Gotchas",
    renderMemoryList(gotchas),
    "",
    "## Facts",
    renderMemoryList(facts),
  ].join("\n");
}

function renderContextPage(context, rows) {
  return [
    renderFrontmatter({
      brainx_kind: "entity",
      entity_type: "context",
      entity_id: context,
      updated_at: nowIso(),
    }),
    `# Context: ${context}`,
    "",
    renderMemoryList(rows),
  ].join("\n");
}

function renderCategoryPage(category, claims) {
  const items = claims
    .slice(0, 60)
    .map((claim) => `- ${truncate(claim.claim, 200)} (${claim.kind}/${claim.sourceKind})`)
    .join("\n");
  return [
    renderFrontmatter({
      brainx_kind: "concept",
      concept_type: "category",
      concept_id: category,
      updated_at: nowIso(),
    }),
    `# Category: ${category}`,
    "",
    items || "_Sin claims._",
  ].join("\n");
}

function renderClaimHealthReport(claims) {
  const byKind = new Map();
  const bySource = new Map();
  const byVerification = new Map();
  for (const claim of claims) {
    byKind.set(claim.kind, (byKind.get(claim.kind) || 0) + 1);
    bySource.set(claim.sourceKind, (bySource.get(claim.sourceKind) || 0) + 1);
    byVerification.set(claim.verificationState, (byVerification.get(claim.verificationState) || 0) + 1);
  }

  const renderMap = (title, map) => [
    `## ${title}`,
    ...[...map.entries()].sort((a, b) => b[1] - a[1]).map(([key, value]) => `- ${key}: ${value}`),
    "",
  ].join("\n");

  return [
    `# BrainX Claim Health`,
    "",
    `Generado: ${nowIso()}`,
    "",
    renderMap("By Kind", byKind),
    renderMap("By Source Kind", bySource),
    renderMap("By Verification", byVerification),
  ].join("\n");
}

function renderLowConfidenceReport(claims, config) {
  const items = claims
    .filter((claim) => Number(claim.confidence || 0) < config.lowConfidenceThreshold)
    .sort((a, b) => Number(a.confidence || 0) - Number(b.confidence || 0))
    .map((claim) => `- ${(claim.confidence || 0).toFixed(2)} | ${truncate(claim.claim, 180)} | ${claim.kind}/${claim.sourceKind}`);
  return [
    "# BrainX Low Confidence",
    "",
    `Threshold: ${config.lowConfidenceThreshold}`,
    "",
    items.length ? items.join("\n") : "_Sin claims por debajo del threshold._",
  ].join("\n");
}

function renderStalePagesReport(docs, rows, config) {
  const items = [];
  for (const doc of docs.filter((entry) => entry.stale)) {
    items.push(`- knowledge | ${doc.relPath} | ${ageDaysFrom(doc.mtimeMs)}d`);
  }
  for (const row of rows.filter((entry) => entry.stale)) {
    items.push(`- memory | ${row.id} | ${row.ageDays}d | ${truncate(row.content, 160)}`);
  }
  return [
    "# BrainX Stale Pages",
    "",
    `Stale after: ${config.staleDays}d`,
    "",
    items.length ? items.join("\n") : "_Sin páginas stale._",
  ].join("\n");
}

function renderOpenQuestionsReport(rows) {
  const items = rows.map((row) => {
    const bits = [
      `- ${truncate(row.content, 200)}`,
      `  - importance: ${row.importance}`,
      `  - status: ${row.status || "pending"}`,
      `  - verification: ${row.verification_state || "hypothesis"}`,
    ];
    if (row.context) bits.push(`  - context: ${row.context}`);
    if (row.agent) bits.push(`  - agent: ${row.agent}`);
    return bits.join("\n");
  });
  return [
    "# BrainX Open Questions",
    "",
    items.length ? items.join("\n") : "_Sin preguntas abiertas._",
  ].join("\n");
}

function renderVaultHome(config, docs, memoryRows, digests) {
  const topics = docs
    .slice(0, 24)
    .map((doc) => `- ${wikiLink(doc.wikiPath, doc.title)} (${doc.domain})`)
    .join("\n");
  const agents = [...new Set(memoryRows.map((row) => row.agent).filter(Boolean))]
    .sort()
    .map((agent) => `- ${wikiLink(path.join("entities", "brainx", "agents", `${slugify(agent)}.md`).replace(/\\/g, "/"), agent)}`)
    .join("\n");
  const digestPreview = truncate(digests.general.promptBlock, 500);

  return [
    renderFrontmatter({
      brainx_kind: "index",
      obsidian_ready: config.obsidianEnabled,
      updated_at: nowIso(),
    }),
    "# BrainX Wiki",
    "",
    "Vault compilado desde `knowledge/` + memorias durables de BrainX. Esta capa es read-mostly y está pensada para curación humana, navegación y digests precompilados.",
    "",
    "## Canonical Topics",
    topics || "_Sin temas canónicos._",
    "",
    "## Agent Pages",
    agents || "_Sin agentes con memorias durables._",
    "",
    "## Reports",
    `- ${wikiLink("reports/brainx/claim-health.md", "Claim Health")}`,
    `- ${wikiLink("reports/brainx/low-confidence.md", "Low Confidence")}`,
    `- ${wikiLink("reports/brainx/stale-pages.md", "Stale Pages")}`,
    `- ${wikiLink("reports/brainx/open-questions.md", "Open Questions")}`,
    "",
    "## Shared Digest Preview",
    "```text",
    digestPreview || "Digest vacío.",
    "```",
  ].join("\n");
}

function isWithin(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function cleanupGeneratedFiles(config, nextGeneratedFiles) {
  const previous = (await readJson(config.generatedFilesPath)) || { files: [] };
  const nextSet = new Set(nextGeneratedFiles);
  for (const oldPath of Array.isArray(previous.files) ? previous.files : []) {
    if (nextSet.has(oldPath)) continue;
    if (!isWithin(config.vaultDir, oldPath) && !isWithin(config.markerDir, oldPath)) continue;
    try {
      await fs.unlink(oldPath);
    } catch {
      // ignore stale cleanup failures
    }
  }
  await writeJson(config.generatedFilesPath, { generatedAt: nowIso(), files: nextGeneratedFiles });
}

async function compileWiki(options = {}) {
  const config = resolveWikiConfig(options);
  await ensureWikiVault(config);

  const [docs, memoryRows, openQuestions] = await Promise.all([
    loadKnowledgeDocs(config),
    loadDurableMemories(config),
    loadOpenQuestions(),
  ]);

  const knowledgeClaims = buildKnowledgeClaims(docs);
  const memoryClaims = buildMemoryClaims(memoryRows);
  const claims = [...knowledgeClaims, ...memoryClaims];
  const generatedFiles = [];

  const generalDigest = buildDigestPayload("shared", claims, [], config);
  const digests = { general: generalDigest, agents: {} };

  for (const doc of docs) {
    const absPath = path.join(config.vaultDir, doc.wikiPath);
    if (!options.dryRun) await writeText(absPath, renderKnowledgePage(doc));
    generatedFiles.push(absPath);
  }

  const synthesisPages = [
    {
      relPath: path.join("syntheses", "brainx", "decisions.md"),
      content: renderSynthesisPage(
        "BrainX Decisions",
        "Decisiones durables priorizadas para uso operativo.",
        memoryRows.filter((row) => row.type === "decision").slice(0, 60),
      ),
    },
    {
      relPath: path.join("syntheses", "brainx", "gotchas.md"),
      content: renderSynthesisPage(
        "BrainX Gotchas",
        "Errores y riesgos ya vistos; útil para troubleshooting y guardrails.",
        memoryRows.filter((row) => row.type === "gotcha").slice(0, 60),
      ),
    },
    {
      relPath: path.join("syntheses", "brainx", "facts.md"),
      content: renderSynthesisPage(
        "BrainX Facts",
        "Hechos durables de alta importancia.",
        memoryRows.filter((row) => row.type === "fact").slice(0, 60),
      ),
    },
    {
      relPath: path.join("syntheses", "brainx", "changelog.md"),
      content: renderSynthesisPage(
        "BrainX Changelog Signals",
        "Cambios recientes verificados como changelog útil.",
        memoryRows.filter((row) => row.verification_state === "changelog").slice(0, 60),
      ),
    },
  ];

  for (const page of synthesisPages) {
    const absPath = path.join(config.vaultDir, page.relPath);
    if (!options.dryRun) await writeText(absPath, page.content);
    generatedFiles.push(absPath);
  }

  const agentNames = [...new Set(memoryRows.map((row) => row.agent).filter(Boolean))].sort();
  for (const agent of agentNames) {
    const rows = memoryRows.filter((row) => row.agent === agent).slice(0, 80);
    const relPath = path.join("entities", "brainx", "agents", `${slugify(agent)}.md`);
    const absPath = path.join(config.vaultDir, relPath);
    if (!options.dryRun) await writeText(absPath, renderAgentPage(agent, rows));
    generatedFiles.push(absPath);
    digests.agents[agent] = buildDigestPayload(agent, claims, rows, config);
  }

  const contexts = [...new Set(memoryRows.map((row) => row.context).filter(Boolean))].sort();
  for (const context of contexts.slice(0, 80)) {
    const rows = memoryRows.filter((row) => row.context === context).slice(0, 60);
    const relPath = path.join("entities", "brainx", "contexts", `${slugify(context)}.md`);
    const absPath = path.join(config.vaultDir, relPath);
    if (!options.dryRun) await writeText(absPath, renderContextPage(context, rows));
    generatedFiles.push(absPath);
  }

  const categories = [...new Set(claims.map((claim) => claim.category).filter(Boolean))].sort();
  for (const category of categories) {
    const relPath = path.join("concepts", "brainx", "categories", `${slugify(category)}.md`);
    const absPath = path.join(config.vaultDir, relPath);
    if (!options.dryRun) await writeText(absPath, renderCategoryPage(category, claims.filter((claim) => claim.category === category)));
    generatedFiles.push(absPath);
  }

  const reportPages = [
    { relPath: path.join("reports", "brainx", "claim-health.md"), content: renderClaimHealthReport(claims) },
    { relPath: path.join("reports", "brainx", "low-confidence.md"), content: renderLowConfidenceReport(claims, config) },
    { relPath: path.join("reports", "brainx", "stale-pages.md"), content: renderStalePagesReport(docs, memoryRows, config) },
    { relPath: path.join("reports", "brainx", "open-questions.md"), content: renderOpenQuestionsReport(openQuestions) },
  ];

  for (const report of reportPages) {
    const absPath = path.join(config.vaultDir, report.relPath);
    if (!options.dryRun) await writeText(absPath, report.content);
    generatedFiles.push(absPath);
  }

  const homePath = path.join(config.vaultDir, "README.md");
  if (!options.dryRun) await writeText(homePath, renderVaultHome(config, docs, memoryRows, digests));
  generatedFiles.push(homePath);

  const claimsJsonl = claims.map((claim) => JSON.stringify(claim)).join("\n");
  const compileStatus = {
    ok: true,
    generatedAt: nowIso(),
    vaultDir: config.vaultDir,
    knowledgeRoot: config.knowledgeRoot,
    counts: {
      knowledgeDocs: docs.length,
      durableMemories: memoryRows.length,
      claims: claims.length,
      agentDigests: Object.keys(digests.agents).length,
      openQuestions: openQuestions.length,
    },
    reports: {
      lowConfidence: claims.filter((claim) => Number(claim.confidence || 0) < config.lowConfidenceThreshold).length,
      stale: docs.filter((doc) => doc.stale).length + memoryRows.filter((row) => row.stale).length,
      openQuestions: openQuestions.length,
    },
    obsidian: {
      enabled: config.obsidianEnabled,
      vaultDir: config.vaultDir,
    },
  };

  if (!options.dryRun) {
    await writeText(config.claimsPath, claimsJsonl);
    await writeJson(config.generalDigestPath, generalDigest);
    generatedFiles.push(config.claimsPath, config.generalDigestPath);

    for (const [agent, payload] of Object.entries(digests.agents)) {
      const digestPath = path.join(config.agentDigestDir, `${slugify(agent)}.json`);
      await writeJson(digestPath, payload);
      generatedFiles.push(digestPath);
    }

    await writeJson(config.compileStatusPath, compileStatus);
    generatedFiles.push(config.compileStatusPath);
    await cleanupGeneratedFiles(config, generatedFiles);
  }

  return compileStatus;
}

async function getWikiStatus(options = {}) {
  const config = resolveWikiConfig(options);
  await ensureWikiVault(config);
  const status = await readJson(config.compileStatusPath);
  const obsidianCli = spawnSync("which", ["obsidian"], { encoding: "utf8" });
  const xdgOpen = spawnSync("which", [config.xdgOpenPath], { encoding: "utf8" });

  return {
    ok: Boolean(status?.ok),
    compiled: Boolean(status?.ok),
    vaultDir: config.vaultDir,
    knowledgeRoot: config.knowledgeRoot,
    generatedAt: status?.generatedAt || null,
    counts: status?.counts || null,
    reports: status?.reports || null,
    obsidian: {
      enabled: config.obsidianEnabled,
      cliAvailable: obsidianCli.status === 0,
      cliPath: obsidianCli.status === 0 ? normalizeWhitespace(obsidianCli.stdout) : null,
      xdgOpenAvailable: xdgOpen.status === 0,
      xdgOpenPath: xdgOpen.status === 0 ? normalizeWhitespace(xdgOpen.stdout) : null,
    },
  };
}

async function lintWiki(options = {}) {
  const config = resolveWikiConfig(options);
  const status = await getWikiStatus(config);
  const issues = [];

  if (!status.compiled) {
    issues.push({ level: "error", code: "not_compiled", message: "BrainX Wiki todavía no se ha compilado." });
  } else {
    const generatedAtMs = Date.parse(String(status.generatedAt || ""));
    const ageDays = ageDaysFrom(generatedAtMs);
    if (typeof ageDays === "number" && ageDays > config.staleDays) {
      issues.push({
        level: "warn",
        code: "compile_stale",
        message: `La compilación del vault tiene ${ageDays}d.`,
      });
    }
    if (!status.counts?.claims) {
      issues.push({ level: "error", code: "empty_claims", message: "El vault no tiene claims compilados." });
    }
    if (!status.counts?.knowledgeDocs) {
      issues.push({ level: "warn", code: "no_knowledge_docs", message: "No se detectaron docs canónicos en knowledge/." });
    }
  }

  if (config.obsidianEnabled && !status.obsidian.cliAvailable && !status.obsidian.xdgOpenAvailable) {
    issues.push({
      level: "info",
      code: "obsidian_not_installed",
      message: "El vault es compatible con Obsidian, pero no hay app/launcher detectado en este host.",
    });
  }

  return {
    ok: !issues.some((issue) => issue.level === "error"),
    issues,
    status,
  };
}

async function readAgentDigest(agentId, options = {}) {
  const config = resolveWikiConfig(options);
  const safeAgent = normalizeWhitespace(agentId);
  const candidatePath = safeAgent
    ? path.join(config.agentDigestDir, `${slugify(safeAgent)}.json`)
    : config.generalDigestPath;
  const fallbackPath = config.generalDigestPath;

  const digest = (await readJson(candidatePath)) || (await readJson(fallbackPath));
  const status = await readJson(config.compileStatusPath);
  if (!digest) {
    return {
      ok: false,
      reason: "digest_unavailable",
      vaultDir: config.vaultDir,
      generatedAt: status?.generatedAt || null,
    };
  }

  return {
    ok: true,
    source: digest.agent ? "agent" : "shared",
    vaultDir: config.vaultDir,
    generatedAt: status?.generatedAt || digest.generatedAt || null,
    digest,
  };
}

async function openObsidian(options = {}) {
  const config = resolveWikiConfig(options);
  await ensureWikiVault(config);

  const status = await getWikiStatus(config);
  if (status.obsidian.cliAvailable) {
    const result = spawnSync("obsidian", [config.vaultDir], {
      stdio: "ignore",
      detached: true,
    });
    return {
      ok: result.status === 0,
      launched: result.status === 0,
      method: "obsidian",
      vaultDir: config.vaultDir,
    };
  }

  if (status.obsidian.xdgOpenAvailable) {
    const result = spawnSync(config.xdgOpenPath, [config.vaultDir], {
      stdio: "ignore",
      detached: true,
    });
    return {
      ok: result.status === 0,
      launched: result.status === 0,
      method: "xdg-open",
      vaultDir: config.vaultDir,
    };
  }

  return {
    ok: false,
    launched: false,
    method: "none",
    vaultDir: config.vaultDir,
    message: "Vault listo, pero no hay launcher Obsidian disponible.",
  };
}

module.exports = {
  resolveWikiConfig,
  ensureWikiVault,
  compileWiki,
  getWikiStatus,
  lintWiki,
  readAgentDigest,
  buildDigestPromptBlock,
  openObsidian,
};
