-- 018_brainx_skill_loads.sql
-- BRAINX_SKILL_LOAD_TRACKING_20260608
-- Audit trail of which skills were loaded/consulted per session/turn.
-- Closes the gap that skill-promoter couldn't preferentially patch the
-- "skill in play" because it never knew which skill that was.
--
-- Replaces the schema sketch from Spec 2 (the spec was for the original
-- `load_kind` taxonomy: 'user_invoked' | 'auto_injected' | 'skill_view' |
-- 'skill_consulted'). The orchestrator delegated the concrete column set
-- with the per-load kind captured via the `source` column so we keep a
-- single descriptive field for both auto-detected and explicitly invoked
-- loads; the field is also extensible to other catalog sources without
-- a CHECK constraint migration.

CREATE TABLE IF NOT EXISTS brainx_skill_loads (
  id           BIGSERIAL PRIMARY KEY,
  session_key  TEXT NOT NULL,
  skill_name   TEXT NOT NULL,
  loaded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  turn_index   INTEGER,
  source       TEXT
);

CREATE INDEX IF NOT EXISTS idx_skill_loads_session_loaded_at ON brainx_skill_loads (session_key, loaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_loads_skill_loaded_at   ON brainx_skill_loads (skill_name, loaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_loads_loaded_at        ON brainx_skill_loads (loaded_at DESC);
