const fs = require('fs');

const CANONICAL_RULES_FILE = process.env.BRAINX_PROMOTION_REFERENCE_FILE
  || '/home/clawd/.openclaw/skills/agent-core/references/BRAINX_PROMOTED_RULES.md';

const TARGETS = {
  workflow: {
    heading: 'Workflow & Execution',
    description: 'workflow rules, execution patterns, delegation patterns, project-specific operational decisions',
    startMarker: '<!-- BRAINX-PROMOTED:workflow:start -->',
    endMarker: '<!-- BRAINX-PROMOTED:workflow:end -->',
  },
  tools: {
    heading: 'Tools & Infrastructure',
    description: 'CLI/API patterns, infrastructure configs, integration gotchas, environment/tooling rules',
    startMarker: '<!-- BRAINX-PROMOTED:tools:start -->',
    endMarker: '<!-- BRAINX-PROMOTED:tools:end -->',
  },
  behavior: {
    heading: 'Behavior & Tone',
    description: 'behavioral patterns, style rules, communication and tone guidance',
    startMarker: '<!-- BRAINX-PROMOTED:behavior:start -->',
    endMarker: '<!-- BRAINX-PROMOTED:behavior:end -->',
  },
};

function normalizeTargetKey(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return 'workflow';
  if (value === 'agents.md' || value === 'workflow' || value === 'workflow & execution') return 'workflow';
  if (value === 'tools.md' || value === 'tools' || value === 'tools & infrastructure') return 'tools';
  if (value === 'soul.md' || value === 'behavior' || value === 'behavior & tone') return 'behavior';
  return 'workflow';
}

function targetKeyToPromotedTo(targetKey) {
  return `brainx_promoted_rules:${normalizeTargetKey(targetKey)}`;
}

function extractRule(content) {
  const match = String(content || '').match(/Rule:\s*([\s\S]*?)(?:\nReason:|\nRecurrence:|\nSource:|$)/i);
  return (match?.[1] || content || '').replace(/\s+/g, ' ').trim();
}

function extractSourcePatternKey(content) {
  const match = String(content || '').match(/Source:\s*pattern\s*\(([^)]+)\)/i);
  return match?.[1] ? String(match[1]).trim() : null;
}

function normalizeRule(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/^- /, '')
    .replace(/\[×\d+\]\s*/g, '')
    .replace(/[`*_>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSuggestionMetadata(content) {
  const arrowMatch = String(content || '').match(/→\s*([^\n]+)/);
  const sectionMatch = String(content || '').match(/Section:\s*([^\n]+)/);
  return {
    targetKey: normalizeTargetKey(sectionMatch?.[1] || arrowMatch?.[1]),
    rule: extractRule(content),
    sourcePatternKey: extractSourcePatternKey(content),
  };
}

function isLowSignalPromotionRule(rule) {
  const raw = String(rule || '').trim();
  const normalized = normalizeRule(rule);
  if (!normalized) return true;
  if (/\[promotion suggestion\]/i.test(raw) || /→/.test(raw)) return true;
  if (normalized.length < 30) return true;
  return false;
}

function readCanonicalRules(filePath = CANONICAL_RULES_FILE) {
  const sections = {};
  for (const [key, target] of Object.entries(TARGETS)) {
    sections[key] = {
      heading: target.heading,
      rules: [],
      normalizedRules: [],
      markersPresent: false,
    };
  }

  if (!fs.existsSync(filePath)) {
    return {
      exists: false,
      filePath,
      updatedAt: null,
      sections,
    };
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const updatedMatch = content.match(/\*\*Updated:\*\*\s*([^\n]+)/);
  for (const [key, target] of Object.entries(TARGETS)) {
    const startIdx = content.indexOf(target.startMarker);
    const endIdx = content.indexOf(target.endMarker);
    if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) continue;

    const body = content.slice(startIdx + target.startMarker.length, endIdx);
    const rules = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '));

    sections[key] = {
      heading: target.heading,
      rules,
      normalizedRules: rules.map((line) => normalizeRule(line)),
      markersPresent: true,
    };
  }

  return {
    exists: true,
    filePath,
    updatedAt: updatedMatch?.[1] ? updatedMatch[1].trim() : null,
    sections,
  };
}

function findCanonicalRuleMatch(rule, canonical, targetKey = null) {
  const normalized = normalizeRule(rule);
  if (!normalized || !canonical?.sections) return null;

  const firstKey = targetKey ? normalizeTargetKey(targetKey) : null;
  const searchKeys = firstKey
    ? [firstKey, ...Object.keys(canonical.sections).filter((key) => key !== firstKey)]
    : Object.keys(canonical.sections);

  for (const key of searchKeys) {
    const section = canonical.sections[key];
    if (!section) continue;
    for (let i = 0; i < section.normalizedRules.length; i++) {
      const candidate = section.normalizedRules[i];
      if (!candidate) continue;
      if (candidate === normalized || candidate.includes(normalized) || normalized.includes(candidate)) {
        return {
          targetKey: key,
          rawRule: section.rules[i],
          normalizedRule: candidate,
        };
      }
    }
  }

  return null;
}

module.exports = {
  CANONICAL_RULES_FILE,
  TARGETS,
  normalizeTargetKey,
  targetKeyToPromotedTo,
  extractRule,
  extractSourcePatternKey,
  extractSuggestionMetadata,
  normalizeRule,
  isLowSignalPromotionRule,
  readCanonicalRules,
  findCanonicalRuleMatch,
};
