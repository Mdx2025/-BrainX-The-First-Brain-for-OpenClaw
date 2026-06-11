-- BrainX migration: extend category constraint to cover domain knowledge buckets
-- used by reclassify-memories.js (RECLASSIFY_EXPAND_20260419).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'brainx_memories_category_check'
  ) THEN
    ALTER TABLE brainx_memories
      DROP CONSTRAINT brainx_memories_category_check;
  END IF;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

ALTER TABLE brainx_memories
  ADD CONSTRAINT brainx_memories_category_check
  CHECK (
    category IS NULL OR
    category IN (
      -- Original generic buckets
      'learning',
      'error',
      'feature_request',
      'correction',
      'knowledge_gap',
      'best_practice',
      'infrastructure',
      'project_registry',
      'personal',
      'financial',
      'contact',
      'preference',
      'goal',
      'relationship',
      'health',
      'business',
      'client',
      'deadline',
      'routine',
      'context',
      -- Domain buckets added 2026-04-19 for reclassify expansion
      'marketing',
      'design',
      'legal',
      'communication',
      'product',
      'operations',
      'content',
      'research'
    )
  );
