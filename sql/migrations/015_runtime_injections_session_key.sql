-- 015_runtime_injections_session_key.sql
-- Persist session_key so scoring can close telemetry after in-memory cache loss.

ALTER TABLE brainx_runtime_injections
  ADD COLUMN IF NOT EXISTS session_key TEXT;

CREATE INDEX IF NOT EXISTS idx_runtime_inj_session_key
  ON brainx_runtime_injections (session_key, injected_at DESC);
