-- 014_session_rotation_events.sql
-- Durable telemetry for OpenClaw sessionId rotations observed by BrainX.

CREATE TABLE IF NOT EXISTS brainx_session_rotation_events (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  session_key TEXT NOT NULL,
  previous_session_id TEXT NOT NULL,
  current_session_id TEXT NOT NULL,
  previous_updated_at TIMESTAMPTZ,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  trigger_reason TEXT,
  triggered_recovery BOOLEAN DEFAULT FALSE,
  injected_handoff BOOLEAN DEFAULT FALSE,
  missed_reason TEXT,
  prompt_sha CHAR(16),
  prompt_preview TEXT,
  runtime_family TEXT,
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_brainx_session_rotation_event_unique
  ON brainx_session_rotation_events (agent, session_key, previous_session_id, current_session_id, prompt_sha);

CREATE INDEX IF NOT EXISTS idx_brainx_session_rotation_events_agent_detected
  ON brainx_session_rotation_events (agent, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_brainx_session_rotation_events_session_key_detected
  ON brainx_session_rotation_events (session_key, detected_at DESC);
