-- 013_context_broker_artifact_v2.sql
-- Typed context broker support: artifact provenance/finality + sessionKey state.

ALTER TABLE brainx_artifact_ledger
  ADD COLUMN IF NOT EXISTS artifact_role TEXT DEFAULT 'artifact',
  ADD COLUMN IF NOT EXISTS project_key TEXT,
  ADD COLUMN IF NOT EXISTS provenance TEXT,
  ADD COLUMN IF NOT EXISTS finality_score REAL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_brainx_artifacts_finality_last_seen
  ON brainx_artifact_ledger (finality_score DESC, last_seen DESC);

CREATE TABLE IF NOT EXISTS brainx_context_state (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  session_key TEXT NOT NULL,
  session_id TEXT,
  project_key TEXT,
  runtime_family TEXT,
  turn_intent TEXT,
  last_user_prompt TEXT,
  last_assistant_output TEXT,
  last_artifact_path TEXT,
  last_artifact_role TEXT,
  turn_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (agent, session_key)
);

CREATE INDEX IF NOT EXISTS idx_brainx_context_state_agent_updated
  ON brainx_context_state (agent, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_brainx_context_state_session_key
  ON brainx_context_state (session_key, updated_at DESC);
