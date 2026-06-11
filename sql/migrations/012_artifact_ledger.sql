-- 012_artifact_ledger.sql
-- Durable artifact ledger for mandatory recovery preflight.

CREATE TABLE IF NOT EXISTS brainx_artifact_ledger (
  id TEXT PRIMARY KEY,
  agent TEXT,
  session_key TEXT,
  session_id TEXT,
  artifact_path TEXT NOT NULL,
  artifact_kind TEXT,
  summary TEXT,
  source TEXT,
  seen_count INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (agent, session_key, artifact_path)
);

CREATE INDEX IF NOT EXISTS idx_brainx_artifacts_agent_last_seen
  ON brainx_artifact_ledger (agent, last_seen DESC);

CREATE INDEX IF NOT EXISTS idx_brainx_artifacts_session_key_last_seen
  ON brainx_artifact_ledger (session_key, last_seen DESC);
