-- 019_brainx_skill_loads_outcome.sql
-- BRAINX_SKILL_LOAD_TRACKING_20260608
-- Add the outcome column to brainx_skill_loads. Closes gap #3 from Spec 2
-- ("What loaded skills turned out wrong/missing" feedback loop): the host
-- agent can now report whether a loaded skill was helpful, wrong, or
-- ignored, and skill-promoter can prefer patching skills with
-- outcome='wrong' or 'ignored' over skills with outcome='helpful'.

ALTER TABLE brainx_skill_loads ADD COLUMN IF NOT EXISTS outcome VARCHAR(20) DEFAULT NULL;

-- CHECK constraint added conditionally because PostgreSQL evaluates
-- table-level constraints on every row, and existing rows have outcome=NULL
-- which is allowed (NULL bypasses CHECK). A guard prevents re-adding the
-- constraint if the migration is re-run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brainx_skill_loads_outcome_check'
      AND conrelid = 'brainx_skill_loads'::regclass
  ) THEN
    ALTER TABLE brainx_skill_loads
      ADD CONSTRAINT brainx_skill_loads_outcome_check
      CHECK (outcome IS NULL OR outcome IN ('helpful','wrong','ignored'));
  END IF;
END $$;
