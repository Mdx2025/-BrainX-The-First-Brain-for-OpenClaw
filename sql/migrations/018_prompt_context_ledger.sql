-- 018_prompt_context_ledger.sql
-- Prompt/context observability ledger.
-- Stores structured size metadata only; no raw prompt text is persisted.

CREATE TABLE IF NOT EXISTS brainx_prompt_context_ledger (
  id BIGSERIAL PRIMARY KEY,
  observed_at TIMESTAMPTZ DEFAULT NOW(),
  agent VARCHAR(80),
  runtime_family VARCHAR(40),
  provider VARCHAR(80),
  model TEXT,
  session_id VARCHAR(128),
  session_key TEXT,
  hook VARCHAR(80) DEFAULT 'prompt_context_built',
  marker TEXT,
  source VARCHAR(40),
  report_source VARCHAR(40),
  system_prompt_chars INT DEFAULT 0,
  project_context_chars INT DEFAULT 0,
  non_project_context_chars INT DEFAULT 0,
  bootstrap_chars INT DEFAULT 0,
  bootstrap_file_count INT DEFAULT 0,
  skills_chars INT DEFAULT 0,
  skill_count INT DEFAULT 0,
  tool_schema_chars INT DEFAULT 0,
  tool_count INT DEFAULT 0,
  current_turn_prompt_chars INT DEFAULT 0,
  current_turn_runtime_context_chars INT DEFAULT 0,
  total_tracked_chars INT DEFAULT 0,
  system_prompt_hash TEXT,
  report JSONB,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_brainx_prompt_context_agent_observed
  ON brainx_prompt_context_ledger (agent, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_brainx_prompt_context_session_key_observed
  ON brainx_prompt_context_ledger (session_key, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_brainx_prompt_context_provider_observed
  ON brainx_prompt_context_ledger (provider, observed_at DESC);
