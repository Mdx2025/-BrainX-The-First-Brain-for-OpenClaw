'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const R = require('../scripts/reconcile-contradictions.js');

test('provenanceRank orders sources like the recall scorer (higher = more authoritative)', () => {
  assert.ok(R.provenanceRank('tool_verified') > R.provenanceRank('agent_inference'));
  assert.ok(R.provenanceRank('knowledge_canonical') >= R.provenanceRank('user_explicit'));
  assert.equal(R.provenanceRank('totally_unknown_kind'), 2); // safe default
  assert.equal(R.provenanceRank(null), 2);
});

test('nextTier walks the descent ladder and never removes the row', () => {
  assert.equal(R.nextTier('hot'), 'warm');
  assert.equal(R.nextTier('warm'), 'cold');
  assert.equal(R.nextTier('cold'), 'archive');
  assert.equal(R.nextTier('archive'), 'archive');
  assert.equal(R.nextTier('bogus'), 'warm'); // safe fallback, never null/delete
});

test('parseArgs clamps out-of-range values to safe defaults; never throws', () => {
  const c = R.parseArgs(['node', 'x', '--min-sim', '9', '--max-pairs', '-3', '--min-confidence', '2']);
  assert.equal(c.minSim, 0.82);
  assert.equal(c.maxPairs, 24);
  assert.equal(c.minConfidence, 0.75);
  assert.equal(c.apply, false); // dry-run is the default
  const c2 = R.parseArgs(['node', 'x', '--apply', '--min-sim', '0.9', '--max-pairs', '10']);
  assert.equal(c2.apply, true);
  assert.equal(c2.minSim, 0.9);
  assert.equal(c2.maxPairs, 10);
});

test('decideAction: autonomous default is FLAG-ONLY even for a strong high-confidence supersede', () => {
  // allowSupersede defaults false → never destructive without an operator opting in
  const a = R.decideAction({ b_src: 'tool_verified', a_src: 'agent_inference', b_id: 'B1', a_tier: 'hot' }, { confidence: 0.95 });
  assert.equal(a.kind, 'flag');
  assert.equal(a.set.verification_state, 'hypothesis');
  assert.ok(!('superseded_by' in a.set));
});

test('decideAction: --allow-supersede + high confidence + stronger challenger hard-supersedes', () => {
  const a = R.decideAction({ b_src: 'tool_verified', a_src: 'agent_inference', b_id: 'B1', a_tier: 'hot' }, { confidence: 0.95 }, true);
  assert.equal(a.kind, 'supersede');
  assert.equal(a.set.verification_state, 'obsolete');
  assert.equal(a.set.superseded_by, 'B1');
  assert.equal(a.set.tier, 'archive');
});

test('decideAction: even with --allow-supersede, medium confidence only flags', () => {
  const a = R.decideAction({ b_src: 'tool_verified', a_src: 'agent_inference', b_id: 'B1', a_tier: 'hot' }, { confidence: 0.82 }, true);
  assert.equal(a.kind, 'flag');
  assert.equal(a.set.verification_state, 'hypothesis');
  assert.ok(!('superseded_by' in a.set));
});

test('decideAction: weaker challenger only demote-and-flags (strips verified, never obsoletes on weak evidence)', () => {
  const a = R.decideAction({ b_src: 'summary_derived', a_src: 'tool_verified', b_id: 'B2', a_tier: 'hot' }, { confidence: 0.99 }, true);
  assert.equal(a.kind, 'flag');
  assert.equal(a.set.verification_state, 'hypothesis');
  assert.equal(a.set.tier, 'warm'); // one step down from hot
  assert.ok(!('superseded_by' in a.set)); // stays live, not obsoleted
});

test('decideAction: knowledge_canonical incumbent is REVIEW-ONLY (curated knowledge never auto-degraded, even with --allow-supersede)', () => {
  const a = R.decideAction({ b_src: 'tool_verified', a_src: 'knowledge_canonical', b_id: 'B3', a_tier: 'hot' }, { confidence: 0.99 }, true);
  assert.equal(a.kind, 'review');
  assert.deepEqual(a.set, {}); // no state/tier change
});

test('parseJudgeVerdict tolerates fences/prose and normalizes unknown relations to coexist', () => {
  const ok = R.parseJudgeVerdict('```json\n{"relation":"supersedes","attribute":"host","confidence":0.9}\n```', require('../lib/agent-llm.js').extractJson);
  assert.equal(ok.relation, 'supersedes');
  assert.equal(ok.confidence, 0.9);
  const junk = R.parseJudgeVerdict('the model rambled with no json', require('../lib/agent-llm.js').extractJson);
  assert.equal(junk.relation, 'coexist'); // safe: no action
  assert.equal(junk.confidence, 0);
  const weird = R.parseJudgeVerdict('{"relation":"maybe","confidence":5}', require('../lib/agent-llm.js').extractJson);
  assert.equal(weird.relation, 'coexist');
  assert.equal(weird.confidence, 1); // clamped to [0,1]
});

test('checkedTag + pairAlreadyJudged: a pair is judged once, then skipped', () => {
  const tag = R.checkedTag('m_1784396319499_6f125947');
  assert.equal(tag, 'rcx:6f125947');
  // fresh pair → not judged
  assert.equal(R.pairAlreadyJudged({ b_id: 'm_1784396319499_6f125947', a_tags: ['hot', 'openclaw'] }), false);
  // same challenger already marked → judged (skip)
  assert.equal(R.pairAlreadyJudged({ b_id: 'm_1784396319499_6f125947', a_tags: ['rcx:6f125947'] }), true);
  // dated marker variant also matches
  assert.equal(R.pairAlreadyJudged({ b_id: 'm_1784396319499_6f125947', a_tags: ['rcx:6f125947:2026-07-18'] }), true);
  // a DIFFERENT challenger is a new pair → not judged
  assert.equal(R.pairAlreadyJudged({ b_id: 'm_9999999999999_deadbeef', a_tags: ['rcx:6f125947'] }), false);
  // missing/!array tags → safe false
  assert.equal(R.pairAlreadyJudged({ b_id: 'x', a_tags: null }), false);
});

test('parseJudgeVerdict survives inline-thinking prefixes and picks the final answer object', () => {
  const ej = require('../lib/agent-llm.js').extractJson;
  // MiniMax-style leading thinking with braces, then the real answer last.
  const withThink = '<think>Let me compare {these two} entries carefully...</think>\n{"relation":"supersedes","attribute":"port","confidence":0.95,"reason":"7001->9090"}';
  const v = R.parseJudgeVerdict(withThink, ej);
  assert.equal(v.relation, 'supersedes');
  assert.equal(v.confidence, 0.95);
  assert.ok(!v.parseError);
  // genuinely empty/garbage → parseError flagged (loop treats as retryable, not benign)
  const bad = R.parseJudgeVerdict('...thinking... no answer', ej);
  assert.equal(bad.parseError, true);
});

test('self-consistency guard: supersedes verdict whose reason says "different"/"both true" is downgraded to coexist', () => {
  const ej = require('../lib/agent-llm.js').extractJson;
  const bad = R.parseJudgeVerdict('{"relation":"supersedes","attribute":"x","confidence":1.0,"reason":"Both entries concern handoff logic but describe a DIFFERENT issue."}', ej);
  assert.equal(bad.relation, 'coexist'); // self-contradiction neutralized
  const bothTrue = R.parseJudgeVerdict('{"relation":"supersedes","confidence":0.9,"reason":"They can both be true at once."}', ej);
  assert.equal(bothTrue.relation, 'coexist');
  // a genuine value-conflict reason is preserved
  const good = R.parseJudgeVerdict('{"relation":"supersedes","attribute":"port","confidence":0.95,"reason":"Newer says port moved 7001 to 9090; older is now wrong."}', ej);
  assert.equal(good.relation, 'supersedes');
});

test('shouldAct only fires on high-confidence supersedes', () => {
  const cfg = { minConfidence: 0.75 };
  assert.equal(R.shouldAct({ relation: 'supersedes', confidence: 0.8 }, cfg), true);
  assert.equal(R.shouldAct({ relation: 'supersedes', confidence: 0.5 }, cfg), false);
  assert.equal(R.shouldAct({ relation: 'coexist', confidence: 0.99 }, cfg), false);
  assert.equal(R.shouldAct({ relation: 'duplicate', confidence: 0.99 }, cfg), false);
});
