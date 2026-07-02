-- BRAINX_PLAN_CAPSULE_CONTINUITY_20260614
-- Durable structured execution-plan state for compaction/rotation recovery.

CREATE TABLE IF NOT EXISTS brainx_plan_capsules (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL UNIQUE,
  agent TEXT NOT NULL,
  session_key TEXT NOT NULL,
  session_id TEXT,
  project_key TEXT,
  runtime_family TEXT,
  title TEXT NOT NULL,
  objective TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  current_step_index INTEGER DEFAULT 1,
  source_kind TEXT,
  source_sha CHAR(24),
  confidence REAL DEFAULT 0.8,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_validated_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_brainx_plan_capsules_source
  ON brainx_plan_capsules (agent, session_key, source_sha);

CREATE INDEX IF NOT EXISTS idx_brainx_plan_capsules_active_session
  ON brainx_plan_capsules (agent, session_key, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_brainx_plan_capsules_project_active
  ON brainx_plan_capsules (project_key, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS brainx_plan_steps (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  step_key TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  evidence_refs TEXT[] DEFAULT '{}'::text[],
  artifact_refs TEXT[] DEFAULT '{}'::text[],
  validation_commands TEXT[] DEFAULT '{}'::text[],
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(plan_id, step_index)
);

CREATE INDEX IF NOT EXISTS idx_brainx_plan_steps_plan_index
  ON brainx_plan_steps (plan_id, step_index);
