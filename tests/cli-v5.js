const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cli = require('../lib/cli');
const doctor = require('../lib/doctor');
const fix = require('../lib/fix');
const phase2 = require('../lib/brainx-phase2');
const consolidation = require('../lib/semantic-consolidation');
const promotionGov = require('../lib/promotion-governance');
const skillApplier = require('../lib/skill-applier');
const skillLifecycle = require('../lib/skill-lifecycle');
const skillPromotion = require('../lib/skill-promotion');
const skillPromoter = require('../scripts/skill-promoter');
const skillCurator = require('../scripts/skill-curator');
const eventLedger = require('../scripts/event-ledger');
const selfLearningAudit = require('../scripts/self-learning-audit');
const recallHealth = require('../lib/recall-health');

function makeIo() {
  const logs = [];
  let stdout = '';
  return {
    logs,
    getStdout: () => stdout,
    deps: {
      log: (s) => logs.push(String(s)),
      err: (s) => logs.push(`ERR:${String(s)}`),
      stdout: { write: (s) => { stdout += String(s); } }
    }
  };
}

function makeTempSkillsRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainx-skills-'));
}

function makeTempSessionsRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainx-sessions-'));
}

function writeTestSession(root, agent, sessionId, messages) {
  const dir = path.join(root, agent, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, sessionId + '.jsonl');
  const lines = [
    JSON.stringify({ type: 'session', id: sessionId, timestamp: new Date().toISOString() }),
    ...messages.map((message, index) => JSON.stringify({
      type: 'message',
      id: sessionId + '-' + index,
      timestamp: new Date().toISOString(),
      message: {
        role: message.role,
        content: message.text,
        timestamp: new Date().toISOString(),
      },
    })),
  ];
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  return filePath;
}

function writeTestSkill(root, name, body = '') {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    '---\nname: ' + name + '\ndescription: Test skill for BrainX lifecycle.\n---\n\n# ' + name + '\n\n' + body,
    'utf8'
  );
  return dir;
}

async function testCmdAddMetadata() {
  const io = makeIo();
  let storedMemory;
  const rag = {
    async storeMemory(memory) {
      storedMemory = memory;
      return { id: 'existing_by_pattern', pattern_key: memory.pattern_key };
    }
  };

  await cli.cmdAdd({
    type: 'learning',
    content: 'Need stricter retry handling',
    context: 'proj',
    tier: 'hot',
    importance: '8',
    tags: 'a,b',
    status: 'in_progress',
    category: 'best_practice',
    patternKey: 'retry.loop',
    recurrenceCount: '3',
    resolutionNotes: 'track in runbook'
  }, { rag, ...io.deps });

  assert.strictEqual(storedMemory.pattern_key, 'retry.loop');
  assert.strictEqual(storedMemory.status, 'in_progress');
  assert.strictEqual(storedMemory.category, 'best_practice');
  assert.strictEqual(storedMemory.recurrence_count, 3);
  assert.deepStrictEqual(storedMemory.tags, ['a', 'b']);

  const payload = JSON.parse(io.logs[0]);
  assert.deepStrictEqual(payload, { ok: true, id: 'existing_by_pattern', pattern_key: 'retry.loop' });
}

async function testCmdSearchContractAndLogging() {
  const io = makeIo();
  const logEvents = [];
  const rag = {
    async search(query, opts) {
      assert.strictEqual(query, 'find memory');
      assert.strictEqual(opts.limit, 5);
      assert.strictEqual(opts.maxSensitivity, 'normal');
      return [
        { id: 'm1', content: 'x', similarity: 0.9, score: 1.1 },
        { id: 'm2', content: 'y', similarity: 0.5, score: 0.6 }
      ];
    },
    async logQueryEvent(evt) {
      logEvents.push(evt);
    }
  };

  await cli.cmdSearch({ query: 'find memory', limit: '5', minSimilarity: '0.2' }, { rag, ...io.deps });

  const payload = JSON.parse(io.logs[0]);
  assert.strictEqual(payload.ok, true);
  assert.strictEqual(payload.results.length, 2);
  assert.strictEqual(logEvents.length, 1);
  assert.strictEqual(logEvents[0].kind, 'search');
  assert.strictEqual(logEvents[0].resultsCount, 2);
  assert.ok(logEvents[0].avgSimilarity >= 0.69 && logEvents[0].avgSimilarity <= 0.71);
}

async function testCmdInjectGuardrailsAndLogging() {
  const io = makeIo();
  const calls = [];
  const logEvents = [];
  const rag = {
    async search(query, opts) {
      calls.push({ query, opts });
      assert.strictEqual(opts.maxSensitivity, 'normal');
      if (opts.tierFilter === 'hot') {
        return [
          { id: 'a', similarity: 0.8, score: 0.9, importance: 9, tier: 'hot', type: 'fact', agent: 'coder', context: 'deploy ctx', content: 'deploy config line 1\nline2', verification_state: 'verified', source_kind: 'tool_verified' },
          { id: 'dup', similarity: 0.7, score: 0.4, importance: 6, tier: 'hot', type: 'gotcha', agent: 'coder', context: 'deploy ctx', content: 'duplicate deploy hot', verification_state: 'verified', source_kind: 'user_explicit' }
        ];
      }
      return [
        { id: 'dup', similarity: 0.6, score: 0.5, importance: 6, tier: 'warm', type: 'gotcha', agent: 'coder', context: 'deploy ctx', content: 'duplicate deploy warm', verification_state: 'verified', source_kind: 'user_explicit' },
        { id: 'b', similarity: 0.5, score: 0.2, importance: 5, tier: 'warm', type: 'fact', agent: 'coder', context: 'ctx', content: 'LOW SCORE SHOULD FILTER', verification_state: 'verified', source_kind: 'tool_verified' }
      ];
    },
    async logQueryEvent(evt) {
      logEvents.push(evt);
    }
  };

  await cli.cmdInject({ query: 'deploy config', limit: '5', maxTotalChars: '90', minScore: '0.3' }, { rag, ...io.deps });

  assert.strictEqual(calls.length, 2);
  assert.ok(calls.every(c => c.opts.minSimilarity === 0.28));
  const out = io.getStdout();
  assert.ok(out.includes('deploy config'));
  assert.ok(!out.includes('LOW SCORE SHOULD FILTER'));
  assert.ok(out.length <= 90);
  assert.strictEqual(logEvents.length, 1);
  assert.strictEqual(logEvents[0].kind, 'inject');
  assert.strictEqual(logEvents[0].resultsCount, 2);
}

async function testSensitivityHelpers() {
  assert.strictEqual(
    phase2.deriveSensitivity({
      content: 'Credenciales para login son [REDACTED] y test12345',
      tags: ['pii:redacted', 'pii:email']
    }),
    'restricted'
  );
  assert.strictEqual(
    phase2.deriveSensitivity({
      content: 'Bind local [REDACTED]',
      tags: ['pii:redacted', 'pii:ipv4']
    }),
    'sensitive'
  );
  assert.deepStrictEqual(
    phase2.getAllowedSensitivities('sensitive'),
    ['normal', 'sensitive']
  );
  assert.strictEqual(
    phase2.deriveSensitivity({
      content: 'OAuth login completado para [REDACTED], pero sin tokens reales.',
      tags: ['pii:redacted', 'pii:email']
    }),
    'sensitive'
  );
  assert.strictEqual(
    phase2.deriveSensitivity({
      content: 'Credenciales para login son [REDACTED] / test12345',
      tags: ['pii:redacted', 'pii:ipv4']
    }),
    'restricted'
  );
  assert.strictEqual(
    phase2.deriveSensitivity({
      content: 'Bridge debe usar un Bearer token real y endpoint HTTPS.',
      tags: ['pii:redacted', 'pii:ipv4']
    }),
    'sensitive'
  );
  assert.strictEqual(
    phase2.deriveSensitivity({
      content: 'El login OAuth con [REDACTED] termina exitoso y guarda credentials.enc, pero no existe token_cache para hello.',
      tags: ['pii:redacted', 'pii:email']
    }),
    'sensitive'
  );
  assert.strictEqual(
    phase2.deriveSensitivity({
      content: '- `credentials-admin.json` -> [REDACTED]\n- `credentials-hello.json` -> [REDACTED]',
      tags: ['pii:redacted', 'pii:email']
    }),
    'sensitive'
  );
  assert.strictEqual(
    phase2.deriveSensitivity({
      content: 'Las credenciales de DataForSEO están guardadas con login [REDACTED] y password 8971dfdf863f5599.',
      tags: ['pii:redacted', 'pii:email']
    }),
    'restricted'
  );
  assert.strictEqual(
    phase2.deriveSensitivity({
      content: 'Test user: [REDACTED] / Test1234!',
      tags: ['pii:redacted', 'pii:email']
    }),
    'restricted'
  );
  assert.strictEqual(
    phase2.deriveSensitivity({
      content: 'Necesito credenciales del Django admin (username + password) o acceso SSH para desactivar 2FA.',
      tags: ['pii:redacted', 'pii:email']
    }),
    'sensitive'
  );
  assert.strictEqual(
    phase2.deriveSensitivity({
      content: 'Usuario: Mdx2025. Comparte los archivos clave del repo para revisar el error.',
      tags: ['pii:redacted', 'pii:phone']
    }),
    'sensitive'
  );
}

async function testCmdResolveLifecycleUpdate() {
  const io = makeIo();
  const queries = [];
  const db = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/UPDATE brainx_memories/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{ id: 'm1', pattern_key: 'pk1', status: params[1], resolved_at: params[2], promoted_to: params[3], resolution_notes: params[4] }]
        };
      }
      return { rowCount: 1, rows: [] };
    }
  };

  await cli.cmdResolve({ id: 'm1', status: 'resolved', resolutionNotes: 'fixed' }, { db, ...io.deps });

  assert.strictEqual(queries.length, 2);
  assert.ok(/UPDATE brainx_memories/.test(queries[0].sql));
  assert.ok(/UPDATE brainx_patterns/.test(queries[1].sql));
  assert.strictEqual(queries[0].params[0], 'm1');
  assert.strictEqual(queries[0].params[1], 'resolved');
  assert.ok(queries[0].params[2]);
  const payload = JSON.parse(io.logs[0]);
  assert.strictEqual(payload.updated, 1);
}

async function testCmdFeedbackIncorrectUsesValidSupersededBy() {
  const io = makeIo();
  const queries = [];
  const db = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/SELECT id, importance/.test(sql)) {
        return {
          rows: [{
            id: 'old_memory',
            importance: 10,
            access_count: 0,
            feedback_score: 0,
            superseded_by: null,
            verification_state: 'verified'
          }]
        };
      }
      if (/SELECT id FROM brainx_memories/.test(sql)) {
        return { rows: [{ id: 'new_memory' }] };
      }
      if (/UPDATE brainx_memories/.test(sql)) {
        return {
          rows: [{
            id: 'old_memory',
            superseded_by: params[1],
            feedback_score: -5,
            verification_state: 'obsolete'
          }]
        };
      }
      return { rows: [] };
    }
  };

  await cli.cmdFeedback({
    id: 'old_memory',
    incorrect: true,
    supersededBy: 'new_memory',
    json: true
  }, { db, ...io.deps });

  const update = queries.find((query) => /UPDATE brainx_memories/.test(query.sql));
  assert.ok(update);
  assert.strictEqual(update.params[0], 'old_memory');
  assert.strictEqual(update.params[1], 'new_memory');
  assert.ok(!update.sql.includes("feedback:incorrect"));
  const payload = JSON.parse(io.logs[0]);
  assert.strictEqual(payload.ok, true);
  assert.strictEqual(payload.memory.superseded_by, 'new_memory');
  assert.strictEqual(payload.memory.verification_state, 'obsolete');
}

async function testPromoteCandidatesDefaultsAndJson() {
  const io = makeIo();
  let lastParams;
  const db = {
    async query(sql, params) {
      assert.ok(sql.includes('FROM brainx_patterns'));
      lastParams = params;
      return {
        rows: [
          { pattern_key: 'pk1', recurrence_count: 4, last_status: 'pending', representative_content: 'x' }
        ]
      };
    }
  };

  await cli.cmdPromoteCandidates({}, { db, ...io.deps });

  assert.deepStrictEqual(lastParams, [3, 30, 50]);
  const payload = JSON.parse(io.logs[0]);
  assert.deepStrictEqual(payload.thresholds, { minRecurrence: 3, days: 30 });
  assert.strictEqual(payload.count, 1);
}

async function testMetricsOutput() {
  const io = makeIo();
  let call = 0;
  const db = {
    async query(_sql, _params) {
      call += 1;
      const responses = [
        { rows: [{ key: 'pending', count: 2 }] },
        { rows: [{ key: 'learning', count: 1 }] },
        { rows: [{ key: 'warm', count: 2 }] },
        { rows: [{ pattern_key: 'pk1', recurrence_count: 5 }] },
        { rows: [{ query_kind: 'search', calls: 3, avg_duration_ms: '12.34' }] }
      ];
      return responses[call - 1];
    }
  };

  await cli.cmdMetrics({ days: '14', topPatterns: '5' }, { db, ...io.deps });
  const payload = JSON.parse(io.logs[0]);
  assert.strictEqual(payload.window_days, 14);
  assert.strictEqual(payload.top_recurring_patterns.length, 1);
  assert.strictEqual(payload.query_performance[0].query_kind, 'search');
}

async function testRuntimeReportHardAndSoftSignal() {
  const io = makeIo();
  let call = 0;
  const db = {
    async query(sql, params) {
      call += 1;
      if (call === 6) {
        assert.deepStrictEqual(params, [7, '2026-05-02T22:36:00.000Z']);
      } else {
        assert.deepStrictEqual(params, [7]);
      }
      if (![4, 6, 7].includes(call)) assert.ok(sql.includes('soft_referenced_count'));
      const responses = [
        {
          rows: [{
            injections: 10,
            total_memories_injected: 5,
            total_hard_referenced: 1,
            total_soft_referenced: 3,
            gate_dropped: 2,
            dup_dropped: 0,
            avg_latency_ms: '12.3',
            scored: 9,
            hard_signal_ratio_pct: '20.00',
            soft_signal_ratio_pct: '60.00',
            signal_ratio_pct: '20.00'
          }]
        },
        {
          rows: [{
            agent: 'coder',
            injections: 10,
            mems_injected: 5,
            mems_hard_referenced: 1,
            mems_soft_referenced: 3,
            mems_referenced: 1,
            avg_latency_ms: '12.3',
            hard_signal_ratio_pct: '20.0',
            soft_signal_ratio_pct: '60.0',
            signal_ratio_pct: '20.0'
          }]
        },
        {
          rows: [{
            surface: 'jit_recall',
            injections: 10,
            avg_mems: '0.50',
            selected: 5,
            hard_referenced: 1,
            soft_referenced: 3,
            hard_signal_ratio_pct: '20.0',
            soft_signal_ratio_pct: '60.0',
            avg_latency_ms: '12.3'
          }]
        },
        { rows: [] },
        { rows: [] },
        { rows: [] },
        { rows: [] }
      ];
      return responses[call - 1];
    }
  };

  await cli.cmdRuntimeReport({ days: '7', json: true }, { db, ...io.deps });
  const payload = JSON.parse(io.logs[0]);
  assert.strictEqual(payload.overall.hard_signal_ratio_pct, '20.00');
  assert.strictEqual(payload.overall.soft_signal_ratio_pct, '60.00');
  assert.strictEqual(payload.by_agent[0].mems_soft_referenced, 3);
  assert.strictEqual(payload.by_surface[0].soft_referenced, 3);
}

async function testAgentMetricsConsolidatesConfigAndRuntime() {
  const io = makeIo();
  let call = 0;
  const openclawConfig = {
    agents: {
      list: [
        { id: 'matrix', name: 'matrix', model: { primary: 'gpt-5.5' }, agentRuntime: { id: 'codex' }, workspace: '/w/matrix' },
        { id: 'coder', name: 'coder', model: { primary: 'kimi' }, agentRuntime: { id: 'pi' }, workspace: '/w/coder' },
        { id: 'media-gen', name: 'media-gen', model: { primary: 'gpt-5.5' }, agentRuntime: { id: 'codex' }, workspace: '/w/media' },
        { id: 'writer', name: 'writer', model: { primary: 'gpt-5.5' }, agentRuntime: { id: 'codex' }, workspace: '/w/writer' },
      ],
    },
    plugins: {
      entries: {
        brainx: {
          enabled: true,
          config: {
            enabled: true,
            globalDisabledAgents: ['coder', 'media-gen'],
            wikiDigest: true,
            jitRecall: true,
            workingMemory: true,
            toolAdvisories: true,
            captureToolFailures: true,
            routerEnabled: true,
            policyController: true,
            jitRecallDisabledAgents: [],
            routerSkipAgents: [],
          },
        },
      },
    },
  };
  const db = {
    async query(sql, params) {
      call += 1;
      assert.deepStrictEqual(params, [7]);
      if (call === 1) {
        assert.ok(sql.includes('GROUP BY 1'));
        return {
          rows: [
            {
              agent: 'matrix',
              injections: 10,
              mems_injected: 5,
              mems_hard_referenced: 1,
              mems_soft_referenced: 3,
              gate_dropped: 2,
              dup_dropped: 0,
              avg_latency_ms: '100.0',
              scored: 9,
              hard_signal_ratio_pct: '20.0',
              soft_signal_ratio_pct: '60.0',
            },
            {
              agent: 'writer',
              injections: 6,
              mems_injected: 6,
              mems_hard_referenced: 0,
              mems_soft_referenced: 0,
              gate_dropped: 0,
              dup_dropped: 0,
              avg_latency_ms: '2100.0',
              scored: 6,
              hard_signal_ratio_pct: '0.0',
              soft_signal_ratio_pct: '0.0',
            },
          ],
        };
      }
      if (call === 2) {
        assert.ok(sql.includes('GROUP BY 1, 2'));
        return { rows: [{ agent: 'matrix', surface: 'jit_recall', injections: 10, selected: 5, hard_referenced: 1, soft_referenced: 3, avg_latency_ms: '100.0' }] };
      }
      if (call === 3) {
        assert.ok(sql.includes('DISTINCT ON'));
        return { rows: [{ agent: 'matrix', id: 42, surface: 'jit_recall', selected_count: 1, latency_ms: 100, injected_at: '2026-05-01T00:00:00.000Z', scored_at: '2026-05-01T00:00:01.000Z' }] };
      }
      if (call === 4) {
        assert.ok(sql.includes('brainx_policy_decisions'));
        return {
          rows: [{
            agent: 'writer',
            decisions: 7,
            suppressions: 6,
            explorations: 1,
            low_signal_suppressions: 6,
            low_signal_explorations: 1,
            last_policy_seen: '2026-05-01T00:00:02.000Z',
            policy_surfaces: 'jit_recall:suppress,jit_recall:explore',
          }],
        };
      }
      throw new Error(`unexpected query ${call}`);
    },
  };

  await cli.cmdAgentMetrics({ days: '7', json: true }, { db, openclawConfig, ...io.deps });
  const payload = JSON.parse(io.logs[0]);
  assert.strictEqual(payload.summary.total_agents, 3);
  assert.strictEqual(payload.summary.enabled, 2);
  assert.strictEqual(payload.summary.disabled_intentional, 1);
  assert.deepStrictEqual(payload.excludes, ['media-gen*']);
  assert.strictEqual(payload.agents.find((a) => a.agent === 'matrix').status, 'healthy');
  assert.strictEqual(payload.summary.managed_low_signal, 1);
  assert.strictEqual(payload.agents.find((a) => a.agent === 'writer').status, 'managed-low-signal');
  assert.strictEqual(payload.agents.find((a) => a.agent === 'writer').brainx.policy.low_signal_suppressions, 6);
  assert.strictEqual(payload.agents.find((a) => a.agent === 'coder').status, 'disabled-intentional');
  assert.ok(payload.agents.find((a) => a.agent === 'coder').reasons.includes('kimi_recovery_preflight_stability_workaround'));
  assert.strictEqual(payload.agents.some((a) => a.agent === 'media-gen'), false);
}

async function testRouterQualitySummarizesRouterDecisions() {
  const io = makeIo();
  let call = 0;
  const db = {
    async query(sql, params) {
      call += 1;
      assert.ok(sql.includes("decision_summary->'router' IS NOT NULL"));
      if (call < 4) assert.deepStrictEqual(params, [7, 'matrix']);
      if (call === 4) assert.deepStrictEqual(params, [7, 'matrix', 5]);
      if (call === 1) {
        return {
          rows: [{
            router_events: 3,
            applied: 3,
            errors: 0,
            fail_closed: 0,
            selected: 2,
            hard_referenced: 0,
            soft_referenced: 1,
            signal_gate_dropped: 4,
            near_dup_dropped: 1,
            strict_guard_dropped: 1,
            proposed_ids: 4,
            selected_overlap: 2,
            avg_total_latency_ms: '1200.0',
            avg_router_latency_ms: '900.0',
            hard_signal_ratio_pct: '0.0',
            soft_signal_ratio_pct: '50.0',
          }],
        };
      }
      if (call === 2) {
        return {
          rows: [{
            agent: 'matrix',
            router_events: 3,
            selected: 2,
            hard_referenced: 0,
            soft_referenced: 1,
            signal_gate_dropped: 4,
            strict_guard_dropped: 1,
            proposed_ids: 4,
            avg_total_latency_ms: '1200.0',
            avg_router_latency_ms: '900.0',
            soft_signal_ratio_pct: '50.0',
          }],
        };
      }
      if (call === 3) {
        return {
          rows: [{
            surface: 'jit_recall',
            router_events: 3,
            selected: 2,
            hard_referenced: 0,
            soft_referenced: 1,
            signal_gate_dropped: 4,
            strict_guard_dropped: 1,
            proposed_ids: 4,
            avg_total_latency_ms: '1200.0',
            avg_router_latency_ms: '900.0',
            soft_signal_ratio_pct: '50.0',
          }],
        };
      }
      return {
        rows: [
          {
            id: 101,
            agent: 'matrix',
            session_key: 'agent:matrix:test',
            surface: 'jit_recall',
            selected_count: 1,
            referenced_count: 0,
            soft_referenced_count: 1,
            signal_gate_dropped: 0,
            near_dup_dropped: 0,
            latency_ms: 1100,
            injected_at: '2026-05-01T00:00:00.000Z',
            scored_at: '2026-05-01T00:00:01.000Z',
            prompt_sha: 'abc',
            prompt_preview: 'brainx metrics',
            decision_summary: {
              router: {
                mode: 'active',
                applied: true,
                model: 'gpt-5-nano',
                proposed_ids: ['m1'],
                selected_overlap: 1,
                latency_ms: 800,
                strict_guard_dropped: 0,
              },
            },
            top_candidates: [{ id: 'm1', reason: 'selected', finalScore: 0.9 }],
            memory_ids: ['m1'],
          },
          {
            id: 102,
            agent: 'matrix',
            session_key: 'agent:matrix:test',
            surface: 'jit_recall',
            selected_count: 0,
            referenced_count: 0,
            soft_referenced_count: 0,
            signal_gate_dropped: 3,
            near_dup_dropped: 1,
            latency_ms: 3500,
            injected_at: '2026-05-01T00:00:02.000Z',
            scored_at: '2026-05-01T00:00:03.000Z',
            prompt_sha: 'def',
            prompt_preview: 'unrelated',
            decision_summary: {
              router: {
                mode: 'active',
                applied: true,
                model: 'gpt-5-nano',
                proposed_ids: ['m2'],
                selected_overlap: 0,
                latency_ms: 2800,
                strict_guard_dropped: 1,
              },
            },
            top_candidates: [{ id: 'm2', reason: 'below-relevance-threshold', finalScore: 0.7 }],
            memory_ids: [],
          },
        ],
      };
    },
  };

  await cli.cmdRouterQuality({ days: '7', agent: 'matrix', limit: '5', json: true }, { db, ...io.deps });
  const payload = JSON.parse(io.logs[0]);
  assert.strictEqual(payload.overall.router_events, 3);
  assert.strictEqual(payload.by_agent[0].agent, 'matrix');
  assert.strictEqual(payload.by_surface[0].surface, 'jit_recall');
  assert.strictEqual(payload.quality_counts_from_recent_sample.good, 1);
  assert.strictEqual(payload.quality_counts_from_recent_sample['safe-empty'], 1);
  assert.strictEqual(payload.recent[0].router.model, 'gpt-5-nano');
}

async function testCmdExplainById() {
  const io = makeIo();
  let call = 0;
  const db = {
    async query(sql, params) {
      call += 1;
      if (call === 1) {
        assert.ok(sql.includes('FROM brainx_runtime_injections'));
        assert.deepStrictEqual(params, ['42', 1]);
        return {
          rows: [{
            id: 42,
            agent: 'coder',
            session_id: 'sess-1',
            session_key: 'agent:coder:test',
            surface: 'jit_recall',
            memory_ids: ['m1'],
            similarities: [0.77],
            importances: [8],
            raw_count: 5,
            filtered_count: 2,
            selected_count: 1,
            near_dup_dropped: 0,
            signal_gate_dropped: 3,
            prompt_sha: 'abc',
            prompt_preview: 'revisa BrainX',
            response_sha: 'def',
            referenced_count: 0,
            referenced_ids: [],
            soft_referenced_count: 1,
            soft_referenced_ids: ['m1'],
            latency_ms: 123,
            injected_at: '2026-05-01T00:00:00.000Z',
            scored_at: '2026-05-01T00:00:01.000Z',
            decision_summary: { router: { mode: 'active', applied: true, proposed_ids: ['m1'], reason: 'directo', strict_guard_dropped: 0 } },
            top_candidates: [{ id: 'm1' }]
          }]
        };
      }
      assert.ok(sql.includes('FROM brainx_memories'));
      assert.deepStrictEqual(params, [['m1']]);
      return {
        rows: [{
          id: 'm1',
          type: 'decision',
          tier: 'hot',
          importance: 8,
          agent: 'main',
          source_kind: 'tool_verified',
          verification_state: 'verified',
          source_path: '/tmp/source',
          sensitivity: 'normal',
          content: 'BrainX router decision relevant to this prompt.'
        }]
      };
    }
  };

  await cli.cmdExplain({ id: '42', json: true }, { db, ...io.deps });
  const payload = JSON.parse(io.logs[0]);
  assert.strictEqual(payload.count, 1);
  assert.strictEqual(payload.results[0].router.applied, true);
  assert.strictEqual(payload.results[0].memories[0].soft_referenced, true);
  assert.strictEqual(payload.results[0].memories[0].type, 'decision');
}

async function testPiiScrubHelpers() {
  const scrubbed = phase2.scrubTextPII(
    'email me at jane@example.com or call (415) 555-1234 with sk-1234567890abcdef1234',
    { enabled: true, replacement: '[REDACTED]' }
  );
  assert.strictEqual(scrubbed.redacted, true);
  assert.ok(scrubbed.reasons.includes('email'));
  assert.ok(scrubbed.reasons.includes('phone'));
  assert.ok(scrubbed.reasons.some((r) => r.includes('key') || r.includes('openai')));
  assert.ok(!scrubbed.text.includes('jane@example.com'));
  const longId = phase2.scrubTextPII(
    'session id 1480684710010159195 should stay visible',
    { enabled: true, replacement: '[REDACTED]' }
  );
  assert.ok(!longId.reasons.includes('credit_card'));
  assert.ok(longId.text.includes('1480684710010159195'));
  const tags = phase2.mergeTagsWithMetadata(['a'], { redacted: true, reasons: ['email'] });
  assert.deepStrictEqual(tags, ['a', 'pii:redacted', 'pii:email']);
}

async function testSemanticDedupeMergePlanHelper() {
  const now = new Date('2026-02-24T00:00:00.000Z');
  const plan = phase2.deriveMergePlan(
    { id: 'm1', recurrence_count: 2, first_seen: new Date('2026-02-01T00:00:00.000Z'), last_seen: new Date('2026-02-20T00:00:00.000Z') },
    { recurrence_count: null, first_seen: null, last_seen: null },
    now
  );
  assert.strictEqual(plan.found, true);
  assert.strictEqual(plan.finalId, 'm1');
  assert.strictEqual(plan.finalRecurrence, 3);
  assert.strictEqual(plan.finalLastSeen.toISOString(), now.toISOString());
}

async function testPiiAllowlistContextHelper() {
  const cfg = {
    piiScrubEnabled: true,
    piiScrubAllowlistContexts: ['internal-safe', 'trusted']
  };
  assert.strictEqual(phase2.shouldScrubForContext('internal-safe', cfg), false);
  assert.strictEqual(phase2.shouldScrubForContext('other-context', cfg), true);
}

async function testQualityGateSkipsAcknowledgementNoise() {
  const result = phase2.assessMemoryQuality({
    type: 'note',
    content: 'ok, lo reviso',
    importance: 5
  });

  assert.strictEqual(result.action, 'skip');
  assert.strictEqual(result.reason, 'acknowledgement');
}

async function testQualityGateSkipsVaguePlaceholder() {
  const result = phase2.assessMemoryQuality({
    type: 'learning',
    content: 'Need to review this',
    importance: 5
  });

  assert.strictEqual(result.action, 'skip');
  assert.strictEqual(result.reason, 'placeholder');
}

async function testQualityGateKeepsShortTechnicalSignal() {
  const result = phase2.assessMemoryQuality({
    type: 'decision',
    content: 'Use RAILWAY_API_TOKEN for railway whoami.',
    importance: 8
  });

  assert.strictEqual(result.action, 'store');
  assert.ok(result.score >= 2);
}

async function testQualityGateDowngradesBorderlineSignal() {
  const result = phase2.assessMemoryQuality({
    type: 'learning',
    content: 'Need better retries',
    importance: 4
  });

  assert.strictEqual(result.action, 'downgrade');
  assert.strictEqual(result.reason, 'borderline');
  assert.ok(result.tags.includes('quality:borderline'));
}

async function testSemanticConsolidationRejectsRuntimeNoise() {
  const result = consolidation.isMemoryEligibleForConsolidation({
    id: 'm1',
    type: 'decision',
    content: '[Subagent Context] You are running as a subagent (depth 1/2). Results auto-announce to your requester.',
    created_at: '2026-03-01T00:00:00.000Z',
    verification_state: 'verified',
    source_kind: 'agent_inference',
    tags: []
  }, {}, new Date('2026-04-01T00:00:00.000Z'));

  assert.strictEqual(result.eligible, false);
  assert.ok(result.reasons.includes('runtime_noise'));
}

async function testSemanticConsolidationPairScopeGuard() {
  const cfg = consolidation.getSemanticConsolidationConfig();
  const now = new Date('2026-04-01T00:00:00.000Z');
  const left = {
    id: 'a',
    type: 'decision',
    agent: 'reasoning',
    context: 'project:x',
    category: 'infrastructure',
    sensitivity: 'normal',
    content: 'Use the remote gateway directly.',
    created_at: '2026-03-20T00:00:00.000Z',
    verification_state: 'verified',
    source_kind: 'agent_inference',
    tags: []
  };
  const right = {
    ...left,
    id: 'b',
    agent: 'coder'
  };

  const result = consolidation.canConsolidatePair(left, right, cfg, now);
  assert.strictEqual(result.ok, false);
  assert.ok(result.reasons.includes('scope_mismatch'));
}

async function testSemanticConsolidationMergeClusterPreservesDurableMetadata() {
  const merged = consolidation.mergeClusterMemories([
    {
      id: 'a',
      type: 'decision',
      agent: 'reasoning',
      context: 'project:x',
      category: 'infrastructure',
      sensitivity: 'normal',
      content: 'Use the remote OpenClaw Gateway over HTTP with a real Bearer token.',
      importance: 9,
      recurrence_count: 1,
      tags: ['distilled'],
      verification_state: 'verified',
      created_at: '2026-03-20T00:00:00.000Z',
      first_seen: '2026-03-20T00:00:00.000Z',
      last_seen: '2026-03-20T00:00:00.000Z',
      last_accessed: '2026-03-21T00:00:00.000Z'
    },
    {
      id: 'b',
      type: 'decision',
      agent: 'reasoning',
      context: 'project:x',
      category: 'infrastructure',
      sensitivity: 'normal',
      content: 'Rebuild the VSIX so it no longer depends on the local bridge.',
      importance: 8,
      recurrence_count: 2,
      tags: ['calibrated_verified'],
      verification_state: 'verified',
      created_at: '2026-03-21T00:00:00.000Z',
      first_seen: '2026-03-21T00:00:00.000Z',
      last_seen: '2026-03-22T00:00:00.000Z',
      last_accessed: '2026-03-23T00:00:00.000Z'
    }
  ]);

  assert.strictEqual(merged.type, 'decision');
  assert.strictEqual(merged.verification_state, 'verified');
  assert.strictEqual(merged.recurrence_count, 3);
  assert.ok(merged.tags.includes('consolidated:weekly'));
  assert.ok(merged.content.includes('VSIX'));
}

async function testSemanticConsolidationMergeClusterDemotesCarriedStaleTier() {
  const merged = consolidation.mergeClusterMemories([
    {
      id: 'a',
      type: 'decision',
      agent: 'writer',
      context: 'project:y',
      category: 'infrastructure',
      sensitivity: 'normal',
      content: 'Use the Telegram attachment workflow that was validated in February.',
      importance: 8,
      recurrence_count: 1,
      access_count: 0,
      tier: 'hot',
      tags: ['distilled'],
      verification_state: 'verified',
      created_at: '2026-03-20T00:00:00.000Z',
      first_seen: '2026-02-20T00:00:00.000Z',
      last_seen: '2026-02-27T00:00:00.000Z',
      last_accessed: '2026-02-27T00:00:00.000Z'
    },
    {
      id: 'b',
      type: 'decision',
      agent: 'writer',
      context: 'project:y',
      category: 'infrastructure',
      sensitivity: 'normal',
      content: 'Keep media handling conservative and avoid duplicate uploads.',
      importance: 7,
      recurrence_count: 1,
      access_count: 0,
      tier: 'hot',
      tags: ['calibrated_verified'],
      verification_state: 'verified',
      created_at: '2026-03-21T00:00:00.000Z',
      first_seen: '2026-02-21T00:00:00.000Z',
      last_seen: '2026-02-28T00:00:00.000Z',
      last_accessed: '2026-02-28T00:00:00.000Z'
    }
  ], { now: '2026-04-02T00:00:00.000Z' });

  assert.strictEqual(merged.tier, 'cold');
  assert.ok(merged.tags.includes('carried_stale_demoted'));
}

async function testWeeklyConsolidationScheduleGuard() {
  assert.strictEqual(
    consolidation.shouldRunWeeklyConsolidation(new Date('2026-04-05T00:00:00.000Z')),
    true
  );
  assert.strictEqual(
    consolidation.shouldRunWeeklyConsolidation(new Date('2026-04-01T00:00:00.000Z')),
    false
  );
}

async function testLifecycleRunPromoteDegradeAndPatternSync() {
  const io = makeIo();
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (calls.length === 1) return { rows: [{ id: 'p1' }] }; // promote preview
      if (calls.length === 2) return { rows: [{ id: 'd1' }] }; // degrade preview
      if (/UPDATE brainx_memories/.test(sql) && sql.includes("SET status = 'promoted'")) {
        return { rowCount: 1, rows: [{ id: 'p1', pattern_key: 'pk1', status: 'promoted' }] };
      }
      if (/UPDATE brainx_memories/.test(sql) && sql.includes("COALESCE(importance, 5) <= $2")) {
        return { rowCount: 1, rows: [{ id: 'd1', pattern_key: 'pk1', status: 'wont_fix' }] };
      }
      if (/UPDATE brainx_patterns/.test(sql)) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }
  };

  await cli.cmdLifecycleRun({}, { db, ...io.deps });

  assert.ok(calls.some((c) => /UPDATE brainx_memories/.test(c.sql) && c.sql.includes("SET status = 'promoted'")));
  assert.ok(calls.some((c) => /UPDATE brainx_memories/.test(c.sql) && c.sql.includes("COALESCE(importance, 5) <= $2")));
  assert.ok(calls.some((c) => /UPDATE brainx_patterns/.test(c.sql)));
  const payload = JSON.parse(io.logs[0]);
  assert.strictEqual(payload.updated.promoted, 1);
  assert.strictEqual(payload.updated.degraded, 1);
}

async function testDoctorWrapperScheduleInference() {
  const wrapperSource = `
NAMES+=("context-pack-builder")
CMDS+=("timeout 120 node scripts/context-pack-builder.js --days 7")

# ── WEEKLY STEPS (run only on Sundays) ─────────────────────────
if [ "$IS_SUNDAY" -eq 1 ]; then
  NAMES+=("contradiction-detector")
  CMDS+=("timeout 240 node scripts/contradiction-detector.js --top 60 --threshold 0.85")
fi
`;

  assert.strictEqual(
    doctor.inferWrapperStepSchedule(wrapperSource, 'scripts/context-pack-builder.js'),
    'daily'
  );
  assert.strictEqual(
    doctor.inferWrapperStepSchedule(wrapperSource, 'scripts/contradiction-detector.js'),
    'sunday'
  );
  assert.strictEqual(
    doctor.inferWrapperStepSchedule(wrapperSource, 'scripts/learning-detail-extractor.js'),
    'off'
  );
}

async function testDoctorSurfaceFreshnessClassification() {
  const staleOff = doctor.buildSurfaceFreshnessCheck({
    label: 'Learning details freshness',
    table: 'brainx_learning_details',
    total: 110,
    lastAt: '2026-03-09T03:02:39.693Z',
    schedule: 'off',
    nowMs: Date.parse('2026-04-13T00:00:00.000Z')
  });
  assert.strictEqual(staleOff.status, 'warn');
  assert.ok(staleOff.detail.includes('schedule=off'));

  const staleRecentOff = doctor.buildSurfaceFreshnessCheck({
    label: 'Synthetic off freshness',
    table: 'brainx_synthetic_off',
    total: 4,
    lastAt: '2026-04-02T00:00:00.000Z',
    schedule: 'off',
    nowMs: Date.parse('2026-04-13T00:00:00.000Z')
  });
  assert.strictEqual(staleRecentOff.status, 'warn');

  const staleDaily = doctor.buildSurfaceFreshnessCheck({
    label: 'Synthetic daily freshness',
    table: 'brainx_synthetic_daily',
    total: 3,
    lastAt: '2026-04-01T00:00:00.000Z',
    schedule: 'daily',
    nowMs: Date.parse('2026-04-13T00:00:00.000Z')
  });
  assert.strictEqual(staleDaily.status, 'fail');

  const freshSunday = doctor.buildSurfaceFreshnessCheck({
    label: 'Synthetic sunday freshness',
    table: 'brainx_synthetic_sunday',
    total: 4,
    lastAt: '2026-04-10T00:00:00.000Z',
    schedule: 'sunday',
    nowMs: Date.parse('2026-04-13T00:00:00.000Z')
  });
  assert.strictEqual(freshSunday.status, 'ok');

  const dormantOff = doctor.buildSurfaceFreshnessCheck({
    surfaceKey: 'learning_details',
    label: 'Learning details freshness',
    table: 'brainx_learning_details',
    total: 110,
    lastAt: '2026-03-09T03:02:39.693Z',
    schedule: 'off',
    policy: {
      state: 'dormant',
      owner: 'skill',
      expectedSchedule: 'off',
      note: 'intentionally unscheduled'
    },
    nowMs: Date.parse('2026-04-13T00:00:00.000Z')
  });
  assert.strictEqual(dormantOff.status, 'ok');
  assert.ok(dormantOff.detail.includes('policy=dormant'));

  const manualMismatch = doctor.buildSurfaceFreshnessCheck({
    surfaceKey: 'session_snapshots',
    label: 'Session snapshots freshness',
    table: 'brainx_session_snapshots',
    total: 4,
    lastAt: '2026-04-10T00:00:00.000Z',
    schedule: 'daily',
    policy: {
      state: 'manual',
      owner: 'skill',
      expectedSchedule: 'off',
      note: 'manual only'
    },
    nowMs: Date.parse('2026-04-13T00:00:00.000Z')
  });
  assert.strictEqual(manualMismatch.status, 'warn');
  assert.ok(manualMismatch.detail.includes('expected_schedule=off'));
}

async function testFixOnlyStepParsing() {
  assert.deepStrictEqual(
    fix.parseOnlySteps('stale-demotion, null-embeddings'),
    ['stale-demotion', 'null-embeddings']
  );
  assert.strictEqual(fix.parseOnlySteps(''), null);
}

async function testFixOnlyStepResolution() {
  const selected = fix.resolveFixSteps(['stale-demotion', 'null-embeddings']);
  assert.deepStrictEqual(
    selected.steps.map((entry) => entry.id),
    ['stale-demotion', 'null-embeddings']
  );
  assert.deepStrictEqual(selected.unknown, []);

  const withUnknown = fix.resolveFixSteps(['stale-demotion', 'nope']);
  assert.deepStrictEqual(withUnknown.steps.map((entry) => entry.id), ['stale-demotion']);
  assert.deepStrictEqual(withUnknown.unknown, ['nope']);
}

async function testSubcommandHelpDoesNotTouchDb() {
  const originalLog = console.log;
  const logs = [];
  console.log = (msg) => logs.push(String(msg));
  try {
    const code = await cli.main(['fix', '--help'], {
      db: {
        query() {
          throw new Error('db touched');
        }
      }
    });
    assert.strictEqual(code, 0);
    assert.ok(logs.join('\n').includes('fix [--dry-run]'));
  } finally {
    console.log = originalLog;
  }
}

async function testPromotionGovernanceHelpers() {
  const meta = promotionGov.extractSuggestionMetadata(
    '[PROMOTION SUGGESTION] → workflow\nSection: Workflow & Execution\nRule: Usar brainx search antes de concluir que falta contexto\nReason: Workflow/execution pattern\nRecurrence: 4x\nSource: pattern (brainx-search-context)'
  );
  assert.strictEqual(meta.targetKey, 'workflow');
  assert.strictEqual(meta.sourcePatternKey, 'brainx-search-context');
  assert.strictEqual(meta.rule, 'Usar brainx search antes de concluir que falta contexto');

  assert.strictEqual(promotionGov.isLowSignalPromotionRule('[PROMOTION SUGGESTION] → AGENTS'), true);
  assert.strictEqual(promotionGov.isLowSignalPromotionRule('El archivo BRAINX_CONTEXT'), true);
  assert.strictEqual(
    promotionGov.isLowSignalPromotionRule('Si falta contexto o hay conflicto, usar brainx search antes de concluir que no existe memoria relevante'),
    false
  );

  const canonical = {
    sections: {
      workflow: {
        rules: ['- Si falta contexto o hay conflicto, usar brainx search antes de concluir que no existe memoria relevante.'],
        normalizedRules: ['si falta contexto o hay conflicto, usar brainx search antes de concluir que no existe memoria relevante.'],
      },
      tools: { rules: [], normalizedRules: [] },
      behavior: { rules: [], normalizedRules: [] },
    },
  };
  const match = promotionGov.findCanonicalRuleMatch(
    'Si falta contexto o hay conflicto, usar brainx search antes de concluir que no existe memoria relevante.',
    canonical,
    'workflow'
  );
  assert.strictEqual(match.targetKey, 'workflow');
}

async function testSkillPromotionCandidateGuardrails() {
  const row = {
    id: 'm_gws',
    type: 'gotcha',
    category: 'best_practice',
    source_kind: 'tool_verified',
    recurrence_count: 5,
    access_count: 4,
    tags: ['workflow'],
    content: 'Cuando una tarea toque Gmail o Google Workspace, verificar identidad con gws-whoami antes de leer o escribir y usar gws-hello/gws-admin segun el scope.',
  };

  const candidate = skillPromotion.createCandidateFromRow(row, {
    minScore: 0.5,
    existingSkillNames: new Set(['gws']),
  });

  assert.ok(candidate);
  assert.strictEqual(candidate.skillName, 'gws');
  assert.strictEqual(candidate.action, 'extend_existing_skill');
  assert.ok(candidate.confidence >= 0.5);
  assert.ok(candidate.draftSkillMd.includes('name: gws'));
  assert.ok(candidate.registrationChecklist.some((line) => line.includes('agent-core')));
  assert.ok(candidate.registrationChecklist.some((line) => line.includes('openclaw skills')));
  assert.ok(candidate.registrationChecklist.some((line) => line.includes('regen-references.sh skills --apply')));

  const unsafe = skillPromotion.createCandidateFromRow({
    ...row,
    id: 'm_secret',
    content: 'api_key: sk_test_abcdefghijklmnopqrstuvwxyz debe guardarse en .env',
  }, { minScore: 0.1, existingSkillNames: new Set() });
  assert.strictEqual(unsafe, null);

  const toolFailure = skillPromotion.createCandidateFromRow({
    ...row,
    id: 'm_toolfail',
    pattern_key: 'tool-failure:exec:timeout',
    content: 'exec failed. command=pytest. command aborted by signal SIGTERM.',
  }, { minScore: 0.1, existingSkillNames: new Set() });
  assert.strictEqual(toolFailure, null);

  const projectImplementationDetail = skillPromotion.createCandidateFromRow({
    id: 'm_scheduler_bug',
    type: 'learning',
    category: 'infrastructure',
    source_kind: 'markdown_import',
    recurrence_count: 8,
    tags: ['workflow'],
    content: 'El frontend carecía de una función renderScheduler para actualizar el DOM con tareas programadas; se debe crear y llamar desde renderAll pasando el estado actualizado.',
  }, { minScore: 0.1, existingSkillNames: new Set(['automation-workflows']) });
  assert.strictEqual(projectImplementationDetail, null);
}

async function testSkillPromotionLoadsRuntimeRegistryFirst() {
  const names = skillPromotion.loadExistingSkillNames([], {
    execFileSync: () => JSON.stringify({
      skills: [
        { name: 'BrainX V6 Runtime / V5 Skill', eligible: true, location: '/home/clawd/.openclaw/skills/brainx/SKILL.md' },
        { name: 'draft-disabled-skill', eligible: false },
      ],
    }),
  });

  assert.ok(names.has('BrainX V6 Runtime / V5 Skill'));
  assert.ok(names.has('brainx-v6-runtime-v5-skill'));
  assert.ok(names.has('brainx'));
  assert.strictEqual(names.has('draft-disabled-skill'), false);

  const root = makeTempSkillsRoot();
  writeTestSkill(root, 'brainx');
  const merged = skillPromotion.loadExistingSkillNames([root], {
    execFileSync: () => JSON.stringify({
      skills: [
        { name: 'BrainX V6 Runtime / V5 Skill', eligible: true },
      ],
    }),
  });
  assert.ok(merged.has('BrainX V6 Runtime / V5 Skill'));
  assert.ok(merged.has('brainx'));
}

async function testSkillPromotionGroupsCandidates() {
  const a = skillPromotion.createCandidateFromRow({
    id: 'm1',
    type: 'learning',
    category: 'best_practice',
    source_kind: 'agent_inference',
    recurrence_count: 4,
    content: 'Siempre usar gws-admin para operaciones de Google Workspace y verificar identidad efectiva antes de modificar cuentas.',
  }, { minScore: 0.4, existingSkillNames: new Set(['gws']) });
  const b = skillPromotion.createCandidateFromRow({
    id: 'm2',
    type: 'gotcha',
    category: 'best_practice',
    source_kind: 'tool_verified',
    recurrence_count: 3,
    content: 'Antes de tocar Gmail o Drive, ejecutar gws-whoami y confirmar la cuenta efectiva del workspace.',
  }, { minScore: 0.4, existingSkillNames: new Set(['gws']) });

  const grouped = skillPromotion.groupCandidates([a, b]);
  assert.strictEqual(grouped.length, 1);
  assert.strictEqual(grouped[0].skillName, 'gws');
  assert.strictEqual(grouped[0].sourceCount, 2);
  assert.ok(grouped[0].draftSkillMd.includes('Review-gated'));
}

async function testSkillPromotionSuppressesPlaywrightNoisyCandidate() {
  assert.strictEqual(skillPromotion.isSuppressedSkillCandidateName('playwright-browser-automation'), true);
  const candidate = skillPromotion.createCandidateFromRow({
    id: 'm_playwright_1',
    type: 'learning',
    category: 'best_practice',
    source_kind: 'raw_session',
    recurrence_count: 5,
    tags: ['workflow', 'raw-session'],
    content: 'Despues tomar screenshot con Playwright para verificar el nuevo render responsive.',
  }, { minScore: 0.4, existingSkillNames: new Set(['playwright-browser-automation']) });
  assert.strictEqual(candidate, null);
}

async function testSkillPromotionSuppressesEmailbotProtocolAsGlobalSkill() {
  const target = skillPromotion.inferProjectDocTarget({
    id: 'm_emailbot_1',
    type: 'learning',
    category: 'best_practice',
    source_kind: 'tool_verified',
    recurrence_count: 8,
    context: 'project:emailbot',
    tags: ['workflow', 'emailbot'],
    content: 'Cuando Emailbot genere Gmail followups para leads, validar el contexto real antes de crear drafts.',
  });

  assert.deepStrictEqual(target, {
    kind: 'project-doc',
    project: 'emailbot',
    canonicalPath: 'knowledge/emailbot/email-protocol.md',
    canonicalKey: 'project-doc:emailbot:knowledge/emailbot/email-protocol.md',
  });

  const candidate = skillPromotion.createCandidateFromRow({
    id: 'm_emailbot_1',
    type: 'learning',
    category: 'best_practice',
    source_kind: 'tool_verified',
    recurrence_count: 8,
    context: 'project:emailbot',
    tags: ['workflow', 'emailbot'],
    content: 'Cuando Emailbot genere Gmail followups para leads, validar el contexto real antes de crear drafts.',
  }, { minScore: 0.4, existingSkillNames: new Set() });

  assert.strictEqual(candidate, null);
}

async function testSkillPromotionGroupsByCanonicalTarget() {
  const a = skillPromotion.createCandidateFromRow({
    id: 'm_github_1',
    type: 'learning',
    category: 'best_practice',
    source_kind: 'tool_verified',
    recurrence_count: 4,
    content: 'Antes de abrir un pull request en GitHub, verificar la branch y revisar el diff.',
  }, { minScore: 0.4, existingSkillNames: new Set(['github']) });
  const b = skillPromotion.createCandidateFromRow({
    id: 'm_github_2',
    type: 'gotcha',
    category: 'best_practice',
    source_kind: 'agent_inference',
    recurrence_count: 4,
    content: 'Antes de revisar un GitHub pull request, ejecutar gh y confirmar la branch correcta.',
  }, { minScore: 0.4, existingSkillNames: new Set(['github']) });

  assert.strictEqual(a.canonicalKey, 'skill:global:skills/github/SKILL.md');
  assert.strictEqual(b.canonicalKey, 'skill:global:skills/github/SKILL.md');
  const grouped = skillPromotion.groupCandidates([a, b]);
  assert.strictEqual(grouped.length, 1);
  assert.strictEqual(grouped[0].canonicalPath, 'skills/github/SKILL.md');
  assert.strictEqual(grouped[0].sourceCount, 2);
}

async function testSkillPromoterDedupeRowsUsesCanonicalMemoryId() {
  const rows = skillPromoter.dedupeRows([
    {
      source: 'memory',
      id: 'm_same',
      pattern_key: 'workflow:gws',
      content: 'Antes de usar Gmail, verificar cuenta efectiva.',
    },
    {
      source: 'pattern',
      representative_memory_id: 'm_same',
      pattern_key: 'workflow:gws',
      content: 'Antes de usar Gmail, verificar cuenta efectiva.',
    },
    {
      source: 'pattern',
      pattern_key: 'workflow:github',
      content: 'Antes de usar GitHub, revisar branch.',
    },
  ]);

  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].id, 'm_same');
  assert.strictEqual(rows[1].pattern_key, 'workflow:github');
}

async function testSkillPromoterRunWithFakeDb() {
  let call = 0;
  const db = {
    async query(sql, params) {
      call += 1;
      assert.deepStrictEqual(params, [4, 60, 30]);
      if (call === 1) {
        assert.ok(sql.includes('FROM brainx_patterns'));
        return { rows: [] };
      }
      assert.ok(sql.includes('FROM brainx_memories'));
      return {
        rows: [{
          source: 'memory',
          id: 'm_gws_2',
          type: 'gotcha',
          category: 'best_practice',
          source_kind: 'tool_verified',
          recurrence_count: 5,
          access_count: 5,
          tags: ['workflow'],
          content: 'Cuando una tarea toque Google Workspace, usar el flujo gws: elegir cuenta, verificar identidad, ejecutar, y validar resultado con get/list.',
        }]
      };
    }
  };

  const payload = await skillPromoter.run([], {
    db,
    existingSkillNames: new Set(['gws']),
  });
  assert.strictEqual(payload.ok, true);
  assert.strictEqual(payload.count, 1);
  assert.strictEqual(payload.candidates[0].skillName, 'gws');
  assert.strictEqual(payload.candidates[0].action, 'extend_existing_skill');
}

async function testSkillPromoterPerAgentScanWithFakeDb() {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM brainx_patterns') && !sql.includes("COALESCE(NULLIF(m.agent")) {
        assert.deepStrictEqual(params, [4, 60, 30]);
        return { rows: [] };
      }
      if (sql.includes('FROM brainx_memories') && !sql.includes('GROUP BY 1') && !sql.includes("COALESCE(NULLIF(agent")) {
        assert.deepStrictEqual(params, [4, 60, 30]);
        return { rows: [] };
      }
      if (sql.includes('GROUP BY 1')) {
        assert.deepStrictEqual(params, [4, 60, 2]);
        return {
          rows: [
            { agent: 'writer', rows: 10, typed_rows: 8, candidate_rows: 4, last_seen: '2026-05-23T00:00:00.000Z' },
            { agent: 'raider', rows: 9, typed_rows: 7, candidate_rows: 3, last_seen: '2026-05-23T00:00:00.000Z' },
          ],
        };
      }
      if (sql.includes('FROM brainx_memories') && sql.includes("COALESCE(NULLIF(agent")) {
        assert.strictEqual(params[0], 4);
        assert.strictEqual(params[1], 60);
        assert.strictEqual(params[2], 3);
        if (params[3] !== 'writer') return { rows: [] };
        return {
          rows: [{
            source: 'memory',
            id: 'm_writer_gws',
            type: 'gotcha',
            category: 'best_practice',
            source_kind: 'tool_verified',
            recurrence_count: 5,
            access_count: 5,
            tags: ['workflow'],
            agent: 'writer',
            content: 'Cuando una tarea toque Google Workspace, usar el flujo gws: elegir cuenta, verificar identidad, ejecutar, y validar resultado con get/list.',
          }],
        };
      }
      if (sql.includes('FROM brainx_patterns') && sql.includes("COALESCE(NULLIF(m.agent")) {
        assert.strictEqual(params[2], 3);
        return { rows: [] };
      }
      throw new Error('unexpected query: ' + sql);
    }
  };

  const payload = await skillPromoter.run([
    '--per-agent',
    '--agent-limit', '2',
    '--per-agent-limit', '3',
  ], {
    db,
    existingSkillNames: new Set(['gws']),
  });

  assert.strictEqual(payload.ok, true);
  assert.strictEqual(payload.agentCoverage.agentCount, 2);
  assert.strictEqual(payload.thresholds.perAgent, true);
  assert.strictEqual(payload.count, 1);
  assert.strictEqual(payload.candidates[0].skillName, 'gws');
  assert.strictEqual(payload.candidates[0].action, 'extend_existing_skill');
  assert.ok(calls.length >= 5);
}

async function testSkillPromoterHybridSessionScanWithFakeDb() {
  const sessionsRoot = makeTempSessionsRoot();
  writeTestSession(sessionsRoot, 'writer', 'sess-a', [
    {
      role: 'user',
      text: 'Conversation info (untrusted metadata):\nCurrent user request:\nSiempre usar gws-hello antes de leer Gmail.',
    },
    {
      role: 'assistant',
      text: 'Cuando una tarea toque Google Workspace, usar gws-hello o gws-admin segun el scope antes de leer o escribir.',
    },
  ]);
  writeTestSession(sessionsRoot, 'raider', 'sess-b', [
    {
      role: 'assistant',
      text: 'Antes de operar sobre Gmail, verificar identidad con gws-whoami y validar el resultado con get/list.',
    },
  ]);
  writeTestSession(sessionsRoot, 'kron', 'sess-c', [
    {
      role: 'assistant',
      text: 'Verificar en browser que el botón azul existe.',
    },
  ]);

  assert.deepStrictEqual(
    skillPromoter.extractProceduralInstructions('Conversation info (untrusted metadata):\nCurrent user request:\nSiempre usar gws-hello antes de leer Gmail.'),
    []
  );
  assert.deepStrictEqual(
    skillPromoter.extractProceduralInstructions('Verificar en browser que el link a MDX existe.'),
    []
  );
  assert.deepStrictEqual(
    skillPromotion.extractInstructionBullets('Verificar en browser que el link a MDX existe.'),
    []
  );
  assert.deepStrictEqual(
    skillPromoter.extractProceduralInstructions('Confirmar cada instrucción por similitud semántica, no solo porque cayó en el bucket `playwright`.'),
    []
  );
  assert.deepStrictEqual(
    skillPromoter.extractProceduralInstructions('Antes de cualquier refactor responsive, quitar el clip global y arreglar lo que aparezca.'),
    ['Antes de cualquier refactor responsive, quitar el clip global y arreglar lo que aparezca.']
  );
  assert.deepStrictEqual(
    skillPromotion.extractInstructionBullets('Antes de cualquier refactor responsive, quitar el clip global y arreglar lo que aparezca.'),
    ['- Antes de cualquier refactor responsive, quitar el clip global y arreglar lo que aparezca.']
  );

  let call = 0;
  const db = {
    async query(sql, params) {
      call += 1;
      assert.deepStrictEqual(params, [4, 30, 20]);
      if (call === 1) {
        assert.ok(sql.includes('FROM brainx_patterns'));
        return { rows: [] };
      }
      assert.ok(sql.includes('FROM brainx_memories'));
      return {
        rows: [{
          source: 'memory',
          id: 'm_gws_confirm',
          type: 'gotcha',
          category: 'best_practice',
          source_kind: 'tool_verified',
          recurrence_count: 2,
          access_count: 4,
          tags: ['workflow'],
          agent: 'writer',
          content: 'Cuando una tarea toque Google Workspace, usar el flujo gws: elegir cuenta, verificar identidad, ejecutar, y validar resultado con get/list.',
        }],
      };
    },
  };

  const payload = await skillPromoter.run([
    '--hybrid',
    '--days', '30',
    '--limit', '20',
    '--session-limit', '10',
    '--per-agent-session-limit', '5',
    '--sessions-root', sessionsRoot,
  ], {
    db,
    existingSkillNames: new Set(['gws']),
  });

  assert.strictEqual(payload.ok, true);
  assert.strictEqual(payload.thresholds.hybrid, true);
  assert.strictEqual(payload.sessionCoverage.sessionsScanned, 3);
  assert.strictEqual(payload.sessionCoverage.instructionsExtracted, 2);
  assert.strictEqual(payload.sessionCoverage.confirmedInstructionRows, 2);
  assert.ok(payload.rowsScanned >= 3);
  assert.strictEqual(payload.count, 1);
  assert.strictEqual(payload.candidates[0].skillName, 'gws');
  assert.strictEqual(payload.candidates[0].action, 'extend_existing_skill');
  assert.strictEqual(payload.candidates[0].brainxConfirmed, true);
  assert.ok(payload.candidates[0].sourceKinds.includes('raw_session'));
}

async function testSkillLifecycleHermesStyleSidecarArchiveRestore() {
  const root = makeTempSkillsRoot();
  writeTestSkill(root, 'brainx-demo');

  skillLifecycle.markBrainxCreated('brainx-demo', {
    candidateId: 'cand_1',
    sourceIds: ['m1'],
    skillDir: path.join(root, 'brainx-demo'),
  }, { root });
  skillLifecycle.bumpUse('brainx-demo', { root });
  skillLifecycle.setPinned('brainx-demo', true, { root });

  let rows = skillLifecycle.brainxCreatedReport({ root });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].name, 'brainx-demo');
  assert.strictEqual(rows[0].brainx_created, true);
  assert.strictEqual(rows[0].pinned, true);
  assert.strictEqual(rows[0].activity_count, 2);

  skillLifecycle.setPinned('brainx-demo', false, { root });
  const archived = skillLifecycle.archiveSkill('brainx-demo', { root });
  assert.strictEqual(archived.ok, true);
  assert.strictEqual(fs.existsSync(path.join(root, 'brainx-demo')), false);
  assert.ok(skillLifecycle.listArchivedSkillNames({ root }).includes('brainx-demo'));

  const restored = skillLifecycle.restoreSkill('brainx-demo', { root });
  assert.strictEqual(restored.ok, true);
  assert.strictEqual(fs.existsSync(path.join(root, 'brainx-demo', 'SKILL.md')), true);
  rows = skillLifecycle.brainxCreatedReport({ root });
  assert.strictEqual(rows[0].state, skillLifecycle.STATE_ACTIVE);
}

async function testSkillApplierCreatesSkillAndRollsBackOnValidationFailure() {
  const root = makeTempSkillsRoot();
  const candidate = {
    id: 'cand_new',
    skillName: 'brainx-new-flow',
    action: 'create_new_skill',
    sourceIds: ['m_new'],
    confidence: 0.9,
    recurrence: 5,
    instructions: ['- Siempre validar el resultado con una prueba real antes de reportar listo.'],
    draftSkillMd: [
      '---',
      'name: brainx-new-flow',
      'description: Use when BrainX detects this repeatable validation workflow.',
      '---',
      '# BrainX New Flow',
      '',
      'Use this skill for repeatable validation workflow.',
    ].join('\n'),
  };
  const calls = [];
  const result = skillApplier.applyCandidate(candidate, {
    skillsRoot: root,
    regenScript: null,
    runCommand(command, args) {
      calls.push([command, args]);
      return 'ok';
    },
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(fs.existsSync(path.join(root, 'brainx-new-flow', 'SKILL.md')), true);
  assert.strictEqual(skillLifecycle.isBrainxCreated('brainx-new-flow', { root }), true);
  assert.ok(result.auditFile && fs.existsSync(result.auditFile));
  assert.strictEqual(calls[0][0], 'openclaw');
  assert.deepStrictEqual(calls[0][1], ['skills', 'check']);

  const failing = {
    ...candidate,
    id: 'cand_fail',
    skillName: 'brainx-failing-flow',
    draftSkillMd: candidate.draftSkillMd.replace('brainx-new-flow', 'brainx-failing-flow'),
  };
  assert.throws(() => skillApplier.applyCandidate(failing, {
    skillsRoot: root,
    runCommand() {
      throw new Error('validation failed');
    },
  }), /validation failed/);
  assert.strictEqual(fs.existsSync(path.join(root, 'brainx-failing-flow')), false);
  assert.strictEqual(skillLifecycle.isBrainxCreated('brainx-failing-flow', { root }), false);
}

async function testSkillPromoterAutoCreateHighConfidenceGate() {
  const root = makeTempSkillsRoot();
  const args = skillPromoter.parseArgs([
    '--auto-create',
    '--skills-root', root,
    '--skip-validation',
  ]);
  assert.strictEqual(args.autoCreateMinRecurrence, 2);
  assert.strictEqual(args.autoCreateMinSourceCount, 2);
  const good = {
    id: 'cand_auto',
    skillName: 'brainx-auto-flow',
    action: 'create_new_skill',
    confidence: 0.91,
    recurrence: 2,
    sourceCount: 2,
    sourceIds: ['m_auto_1', 's_auto_1'],
    sourceKinds: ['tool_verified', 'raw_session'],
    sourceSessions: ['s_auto_1', 's_auto_2'],
    brainxConfirmations: ['m_auto_1'],
    brainxConfirmed: true,
    instructions: ['- Siempre cerrar el ciclo con validación real y auditoría.'],
    draftSkillMd: [
      '---',
      'name: brainx-auto-flow',
      'description: Use when BrainX detects a high-confidence auto-created workflow.',
      '---',
      '# BrainX Auto Flow',
      '',
      'Use this skill for repeatable high-confidence workflow automation.',
    ].join('\n'),
  };
  const existingPatch = {
    ...good,
    id: 'cand_patch',
    skillName: 'gws',
    action: 'extend_existing_skill',
  };
  const lowConfidence = {
    ...good,
    id: 'cand_low',
    skillName: 'brainx-low-flow',
    confidence: 0.7,
    draftSkillMd: good.draftSkillMd.replaceAll('brainx-auto-flow', 'brainx-low-flow'),
  };
  const similar = {
    ...good,
    id: 'cand_similar',
    skillName: 'github-review-flow',
    draftSkillMd: good.draftSkillMd.replaceAll('brainx-auto-flow', 'github-review-flow'),
  };

  const gated = skillPromoter.selectAutoCreateCandidates([good, existingPatch, lowConfidence, similar], args, new Set(['github']));
  assert.strictEqual(gated.selected.length, 1);
  assert.strictEqual(gated.selected[0].skillName, 'brainx-auto-flow');
  assert.ok(gated.skipped.some((row) => row.reason === 'not_create_new_skill'));
  assert.ok(gated.skipped.some((row) => row.reason === 'confidence_below_threshold'));
  assert.ok(gated.skipped.some((row) => row.reason === 'similar_existing_skill'));

  const result = skillPromoter.autoCreateCandidates([good, existingPatch], args, {}, new Set());
  assert.strictEqual(result.selected, 1);
  assert.strictEqual(result.errors.length, 0);
  assert.strictEqual(result.applied[0].skillName, 'brainx-auto-flow');
  assert.strictEqual(fs.existsSync(path.join(root, 'brainx-auto-flow', 'SKILL.md')), true);
  assert.strictEqual(skillLifecycle.isBrainxCreated('brainx-auto-flow', { root }), true);
  assert.ok(result.applied[0].auditFile && fs.existsSync(result.applied[0].auditFile));
}

async function testSkillPromoterStyleProcedureCandidate() {
  const existingSkillNames = new Set();
  const rows = [
    {
      source: 'memory',
      id: 'm_style_1',
      pattern_key: 'workflow:communication-style',
      type: 'learning',
      category: 'best_practice',
      source_kind: 'knowledge_canonical',
      recurrence_count: 4,
      access_count: 4,
      tags: ['style', 'communication'],
      content: 'Marcelo prefiere respuestas directas, sin relleno, con formato escaneable y sin tablas markdown en Discord.',
    },
    {
      source: 'memory',
      id: 'm_style_2',
      pattern_key: 'workflow:communication-style',
      type: 'learning',
      category: 'best_practice',
      source_kind: 'tool_verified',
      recurrence_count: 3,
      access_count: 3,
      tags: ['style', 'communication'],
      content: 'El tono debe ser directo y conciso; evitar explicaciones largas cuando solo hace falta una respuesta puntual.',
    },
    {
      source: 'session',
      id: 's_style_1',
      pattern_key: 'raw-session:communication-style:direct-discord',
      type: 'learning',
      category: 'best_practice',
      source_kind: 'raw_session',
      recurrence_count: 1,
      access_count: 0,
      tags: ['workflow', 'raw-session'],
      content: 'Prefiere Discord sin tablas markdown y con una idea por linea para que el reporte sea escaneable.',
      sourceSessions: ['session_style_1'],
      brainxConfirmations: ['m_style_1'],
      brainxConfirmed: true,
    },
  ];
  const rawCandidates = rows
    .map((row) => skillPromotion.createCandidateFromRow(row, { minScore: 0.5, existingSkillNames }))
    .filter(Boolean);
  const grouped = skillPromotion.groupCandidates(rawCandidates);
  assert.strictEqual(grouped.length, 1);
  assert.strictEqual(grouped[0].skillName, 'communication-style');
  assert.strictEqual(grouped[0].action, 'create_new_skill');
  assert.ok(grouped[0].instructions.some((line) => line.includes('sin tablas markdown')));
  assert.ok(grouped[0].reasons.some((reason) => reason.startsWith('style_procedure_terms:')));

  const visualStyleLines = [
    'El estilo "fantasma" se diseño para distinguir candidatos deleted o deactivated del resto.',
    'Por eso ves la página por 1-2 segundos en estilo default antes de que el CSS de Divi se aplique y todo se vuelva rojo/branded.',
    'Cuando uno haga scroll hacia arriba que sea mas smoother, mas sensible, estilo Lenis Smooth.',
    'Veo el CSS del dashboard para extraer el estilo exacto de botones y header.',
  ];
  for (const line of visualStyleLines) {
    assert.strictEqual(skillPromotion.isVisualStyleInstruction(line), true);
    assert.strictEqual(skillPromotion.isCommunicationStyleInstruction(line), false);
    assert.strictEqual(skillPromotion.extractInstructionBullets(line).length, 0);
    const candidate = skillPromotion.createCandidateFromRow({
      source: 'session',
      id: 's_visual_' + visualStyleLines.indexOf(line),
      type: 'learning',
      category: 'best_practice',
      source_kind: 'raw_session',
      recurrence_count: 4,
      tags: ['workflow', 'raw-session'],
      content: line,
      sourceSessions: ['session_visual'],
      brainxConfirmations: ['m_style_1'],
      brainxConfirmed: true,
    }, { minScore: 0.4, existingSkillNames });
    assert.strictEqual(candidate, null);
  }

  const promotionMetaLines = [
    'Ve palabras gatillo como `tono`, `estilo`, `formato`, `respuesta`, `directo`, `tablas`, `sin relleno`.',
    'Señal que intenta capturar: reglas de tono, estructura, formato de respuesta.',
    'Mi veredicto: la idea sí vale muchísimo, el draft actual no.',
  ];
  for (const line of promotionMetaLines) {
    assert.strictEqual(skillPromotion.isPromotionMetaNoise(line), true);
    assert.strictEqual(skillPromotion.extractInstructionBullets(line).length, 0);
    const candidate = skillPromotion.createCandidateFromRow({
      source: 'session',
      id: 's_meta_' + promotionMetaLines.indexOf(line),
      type: 'learning',
      category: 'best_practice',
      source_kind: 'raw_session',
      recurrence_count: 4,
      tags: ['workflow', 'raw-session'],
      content: line,
      sourceSessions: ['session_meta'],
      brainxConfirmations: ['m_style_1'],
      brainxConfirmed: true,
    }, { minScore: 0.4, existingSkillNames });
    assert.strictEqual(candidate, null);
  }
}

async function testSkillPromoterAutoPatchLowRiskGate() {
  const root = makeTempSkillsRoot();
  writeTestSkill(root, 'qa-helper');
  writeTestSkill(root, 'brainx');
  writeTestSkill(root, 'manual-helper');
  skillLifecycle.markBrainxCreated('qa-helper', {
    candidateId: 'cand_seed',
    sourceIds: ['m_seed'],
    skillDir: path.join(root, 'qa-helper'),
  }, { root });
  const args = skillPromoter.parseArgs([
    '--auto-patch',
    '--skills-root', root,
    '--skip-validation',
  ]);
  assert.strictEqual(args.autoPatchMinRecurrence, 2);
  assert.strictEqual(args.autoPatchMinSourceCount, 2);
  const good = {
    id: 'cand_patch_low',
    skillName: 'qa-helper',
    action: 'extend_existing_skill',
    confidence: 0.94,
    recurrence: 2,
    sourceCount: 2,
    sourceIds: ['m_patch_1', 's_patch_1'],
    sourceKinds: ['tool_verified', 'raw_session'],
    sourceSessions: ['s_patch_1'],
    brainxConfirmations: ['m_patch_1'],
    brainxConfirmed: true,
    instructions: ['Siempre validar cambios visuales con una captura real antes de cerrar la tarea.'],
    draftSkillMd: [
      '---',
      'name: qa-helper',
      'description: Use when BrainX detects a low-risk QA workflow patch.',
      '---',
      '# QA Helper',
      '',
      'Use this skill for repeatable QA workflows.',
    ].join('\n'),
  };
  const critical = {
    ...good,
    id: 'cand_patch_critical',
    skillName: 'brainx',
    draftSkillMd: good.draftSkillMd.replaceAll('qa-helper', 'brainx'),
  };
  const risky = {
    ...good,
    id: 'cand_patch_risky',
    skillName: 'qa-helper',
    instructions: ['Siempre guardar token y credenciales de producción en el skill antes de ejecutar.'],
  };
  const manual = {
    ...good,
    id: 'cand_patch_manual',
    skillName: 'manual-helper',
    draftSkillMd: good.draftSkillMd.replaceAll('qa-helper', 'manual-helper'),
  };

  assert.deepStrictEqual(skillApplier.classifyPatchRisk(good).level, 'low');
  assert.deepStrictEqual(skillApplier.classifyPatchRisk(critical).level, 'high');
  assert.deepStrictEqual(skillApplier.classifyPatchRisk(risky).level, 'medium');

  const gated = skillPromoter.selectAutoPatchCandidates([good, critical, risky, manual], args, new Set(['qa-helper', 'brainx', 'manual-helper']));
  assert.strictEqual(gated.selected.length, 2);
  assert.strictEqual(gated.selected[0].skillName, 'qa-helper');
  assert.strictEqual(gated.selected[1].skillName, 'manual-helper');
  assert.ok(gated.skipped.some((row) => row.reason.includes('patch_risk_high:critical_skill')));
  assert.ok(gated.skipped.some((row) => row.reason.includes('patch_risk_medium:risky_terms')));
  const manualReview = skillPromoter.summarizeManualReviewCandidates([good, critical, risky, manual], gated.skipped);
  assert.strictEqual(manualReview.length, 1);
  assert.strictEqual(manualReview[0].skillName, 'brainx');
  assert.strictEqual(manualReview[0].decision, 'manual_patch_required');

  const result = skillPromoter.autoPatchCandidates([good], args, {}, new Set(['qa-helper']));
  assert.strictEqual(result.selected, 1);
  assert.strictEqual(result.errors.length, 0);
  assert.strictEqual(result.applied[0].skillName, 'qa-helper');
  assert.strictEqual(result.applied[0].patchRisk.level, 'low');
  const patched = fs.readFileSync(path.join(root, 'qa-helper', 'SKILL.md'), 'utf8');
  assert.ok(patched.includes('BRAINX-SKILL-PROMOTER:cand_patch_low:start'));
  assert.ok(result.applied[0].auditFile && fs.existsSync(result.applied[0].auditFile));
}

async function testSkillPromoterApplySelectorAndCuratorPrune() {
  const root = makeTempSkillsRoot();
  assert.throws(
    () => skillPromoter.selectApplyCandidates([], skillPromoter.parseArgs(['--apply'])),
    /Refusing --apply/
  );
  const row = {
    source: 'memory',
    id: 'm_project_flow',
    pattern_key: 'workflow:project-intake-flow',
    type: 'learning',
    category: 'best_practice',
    source_kind: 'agent_inference',
    recurrence_count: 6,
    access_count: 6,
    tags: ['workflow'],
    content: 'Siempre leer project-guide, perfil canonico y AGENTS del repo antes de escribir codigo en un proyecto conocido.',
  };
  let call = 0;
  const db = {
    async query() {
      call += 1;
      return call === 1 ? { rows: [] } : { rows: [
        row,
        { ...row, id: 'm_project_flow_2', content: 'Cuando se trabaja en proyecto conocido, usar project-guide primero y validar el perfil canonico antes de editar.' },
        { ...row, id: 'm_project_flow_3', content: 'Antes de escribir codigo en un proyecto conocido, leer AGENTS del repo y verificar el checklist del perfil.' },
      ] };
    }
  };
  const payload = await skillPromoter.run([
    '--apply',
    '--skill', 'project-intake-flow',
    '--skills-root', root,
    '--skip-validation',
  ], {
    db,
    existingSkillNames: new Set(),
  });

  assert.strictEqual(payload.ok, true);
  assert.strictEqual(payload.apply.selected, 1);
  assert.strictEqual(payload.apply.applied[0].skillName, 'project-intake-flow');
  assert.strictEqual(skillLifecycle.isBrainxCreated('project-intake-flow', { root }), true);

  const usage = skillLifecycle.loadUsage(root);
  usage['project-intake-flow'].created_at = '2026-01-01T00:00:00.000Z';
  usage['project-intake-flow'].last_patched_at = null;
  skillLifecycle.saveUsage(usage, root);
  const prunePreview = skillCurator.run(['prune', '--days', '30', '--dry-run', '--root', root]);
  assert.strictEqual(prunePreview.dryRun, true);
  assert.strictEqual(prunePreview.candidates[0].name, 'project-intake-flow');
}

async function testSelfLearningAuditWithFakeDb() {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('COUNT(*)::int AS total')) {
        return { rows: [{ active: 100, hot: 12, warm: 40, total: 120 }] };
      }
      if (sql.includes('stale_unscored')) {
        assert.deepStrictEqual(params, [7]);
        return { rows: [{ injections: 20, selected: 30, hard_referenced: 2, soft_referenced: 8, stale_unscored: 3 }] };
      }
      if (sql.includes('p.times_injected >= $2')) {
        assert.deepStrictEqual(params, [7, 3, 0, 5]);
        return { rows: [{
          id: 'm_noise',
          type: 'note',
          category: 'learning',
          tier: 'hot',
          importance: 6,
          feedback_score: 0,
          times_injected: 9,
          times_referenced: 0,
          preview: 'Generic operational reminder that is injected often but never referenced.',
        }] };
      }
      if (sql.includes('p.times_referenced >= $2')) {
        return { rows: [{
          id: 'm_useful',
          type: 'gotcha',
          category: 'best_practice',
          tier: 'warm',
          importance: 7,
          feedback_score: 2,
          times_injected: 4,
          times_referenced: 3,
          preview: 'Specific verified workflow that agents keep referencing.',
        }] };
      }
      if (sql.includes('created_at < NOW()') && sql.includes('last_accessed')) {
        return { rows: [{
          id: 'm_stale',
          type: 'learning',
          category: 'best_practice',
          tier: 'warm',
          importance: 5,
          access_count: 0,
          feedback_score: 0,
          preview: 'Old memory with no recent usage.',
        }] };
      }
      if (sql.includes('regexp_replace(lower')) {
        return { rows: [{
          fingerprint: 'command failed pnpm lint',
          occurrences: 2,
          ids: ['m_err_2', 'm_err_1'],
          agents: 'writer',
          importance: 7,
          preview: 'Command failed: pnpm lint because config was missing.',
        }] };
      }
      if (sql.includes("category = 'knowledge_gap'")) {
        return { rows: [{
          id: 'm_gap',
          type: 'learning',
          category: 'knowledge_gap',
          status: 'pending',
          tier: 'warm',
          importance: 7,
          preview: 'Missing canonical docs for BrainX self-learning policy.',
        }] };
      }
      if (sql.includes('FROM brainx_query_log')) {
        return { rows: [{ query_kind: 'search', calls: 10, zero_result_calls: 5, avg_results: 1.2 }] };
      }
      throw new Error('unexpected query: ' + sql);
    }
  };

  const payload = await selfLearningAudit.run([
    '--days', '7',
    '--limit', '5',
    '--min-injections', '3',
    '--max-references', '0',
  ], { db });

  assert.strictEqual(payload.ok, true);
  assert.strictEqual(payload.mode, 'read_only');
  assert.strictEqual(payload.summary.recommendation_count, 7);
  assert.ok(payload.summary.autonomy_score < 100);
  const keys = payload.recommendations.map((row) => row.key);
  assert.ok(keys.includes('degrade_noisy_memories'));
  assert.ok(keys.includes('promote_useful_memories'));
  assert.ok(keys.includes('curate_stale_hot_warm_memories'));
  assert.ok(keys.includes('promote_repeated_failures_to_gotchas'));
  assert.ok(keys.includes('fill_open_knowledge_gaps'));
  assert.ok(keys.includes('investigate_low_recall_queries'));
  assert.ok(keys.includes('close_runtime_scoring_backlog'));
  assert.ok(calls.every((call) => !/^\s*(UPDATE|INSERT|DELETE|ALTER|CREATE|DROP)\b/i.test(call.sql)));
}

async function testRecallHealthWarnsOnLowYieldAndIsReadOnly() {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('to_regclass')) return { rows: [{ regclass: 'brainx_runtime_injections' }] };
      if (sql.includes('GROUP BY surface')) {
        return { rows: [
          {
            surface: 'jit_recall',
            calls: 10,
            zero_result_calls: 1,
            zero_selected_calls: 7,
            selected_no_signal_calls: 0,
            no_scorable_output_calls: 2,
            stale_selected_unscored: 0,
            selected_total: 3,
            hard_referenced_total: 0,
            soft_referenced_total: 1,
            avg_latency_ms: '12.5',
            last_seen_at: '2026-05-27T00:00:00.000Z',
          },
          {
            surface: 'project_ground',
            calls: 8,
            zero_result_calls: 0,
            zero_selected_calls: 0,
            selected_no_signal_calls: 7,
            no_scorable_output_calls: 1,
            stale_selected_unscored: 0,
            selected_total: 8,
            hard_referenced_total: 0,
            soft_referenced_total: 0,
            avg_latency_ms: '1.0',
            last_seen_at: '2026-05-27T00:00:00.000Z',
          },
          {
            surface: 'recovery_preflight',
            calls: 6,
            zero_result_calls: 0,
            zero_selected_calls: 0,
            selected_no_signal_calls: 6,
            no_scorable_output_calls: 3,
            stale_selected_unscored: 0,
            selected_total: 6,
            hard_referenced_total: 0,
            soft_referenced_total: 0,
            avg_latency_ms: '2.0',
            last_seen_at: '2026-05-27T00:00:00.000Z',
          },
        ] };
      }
      if (sql.includes('GROUP BY 1, 2')) {
        return { rows: [{
          agent: 'writer',
          surface: 'recovery_preflight',
          calls: 6,
          zero_result_calls: 0,
          zero_selected_calls: 0,
          selected_no_signal_calls: 6,
          no_scorable_output_calls: 3,
          selected_total: 6,
          soft_referenced_total: 0,
          last_seen_at: '2026-05-27T00:00:00.000Z',
        }] };
      }
      // AGENT_ATTRIBUTION_20260601: per-agent query_log breakdown (matches the
      // `agent IS NOT NULL` query). Must be checked before the aggregate
      // `query_kind AS surface` branch since this query contains both strings.
      if (sql.includes('agent IS NOT NULL')) {
        return { rows: [{
          agent: 'matrix',
          surface: 'inject',
          calls: 8,
          zero_result_calls: 8,
          result_total: 0,
          last_seen_at: '2026-05-27T00:00:00.000Z',
        }] };
      }
      if (sql.includes('query_kind AS surface')) {
        return { rows: [{
          surface: 'inject',
          calls: 10,
          zero_result_calls: 5,
          result_total: 12,
          avg_latency_ms: '40.0',
          last_seen_at: '2026-05-27T00:00:00.000Z',
        }] };
      }
      throw new Error('unexpected query: ' + sql);
    },
  };

  const payload = await recallHealth.collectRecallHealth(db, { days: 7, minCalls: 5 });
  assert.strictEqual(payload.status, 'warn');
  assert.ok(payload.surfaces.some((row) => row.surface === 'jit_recall' && row.status === 'ok' && row.notes.includes('high_zero_selected_treated_as_intent_gate_or_router_empty')));
  assert.ok(payload.warnings.some((row) => row.surface === 'inject' && row.warnings.includes('high_zero_result_rate')));
  assert.ok(payload.surfaces.some((row) => row.surface === 'project_ground' && row.status === 'ok' && row.notes.includes('preventive_anchor_surface')));
  assert.ok(payload.warnings.some((row) => row.surface === 'recovery_preflight' && row.warnings.includes('high_selected_no_signal_rate')));
  assert.ok(payload.surfaces.some((row) => row.surface === 'recovery_preflight' && row.no_scorable_output_calls === 3 && row.notes.includes('no_scorable_output_excluded')));
  assert.ok(payload.outliers.some((row) => row.agent === 'writer' && row.surface === 'recovery_preflight'));
  // Per-agent inject regression (matrix, 100% zero-result) surfaces as an outlier.
  assert.ok(payload.outliers.some((row) => row.agent === 'matrix' && row.surface === 'inject' && row.warnings.includes('high_zero_result_rate')));
  assert.ok(calls.some((call) => call.sql.includes("scoring_fallback")));
  assert.ok(calls.every((call) => !/^\s*(UPDATE|INSERT|DELETE|ALTER|CREATE|DROP)\b/i.test(call.sql)));
}

async function testCmdRecallHealthJson() {
  const io = makeIo();
  const db = {
    async query(sql) {
      if (sql.includes('to_regclass')) return { rows: [{ regclass: 'brainx_runtime_injections' }] };
      if (sql.includes('GROUP BY surface')) return { rows: [] };
      if (sql.includes('GROUP BY 1, 2')) return { rows: [] };
      if (sql.includes('query_kind AS surface')) return { rows: [] };
      throw new Error('unexpected query: ' + sql);
    },
  };
  await cli.cmdRecallHealth({ json: true, days: '7' }, { db, ...io.deps });
  const payload = JSON.parse(io.logs[0]);
  assert.strictEqual(payload.ok, true);
  assert.ok(payload.surfaces.some((row) => row.surface === 'jit_recall'));
}

// QUERY_LOG_ADAPTIVE_BASELINE_20260601: inject lives only in brainx_query_log and
// used to be stuck on the fixed cold-start threshold forever (the one surface that
// could not self-calibrate). With a prior-window baseline it must judge itself vs
// its own norm: quiet on healthy diversity, loud only on a genuine regression.
async function testRecallHealthInjectSelfCalibratesVsBaseline() {
  const T = recallHealth.DEFAULT_THRESHOLDS;
  const baseline = {
    calls: 480,
    selected_total: 0,
    zero_result_rate_pct: 5,
    zero_selected_rate_pct: 5,
    selected_no_signal_rate_pct: 0,
    soft_signal_rate_pct: 0,
  };
  const mkRow = (zero) => ({
    surface: 'inject',
    calls: 150,
    zero_result_calls: zero,
    zero_selected_calls: zero,
    selected_no_signal_calls: 0,
    no_scorable_output_calls: 0,
    stale_selected_unscored: 0,
    selected_total: 0,
    soft_referenced_total: 0,
  });

  // Healthy: 4.7% zero-result against a ~5% baseline → adaptive, no warning even
  // though 4.7% would historically read as fine but the path could not prove it.
  const healthy = recallHealth.classifySurface(mkRow(7), T, baseline);
  assert.strictEqual(healthy.calibration.mode, 'adaptive');
  assert.strictEqual(healthy.status, 'ok');
  assert.strictEqual(healthy.warnings.length, 0);

  // Genuine regression: 63% zero-result vs the same low baseline → must warn.
  const regression = recallHealth.classifySurface(mkRow(95), T, baseline);
  assert.strictEqual(regression.calibration.mode, 'adaptive');
  assert.strictEqual(regression.status, 'warn');
  assert.ok(regression.warnings.includes('high_zero_result_rate'));

  // No baseline (cold start) falls back to the fixed threshold, not a crash.
  const cold = recallHealth.classifySurface(mkRow(80), T, null);
  assert.strictEqual(cold.calibration.mode, 'fixed_cold_start');
  assert.strictEqual(cold.status, 'warn');
}

async function testEventLedgerNormalization() {
  const args = eventLedger.parseArgs([
    'add',
    '--type', 'fix',
    '--title', 'ACP context fix',
    '--summary', 'Fixed token=abc123456789 should redact',
    '--project', 'brainx',
    '--domain', 'acp',
    '--tag', 'BrainX',
    '--tag', 'ACP',
    '--file', '/home/clawd/test.js',
    '--metadata', '{"local_dist_patch":true}',
    '--no-embed',
  ]);
  const event = eventLedger.normalizeEvent(args);

  assert.strictEqual(event.event_type, 'fix');
  assert.strictEqual(event.project_key, 'brainx');
  assert.strictEqual(event.domain, 'acp');
  assert.deepStrictEqual(event.tags, ['brainx', 'acp']);
  assert.deepStrictEqual(event.files_touched, ['/home/clawd/test.js']);
  assert.strictEqual(event.metadata.local_dist_patch, true);
  assert.ok(event.summary.includes('token=[REDACTED]'));
  assert.ok(event.id.startsWith('evt_'));
}

async function run() {
  const tests = [
    testCmdAddMetadata,
    testCmdSearchContractAndLogging,
    testCmdInjectGuardrailsAndLogging,
    testCmdResolveLifecycleUpdate,
    testCmdFeedbackIncorrectUsesValidSupersededBy,
    testPromoteCandidatesDefaultsAndJson,
    testMetricsOutput,
    testRuntimeReportHardAndSoftSignal,
    testAgentMetricsConsolidatesConfigAndRuntime,
    testRouterQualitySummarizesRouterDecisions,
    testCmdExplainById,
    testPiiScrubHelpers,
    testSensitivityHelpers,
    testSemanticDedupeMergePlanHelper,
    testPiiAllowlistContextHelper,
    testQualityGateSkipsAcknowledgementNoise,
    testQualityGateSkipsVaguePlaceholder,
    testQualityGateKeepsShortTechnicalSignal,
    testQualityGateDowngradesBorderlineSignal,
    testSemanticConsolidationRejectsRuntimeNoise,
    testSemanticConsolidationPairScopeGuard,
    testSemanticConsolidationMergeClusterPreservesDurableMetadata,
    testSemanticConsolidationMergeClusterDemotesCarriedStaleTier,
    testWeeklyConsolidationScheduleGuard,
    testLifecycleRunPromoteDegradeAndPatternSync,
    testDoctorWrapperScheduleInference,
    testDoctorSurfaceFreshnessClassification,
    testFixOnlyStepParsing,
    testFixOnlyStepResolution,
    testSubcommandHelpDoesNotTouchDb,
    testPromotionGovernanceHelpers,
    testSkillPromotionCandidateGuardrails,
    testSkillPromotionLoadsRuntimeRegistryFirst,
    testSkillPromotionGroupsCandidates,
    testSkillPromotionSuppressesPlaywrightNoisyCandidate,
    testSkillPromotionSuppressesEmailbotProtocolAsGlobalSkill,
    testSkillPromotionGroupsByCanonicalTarget,
    testSkillPromoterDedupeRowsUsesCanonicalMemoryId,
    testSkillPromoterRunWithFakeDb,
    testSkillPromoterPerAgentScanWithFakeDb,
    testSkillPromoterHybridSessionScanWithFakeDb,
    testSkillLifecycleHermesStyleSidecarArchiveRestore,
    testSkillApplierCreatesSkillAndRollsBackOnValidationFailure,
    testSkillPromoterAutoCreateHighConfidenceGate,
    testSkillPromoterStyleProcedureCandidate,
    testSkillPromoterAutoPatchLowRiskGate,
    testSkillPromoterApplySelectorAndCuratorPrune,
    testSelfLearningAuditWithFakeDb,
    testRecallHealthWarnsOnLowYieldAndIsReadOnly,
    testRecallHealthInjectSelfCalibratesVsBaseline,
    testCmdRecallHealthJson,
    testEventLedgerNormalization
  ];

  for (const t of tests) {
    await t();
  }

  console.log(`cli-v5 tests: ${tests.length} passed`);
}

run().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
