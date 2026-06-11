-- BrainX adaptive policy controller audit trail.
-- Runtime also creates this table defensively with CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS brainx_policy_decisions (
  id BIGSERIAL PRIMARY KEY,
  agent TEXT,
  session_id TEXT,
  session_key TEXT,
  surface TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  prompt_sha CHAR(16),
  prompt_preview TEXT,
  trigger_reason TEXT,
  turn_intent TEXT,
  runtime_family TEXT,
  stats JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_brainx_policy_decisions_agent_created
  ON brainx_policy_decisions (agent, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_brainx_policy_decisions_surface_created
  ON brainx_policy_decisions (surface, created_at DESC);
