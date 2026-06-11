const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const {
  containsSecretLike,
  hashId,
  normalizeText,
  toSlug,
} = require('./skill-promotion');
const lifecycle = require('./skill-lifecycle');

const DEFAULT_REGEN_SCRIPT = '/home/clawd/.openclaw/skills/agent-core/scripts/regen-references.sh';
const CRITICAL_SKILLS = new Set([
  'agent-core',
  'brainx',
  'gws',
  'openclaw-runtime',
]);

const PATCH_RISKY_RE = /\b(secret|token|password|credential|credencial|api[_-]?key|auth|oauth|permission|permiso|sudo|root|production|producci[oó]n|database|db|delete|destructive|destructivo|drop|truncate|security|seguridad|policy|pol[ií]tica|core|gateway|runtime|hook)\b/i;

function parseFrontmatter(markdown) {
  const text = String(markdown || '');
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const data = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (key) data[key] = value;
  }
  return data;
}

function ensureValidDraftSkill(candidate) {
  const draft = normalizeText(candidate && candidate.draftSkillMd);
  if (!draft.startsWith('---')) throw new Error('candidate draft SKILL.md is missing YAML frontmatter');
  if (containsSecretLike(draft)) throw new Error('candidate draft looks like it contains a secret or credential');
  const fm = parseFrontmatter(draft);
  const name = String(fm.name || candidate.skillName || '').trim();
  if (!name) throw new Error('candidate draft is missing frontmatter name');
  const slug = toSlug(candidate.skillName || name);
  if (toSlug(name) !== slug) {
    throw new Error('candidate name mismatch: frontmatter name ' + JSON.stringify(name) + ' does not match ' + slug);
  }
  const description = String(fm.description || '').trim();
  if (!description || description.length < 24) throw new Error('candidate draft needs a useful description');
  return {
    skillName: slug,
    frontmatterName: name,
    draftSkillMd: draft.trimEnd() + '\n',
  };
}

function extractDraftFromCandidateFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const fence = text.match(/~~~markdown\n([\s\S]*?)\n~~~/);
  const draftSkillMd = fence ? fence[1] : text;
  const fm = parseFrontmatter(draftSkillMd);
  const heading = text.match(/^# Skill Candidate:\s*(.+)$/m);
  const action = text.match(/^- Action:\s*(.+)$/m);
  const sourceLine = text.match(/^- Sources:\s*(.+)$/m);
  const skillName = toSlug(fm.name || (heading && heading[1]) || path.basename(filePath).replace(/\.candidate\.md$/, ''));
  return {
    id: hashId('skillcand_file', path.resolve(filePath) + '|' + draftSkillMd),
    skillName,
    title: skillName,
    action: action ? action[1].trim() : 'create_new_skill',
    confidence: 1,
    recurrence: 1,
    sourceIds: sourceLine ? sourceLine[1].split(',').map((s) => s.trim()).filter(Boolean) : [path.resolve(filePath)],
    patternKeys: [],
    memoryIds: [],
    instructions: [],
    draftSkillMd,
  };
}

function runCommand(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: Number(options.timeoutMs || 60000),
    cwd: options.cwd || process.cwd(),
  });
}

function looksLikeOpenClawSkillCheck(output) {
  return /Skills Status Check/i.test(String(output || ''));
}

function assertSkillVisibleInCheck(skillName, output) {
  if (!skillName || !looksLikeOpenClawSkillCheck(output)) return;
  const text = String(output || '');
  const needle = String(skillName).toLowerCase();
  const needleSlug = toSlug(skillName);
  const listed = text
    .split(/\r?\n/)
    .some((line) => {
      const clean = line.trim().toLowerCase();
      if (!clean) return false;
      if (clean.includes(needle)) return true;
      return toSlug(clean).includes(needleSlug);
    });
  if (!listed) throw new Error('openclaw skills check did not list skill as visible/eligible: ' + skillName);
}

function runValidation(options = {}) {
  const runner = options.runCommand || runCommand;
  const skillsRoot = options.skillsRoot || lifecycle.defaultSkillsRoot();
  const openclawBin = options.openclawBin || process.env.OPENCLAW_BIN || 'openclaw';
  const regenScript = options.regenScript === undefined ? DEFAULT_REGEN_SCRIPT : options.regenScript;
  const skillName = options.skillName;
  const checks = [];

  if (regenScript && fs.existsSync(regenScript)) {
    const regenOutput = runner(regenScript, ['skills', '--apply'], {
      cwd: path.dirname(regenScript),
      timeoutMs: options.timeoutMs,
    });
    checks.push({ command: regenScript + ' skills --apply', output: String(regenOutput || '').slice(0, 4000) });
  } else {
    checks.push({ command: String(regenScript || 'regen-references.sh') + ' skills --apply', skipped: true });
  }

  const skillCheckOutput = runner(openclawBin, ['skills', 'check'], {
    cwd: skillsRoot,
    timeoutMs: options.timeoutMs,
  });
  assertSkillVisibleInCheck(skillName, skillCheckOutput);
  checks.push({ command: openclawBin + ' skills check', output: String(skillCheckOutput || '').slice(0, 4000) });

  return checks;
}

function defaultAuditDir(root) {
  return path.join(root || lifecycle.defaultSkillsRoot(), '.brainx-skill-applies');
}

function compactValidation(checks) {
  return (checks || []).map((check) => ({
    command: check.command,
    skipped: check.skipped === true ? true : undefined,
  }));
}

function classifyPatchRisk(candidate, options = {}) {
  const skillName = toSlug(candidate && candidate.skillName);
  const action = candidate && candidate.action;
  const instructions = (candidate && candidate.instructions || [])
    .map((instruction) => normalizeText(instruction))
    .filter(Boolean);
  const text = normalizeText([
    candidate && candidate.title,
    candidate && candidate.draftSkillMd,
    ...instructions,
  ].filter(Boolean).join('\n'));
  const reasons = [];

  if (action !== 'extend_existing_skill') {
    return { level: 'blocked', allowed: false, reasons: ['not_existing_skill_patch'] };
  }
  if (!skillName) {
    return { level: 'blocked', allowed: false, reasons: ['missing_skill_name'] };
  }
  if (CRITICAL_SKILLS.has(skillName)) {
    reasons.push('critical_skill');
  }
  if (containsSecretLike(text)) {
    reasons.push('secret_like_content');
  }
  if (PATCH_RISKY_RE.test(text)) {
    reasons.push('risky_terms');
  }
  if (instructions.length === 0) {
    reasons.push('missing_instructions');
  }
  if (instructions.length > Number(options.maxInstructions || 6)) {
    reasons.push('too_many_instructions');
  }
  if (text.length > Number(options.maxChars || 4000)) {
    reasons.push('patch_too_large');
  }

  if (reasons.includes('critical_skill') || reasons.includes('secret_like_content')) {
    return { level: 'high', allowed: false, reasons };
  }
  if (reasons.length) {
    return { level: 'medium', allowed: false, reasons };
  }
  return { level: 'low', allowed: true, reasons: ['append_only_brainx_promoted_workflow'] };
}

function writeApplyAudit(candidate, result, options = {}) {
  if (options.auditDir === false) return null;
  const root = options.skillsRoot || options.root || lifecycle.defaultSkillsRoot();
  const auditDir = options.auditDir || defaultAuditDir(root);
  fs.mkdirSync(auditDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const skillName = toSlug(result.skillName || candidate.skillName || 'skill');
  const auditId = hashId('audit', JSON.stringify({
    id: candidate.id,
    sourceIds: candidate.sourceIds,
    action: result.action,
  })).slice(0, 10);
  const file = path.join(auditDir, stamp + '-' + skillName + '-' + auditId + '.json');
  const payload = {
    created_at: new Date().toISOString(),
    tool: 'brainx-skill-promoter',
    candidate: {
      id: candidate.id || null,
      skillName,
      action: candidate.action || result.action,
      confidence: candidate.confidence,
      recurrence: candidate.recurrence,
      sourceCount: candidate.sourceCount,
      sourceIds: candidate.sourceIds || [],
      sourceKinds: candidate.sourceKinds || [],
      sourceSessions: candidate.sourceSessions || [],
      brainxConfirmations: candidate.brainxConfirmations || [],
      brainxConfirmed: candidate.brainxConfirmed === true,
      instructions: candidate.instructions || [],
    },
    result: {
      ok: result.ok === true,
      dryRun: result.dryRun === true,
      skillName: result.skillName,
      action: result.action,
      patchRisk: result.patchRisk || null,
      skillDir: result.skillDir,
      filesChanged: result.filesChanged || [],
      validation: compactValidation(result.validation),
    },
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return file;
}

function buildPromotedBlock(candidate) {
  const marker = candidate.id || hashId('skillcand', candidate.skillName + '|' + (candidate.sourceIds || []).join(','));
  const lines = [];
  lines.push('## BrainX-Promoted Workflow');
  lines.push('');
  lines.push('<!-- BRAINX-SKILL-PROMOTER:' + marker + ':start -->');
  lines.push('Source: BrainX skill-promoter');
  lines.push('Candidate: ' + candidate.skillName);
  if (candidate.confidence !== undefined) lines.push('Confidence: ' + candidate.confidence);
  if (candidate.recurrence !== undefined) lines.push('Recurrence: ' + candidate.recurrence + 'x');
  if (candidate.sourceIds && candidate.sourceIds.length) lines.push('Sources: ' + candidate.sourceIds.join(', '));
  lines.push('');
  lines.push('Use these additions only when they match the existing skill trigger.');
  lines.push('');
  for (const instruction of candidate.instructions || []) {
    const clean = String(instruction || '').trim();
    if (clean) lines.push(clean.startsWith('- ') ? clean : '- ' + clean);
  }
  lines.push('<!-- BRAINX-SKILL-PROMOTER:' + marker + ':end -->');
  lines.push('');
  return { marker, block: lines.join('\n') };
}

function patchExistingSkill(skillMd, candidate) {
  const current = fs.readFileSync(skillMd, 'utf8');
  const { marker, block } = buildPromotedBlock(candidate);
  const start = '<!-- BRAINX-SKILL-PROMOTER:' + marker + ':start -->';
  const end = '<!-- BRAINX-SKILL-PROMOTER:' + marker + ':end -->';
  const startIdx = current.indexOf(start);
  const endIdx = current.indexOf(end);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const headerIdx = current.lastIndexOf('## BrainX-Promoted Workflow', startIdx);
    const before = current.slice(0, headerIdx === -1 ? startIdx : headerIdx);
    const after = current.slice(endIdx + end.length);
    return before.trimEnd() + '\n\n' + block.trimEnd() + '\n' + after.replace(/^\n+/, '');
  }

  return current.trimEnd() + '\n\n' + block.trimEnd() + '\n';
}

function rollbackCreate(skillDir, skillName, root) {
  fs.rmSync(skillDir, { recursive: true, force: true });
  lifecycle.forget(skillName, { root });
}

function applyCandidate(candidate, options = {}) {
  const root = options.skillsRoot || options.root || lifecycle.defaultSkillsRoot();
  const allowExistingPatch = Boolean(options.allowExistingPatch);
  const dryRun = Boolean(options.dryRun);
  const validate = options.validate !== false;
  const validatedDraft = ensureValidDraftSkill(candidate);
  const skillName = validatedDraft.skillName;
  const existingDir = lifecycle.findSkillDir(skillName, { root });
  const action = candidate.action || (existingDir ? 'extend_existing_skill' : 'create_new_skill');
  const planned = [];

  if (action === 'extend_existing_skill') {
    if (!existingDir) throw new Error('cannot patch existing skill; skill not found: ' + skillName);
    if (!allowExistingPatch) {
      return {
        ok: true,
        skipped: true,
        reason: 'existing skill patch requires --allow-existing-patch',
        skillName,
        action,
      };
    }
    const skillMd = path.join(existingDir, 'SKILL.md');
    const patchRisk = classifyPatchRisk(candidate);
    planned.push({ type: 'patch', path: skillMd });
    if (dryRun) return { ok: true, dryRun: true, skillName, action, planned, patchRisk };

    const backup = fs.readFileSync(skillMd, 'utf8');
    try {
      fs.writeFileSync(skillMd, patchExistingSkill(skillMd, candidate), 'utf8');
      lifecycle.bumpPatch(skillName, { root });
      const checks = validate ? runValidation({ ...options, skillsRoot: root, skillName }) : [];
      const result = { ok: true, skillName, action, patchRisk, skillDir: existingDir, filesChanged: [skillMd], validation: checks };
      result.auditFile = writeApplyAudit(candidate, result, { ...options, skillsRoot: root });
      return result;
    } catch (err) {
      fs.writeFileSync(skillMd, backup, 'utf8');
      throw err;
    }
  }

  if (existingDir) throw new Error('cannot create skill; destination already exists for ' + skillName);
  const skillDir = path.join(root, skillName);
  const skillMd = path.join(skillDir, 'SKILL.md');
  planned.push({ type: 'create', path: skillMd });
  if (dryRun) return { ok: true, dryRun: true, skillName, action: 'create_new_skill', planned };

  fs.mkdirSync(skillDir, { recursive: true });
  try {
    fs.writeFileSync(skillMd, validatedDraft.draftSkillMd, 'utf8');
    lifecycle.markBrainxCreated(skillName, {
      candidateId: candidate.id,
      sourceIds: candidate.sourceIds || [],
      skillDir,
    }, { root });
    const checks = validate ? runValidation({ ...options, skillsRoot: root, skillName }) : [];
    const result = { ok: true, skillName, action: 'create_new_skill', skillDir, filesChanged: [skillMd], validation: checks };
    result.auditFile = writeApplyAudit(candidate, result, { ...options, skillsRoot: root });
    return result;
  } catch (err) {
    rollbackCreate(skillDir, skillName, root);
    throw err;
  }
}

module.exports = {
  DEFAULT_REGEN_SCRIPT,
  parseFrontmatter,
  ensureValidDraftSkill,
  extractDraftFromCandidateFile,
  runValidation,
  writeApplyAudit,
  buildPromotedBlock,
  patchExistingSkill,
  classifyPatchRisk,
  applyCandidate,
};
