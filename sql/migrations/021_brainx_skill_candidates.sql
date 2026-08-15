-- 021_brainx_skill_candidates.sql
-- BRAINX_SKILL_CANDIDATE_LEDGER_20260630
-- Persistent ledger of skill-promotion candidates and their disposition across
-- background-review runs. Before this, candidates were ephemeral per-run: the same
-- contaminated / rejected candidate was re-proposed every 6h and the loop had no
-- memory of what it had already rejected or applied. This table is the loop's memory.
--
-- Additive and reversible: DROP TABLE brainx_skill_candidates; restores prior state.
-- Nothing else reads it yet; skill-promoter records into it fail-safe (errors ignored).

CREATE TABLE IF NOT EXISTS brainx_skill_candidates (
  fingerprint     TEXT PRIMARY KEY,                 -- stable hash(skillName|action|sorted instructions)
  candidate_id    TEXT,                             -- skill-promoter candidate.id (may change run-to-run)
  skill_name      TEXT NOT NULL,
  action          TEXT NOT NULL,                    -- create_new_skill | extend_existing_skill | project-doc
  target_kind     TEXT,
  target_project  TEXT,
  canonical_key   TEXT,
  confidence      REAL,
  score           REAL,
  recurrence      INTEGER,
  source_kinds    TEXT[],
  source_ids      TEXT[],
  instructions    JSONB,                            -- the candidate instruction bullets at last sighting
  status          TEXT NOT NULL DEFAULT 'proposed', -- proposed|skipped_gate|applied|reverted|manual_review|approved
  status_reason   TEXT,                             -- gate/skip reason or revert reason
  seen_count      INTEGER NOT NULL DEFAULT 1,       -- how many runs proposed this fingerprint
  applied_count   INTEGER NOT NULL DEFAULT 0,
  applied_marker  TEXT,                             -- BrainX patch marker / audit id when applied
  last_run_id     TEXT,
  first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at      TIMESTAMPTZ,
  reverted_at     TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_skill_candidates_skill   ON brainx_skill_candidates (skill_name);
CREATE INDEX IF NOT EXISTS idx_skill_candidates_status  ON brainx_skill_candidates (status);
CREATE INDEX IF NOT EXISTS idx_skill_candidates_lastseen ON brainx_skill_candidates (last_seen DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brainx_skill_candidates_status_check'
      AND conrelid = 'brainx_skill_candidates'::regclass
  ) THEN
    ALTER TABLE brainx_skill_candidates
      ADD CONSTRAINT brainx_skill_candidates_status_check
      CHECK (status IN ('proposed','skipped_gate','applied','reverted','manual_review','approved'));
  END IF;
END $$;
