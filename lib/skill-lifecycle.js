const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_ACTIVE = 'active';
const STATE_STALE = 'stale';
const STATE_ARCHIVED = 'archived';
const VALID_STATES = new Set([STATE_ACTIVE, STATE_STALE, STATE_ARCHIVED]);

function defaultSkillsRoot() {
  return process.env.BRAINX_SKILLS_ROOT || path.join(os.homedir(), '.openclaw', 'skills');
}

function usageFile(root = defaultSkillsRoot()) {
  return path.join(root, '.brainx-skill-usage.json');
}

function archiveDir(root = defaultSkillsRoot()) {
  return path.join(root, '.brainx-archive');
}

function nowIso() {
  return new Date().toISOString();
}

function toSlug(value, fallback = 'skill') {
  const raw = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return (raw || fallback).slice(0, 64).replace(/-+$/g, '') || fallback;
}

function emptyRecord() {
  return {
    created_by: null,
    brainx_created: false,
    provenance: null,
    autopatchable: false,
    source: null,
    candidate_id: null,
    source_ids: [],
    skill_dir: null,
    use_count: 0,
    view_count: 0,
    patch_count: 0,
    last_used_at: null,
    last_viewed_at: null,
    last_patched_at: null,
    created_at: nowIso(),
    state: STATE_ACTIVE,
    pinned: false,
    archived_at: null,
  };
}

function loadUsage(root = defaultSkillsRoot()) {
  const file = usageFile(root);
  if (!fs.existsSync(file)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const clean = {};
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) clean[key] = value;
    }
    return clean;
  } catch (_) {
    return {};
  }
}

function saveUsage(data, root = defaultSkillsRoot()) {
  const file = usageFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), '.brainx-skill-usage-' + process.pid + '-' + Date.now() + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function withDefaults(record) {
  return { ...emptyRecord(), ...(record && typeof record === 'object' ? record : {}) };
}

function getRecord(skillName, options = {}) {
  const root = options.root || defaultSkillsRoot();
  const data = loadUsage(root);
  return withDefaults(data[skillName]);
}

function mutateRecord(skillName, mutator, options = {}) {
  if (!skillName) return null;
  const root = options.root || defaultSkillsRoot();
  const data = loadUsage(root);
  const record = withDefaults(data[skillName]);
  mutator(record);
  data[skillName] = record;
  saveUsage(data, root);
  return record;
}

function forget(skillName, options = {}) {
  if (!skillName) return;
  const root = options.root || defaultSkillsRoot();
  const data = loadUsage(root);
  if (data[skillName]) {
    delete data[skillName];
    saveUsage(data, root);
  }
}

function isBrainxCreated(skillName, options = {}) {
  const record = getRecord(skillName, options);
  return record.created_by === 'brainx' || record.brainx_created === true;
}

function isAutopatchable(skillName, options = {}) {
  const record = getRecord(skillName, options);
  if (record.pinned || record.state === STATE_ARCHIVED) return false;
  return isBrainxCreated(skillName, options) || record.autopatchable === true;
}

function markBrainxCreated(skillName, metadata = {}, options = {}) {
  return mutateRecord(skillName, (record) => {
    record.created_by = 'brainx';
    record.brainx_created = true;
    record.provenance = metadata.provenance || record.provenance || 'agent-created';
    record.source = metadata.source || record.source || 'brainx-skill-promoter';
    record.candidate_id = metadata.candidateId || metadata.candidate_id || record.candidate_id || null;
    record.source_ids = Array.isArray(metadata.sourceIds) ? metadata.sourceIds : (record.source_ids || []);
    record.skill_dir = metadata.skillDir || metadata.skill_dir || record.skill_dir || null;
    record.last_patched_at = nowIso();
    record.patch_count = Number(record.patch_count || 0) + 1;
  }, options);
}

function setPinned(skillName, pinned, options = {}) {
  return mutateRecord(skillName, (record) => {
    record.pinned = Boolean(pinned);
  }, options);
}

function setAutopatchable(skillName, autopatchable, options = {}) {
  return mutateRecord(skillName, (record) => {
    record.autopatchable = Boolean(autopatchable);
  }, options);
}

function setState(skillName, state, options = {}) {
  if (!VALID_STATES.has(state)) return null;
  return mutateRecord(skillName, (record) => {
    record.state = state;
    if (state === STATE_ARCHIVED) record.archived_at = nowIso();
    if (state === STATE_ACTIVE) record.archived_at = null;
  }, options);
}

function bumpPatch(skillName, options = {}) {
  return mutateRecord(skillName, (record) => {
    record.patch_count = Number(record.patch_count || 0) + 1;
    record.last_patched_at = nowIso();
  }, options);
}

function bumpUse(skillName, options = {}) {
  return mutateRecord(skillName, (record) => {
    record.use_count = Number(record.use_count || 0) + 1;
    record.last_used_at = nowIso();
  }, options);
}

function bumpView(skillName, options = {}) {
  return mutateRecord(skillName, (record) => {
    record.view_count = Number(record.view_count || 0) + 1;
    record.last_viewed_at = nowIso();
  }, options);
}

function parseIso(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function latestActivityAt(record) {
  let latest = null;
  for (const key of ['last_used_at', 'last_viewed_at', 'last_patched_at']) {
    const parsed = parseIso(record[key]);
    if (!parsed) continue;
    if (!latest || parsed.getTime() > latest.getTime()) latest = parsed;
  }
  return latest ? latest.toISOString() : null;
}

function activityCount(record) {
  return ['use_count', 'view_count', 'patch_count'].reduce((sum, key) => {
    const value = Number(record[key] || 0);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
}

function readSkillName(skillMd, fallback) {
  try {
    const text = fs.readFileSync(skillMd, 'utf8').slice(0, 4000);
    let inFrontmatter = false;
    for (const line of text.split('\n')) {
      const stripped = line.trim();
      if (stripped === '---') {
        if (inFrontmatter) break;
        inFrontmatter = true;
        continue;
      }
      if (inFrontmatter && stripped.startsWith('name:')) {
        const value = stripped.split(':').slice(1).join(':').trim().replace(/^["']|["']$/g, '');
        if (value) return value;
      }
    }
  } catch (_) {}
  return fallback;
}

function shouldSkipDir(name) {
  return (
    name === '.git'
    || name === 'node_modules'
    || name === '.brainx-archive'
    || name === '_retired'
    || name.startsWith('.')
  );
}

function findSkillDir(skillName, options = {}) {
  const root = options.root || defaultSkillsRoot();
  if (!fs.existsSync(root)) return null;
  const wanted = String(skillName || '').trim();
  const wantedSlug = toSlug(wanted);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    const skillMd = path.join(dir, 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      const name = readSkillName(skillMd, path.basename(dir));
      if (name === wanted || toSlug(name) === wantedSlug || path.basename(dir) === wanted) {
        return dir;
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || shouldSkipDir(entry.name)) continue;
      stack.push(path.join(dir, entry.name));
    }
  }
  return null;
}

function listArchivedSkillNames(options = {}) {
  const dir = archiveDir(options.root || defaultSkillsRoot());
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function brainxCreatedReport(options = {}) {
  const root = options.root || defaultSkillsRoot();
  const data = loadUsage(root);
  return Object.entries(data)
    .filter(([, record]) => record && (record.created_by === 'brainx' || record.brainx_created === true))
    .map(([name, raw]) => {
      const record = withDefaults(raw);
      const row = { name, ...record };
      row.last_activity_at = latestActivityAt(row);
      row.activity_count = activityCount(row);
      row.exists = Boolean(findSkillDir(name, { root })) || row.state === STATE_ARCHIVED;
      return row;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function moveDir(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (_) {
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

function archiveSkill(skillName, options = {}) {
  const root = options.root || defaultSkillsRoot();
  if (!isBrainxCreated(skillName, { root })) {
    return { ok: false, message: "skill '" + skillName + "' is not brainx-created; refusing to archive" };
  }
  const dir = findSkillDir(skillName, { root });
  if (!dir) return { ok: false, message: "skill '" + skillName + "' not found" };

  const archiveRoot = archiveDir(root);
  fs.mkdirSync(archiveRoot, { recursive: true });
  let dest = path.join(archiveRoot, path.basename(dir));
  if (fs.existsSync(dest)) {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    dest = path.join(archiveRoot, path.basename(dir) + '-' + stamp);
  }
  try {
    moveDir(dir, dest);
    setState(skillName, STATE_ARCHIVED, { root });
    return { ok: true, message: 'archived to ' + dest, path: dest };
  } catch (err) {
    return { ok: false, message: 'failed to archive: ' + (err.message || err) };
  }
}

function restoreSkill(skillName, options = {}) {
  const root = options.root || defaultSkillsRoot();
  if (!isBrainxCreated(skillName, { root })) {
    return { ok: false, message: "skill '" + skillName + "' is not brainx-created; refusing to restore" };
  }
  const archiveRoot = archiveDir(root);
  if (!fs.existsSync(archiveRoot)) return { ok: false, message: 'no archive directory' };
  const wanted = String(skillName || '').trim();
  const candidates = fs.readdirSync(archiveRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (entry.name === wanted || entry.name.startsWith(wanted + '-')))
    .map((entry) => path.join(archiveRoot, entry.name))
    .sort()
    .reverse();
  if (!candidates.length) return { ok: false, message: "skill '" + skillName + "' not found in archive" };
  const dest = path.join(root, wanted);
  if (fs.existsSync(dest)) return { ok: false, message: 'destination already exists: ' + dest };
  try {
    moveDir(candidates[0], dest);
    setState(skillName, STATE_ACTIVE, { root });
    return { ok: true, message: 'restored to ' + dest, path: dest };
  } catch (err) {
    return { ok: false, message: 'failed to restore: ' + (err.message || err) };
  }
}

function applyAutomaticTransitions(options = {}) {
  const root = options.root || defaultSkillsRoot();
  const now = options.now ? new Date(options.now) : new Date();
  const staleAfterDays = Number(options.staleAfterDays || process.env.BRAINX_SKILL_CURATOR_STALE_DAYS || 30);
  const archiveAfterDays = Number(options.archiveAfterDays || process.env.BRAINX_SKILL_CURATOR_ARCHIVE_DAYS || 90);
  const staleCutoff = now.getTime() - staleAfterDays * 24 * 60 * 60 * 1000;
  const archiveCutoff = now.getTime() - archiveAfterDays * 24 * 60 * 60 * 1000;
  const counts = { checked: 0, marked_stale: 0, archived: 0, reactivated: 0 };

  for (const row of brainxCreatedReport({ root })) {
    counts.checked += 1;
    if (row.pinned) continue;
    const anchor = parseIso(row.last_activity_at) || parseIso(row.created_at) || now;
    const current = row.state || STATE_ACTIVE;
    if (anchor.getTime() <= archiveCutoff && current !== STATE_ARCHIVED) {
      const result = archiveSkill(row.name, { root });
      if (result.ok) counts.archived += 1;
    } else if (anchor.getTime() <= staleCutoff && current === STATE_ACTIVE) {
      setState(row.name, STATE_STALE, { root });
      counts.marked_stale += 1;
    } else if (anchor.getTime() > staleCutoff && current === STATE_STALE) {
      setState(row.name, STATE_ACTIVE, { root });
      counts.reactivated += 1;
    }
  }

  return counts;
}

module.exports = {
  STATE_ACTIVE,
  STATE_STALE,
  STATE_ARCHIVED,
  defaultSkillsRoot,
  usageFile,
  archiveDir,
  loadUsage,
  saveUsage,
  getRecord,
  markBrainxCreated,
  isBrainxCreated,
  isAutopatchable,
  setPinned,
  setAutopatchable,
  setState,
  bumpPatch,
  bumpUse,
  bumpView,
  forget,
  readSkillName,
  findSkillDir,
  listArchivedSkillNames,
  brainxCreatedReport,
  archiveSkill,
  restoreSkill,
  applyAutomaticTransitions,
  latestActivityAt,
  activityCount,
};
