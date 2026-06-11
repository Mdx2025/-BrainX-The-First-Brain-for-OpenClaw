-- 009_runtime_injections.sql
-- Observability for plugin-driven recall injections:
-- what got injected, what the agent actually referenced, what was filtered as near-dup.

CREATE TABLE IF NOT EXISTS brainx_runtime_injections (
  id BIGSERIAL PRIMARY KEY,
  agent VARCHAR(80),
  session_id VARCHAR(128),
  surface VARCHAR(32) NOT NULL,
  memory_ids TEXT[] DEFAULT '{}',
  similarities REAL[] DEFAULT '{}',
  importances SMALLINT[] DEFAULT '{}',
  raw_count INT DEFAULT 0,
  filtered_count INT DEFAULT 0,
  selected_count INT DEFAULT 0,
  near_dup_dropped INT DEFAULT 0,
  signal_gate_dropped INT DEFAULT 0,
  prompt_sha CHAR(16),
  prompt_preview TEXT,
  response_sha CHAR(16),
  referenced_count INT,
  referenced_ids TEXT[],
  latency_ms INT,
  injected_at TIMESTAMPTZ DEFAULT NOW(),
  scored_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_runtime_inj_agent ON brainx_runtime_injections (agent, injected_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_inj_session ON brainx_runtime_injections (session_id, injected_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_inj_surface ON brainx_runtime_injections (surface, injected_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_inj_unscored ON brainx_runtime_injections (session_id) WHERE scored_at IS NULL;
