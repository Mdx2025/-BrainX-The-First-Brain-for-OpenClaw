-- BrainX V5 Migration: extend source_kind constraint for knowledge base provenance

ALTER TABLE brainx_memories
  ADD COLUMN IF NOT EXISTS source_kind TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'brainx_memories_source_kind_check'
  ) THEN
    ALTER TABLE brainx_memories
      DROP CONSTRAINT brainx_memories_source_kind_check;
  END IF;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

ALTER TABLE brainx_memories
  ADD CONSTRAINT brainx_memories_source_kind_check
  CHECK (
    source_kind IS NULL OR
    source_kind IN (
      'user_explicit',
      'agent_inference',
      'tool_verified',
      'llm_distilled',
      'markdown_import',
      'regex_extraction',
      'summary_derived',
      'consolidated',
      'auto_distilled',
      'knowledge_canonical',
      'knowledge_staging',
      'knowledge_generated'
    )
  );
