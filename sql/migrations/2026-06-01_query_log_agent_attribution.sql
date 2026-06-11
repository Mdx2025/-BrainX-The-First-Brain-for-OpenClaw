-- BrainX query_log agent attribution (production-safe, idempotent)
-- AGENT_ATTRIBUTION_20260601
-- Scope: extend self-healing recall-health from aggregate to per-agent for the
-- query_log-only surfaces (inject).
--
-- Why: brainx_query_log had no per-row attribution, so recall-health could only
-- judge the `inject` surface in aggregate. With `agent` recorded, recall-health
-- detects a single agent whose inject recall regressed even when the aggregate
-- looks healthy — the same per-agent outlier detection runtime_injections already
-- has. cmdInject resolves the agent from --agent / OPENCLAW_AGENT (set by the
-- inject hook), so the column populates automatically at runtime; historical rows
-- keep agent NULL and are skipped by the per-agent path until data accumulates.

ALTER TABLE brainx_query_log ADD COLUMN IF NOT EXISTS agent TEXT;
CREATE INDEX IF NOT EXISTS idx_query_log_agent_kind_created
  ON brainx_query_log (agent, query_kind, created_at DESC);
