-- BrainX V5 Migration: add verification_state to memory governance

ALTER TABLE brainx_memories
  ADD COLUMN IF NOT EXISTS verification_state TEXT DEFAULT 'hypothesis';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brainx_memories_verification_state_check'
  ) THEN
    ALTER TABLE brainx_memories
      ADD CONSTRAINT brainx_memories_verification_state_check
      CHECK (
        verification_state IS NULL OR
        verification_state IN ('verified', 'hypothesis', 'changelog', 'obsolete')
      );
  END IF;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_mem_verification_state
  ON brainx_memories (verification_state);

UPDATE brainx_memories
SET verification_state = CASE
  WHEN superseded_by IS NOT NULL THEN 'obsolete'
  WHEN COALESCE(source_kind, '') IN ('consolidated', 'tool_verified', 'regex_extraction')
       AND type IN ('fact', 'decision', 'gotcha') THEN 'verified'
  WHEN COALESCE(source_kind, '') = 'llm_distilled'
       AND COALESCE(confidence_score, 0.7) >= 0.85
       AND type IN ('fact', 'decision', 'gotcha') THEN 'verified'
  WHEN type = 'note' THEN 'changelog'
  WHEN COALESCE(source_kind, '') IN ('markdown_import', 'agent_inference') THEN 'changelog'
  ELSE COALESCE(verification_state, 'hypothesis')
END
WHERE COALESCE(verification_state, 'hypothesis') = 'hypothesis';
