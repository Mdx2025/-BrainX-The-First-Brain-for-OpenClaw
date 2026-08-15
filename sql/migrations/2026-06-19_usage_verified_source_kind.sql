-- BrainX migration: allow usage_verified as a durable primary source kind.
--
-- The runtime and CLI trust gates have treated usage_verified as PRIMARY since
-- BRAINX_USAGE_VERIFIED_RECALL_LOOP_20260613. This migration aligns the live
-- brainx_memories constraint so the daily usage-verified-promoter can persist
-- those promotions.

ALTER TABLE brainx_memories
  DROP CONSTRAINT IF EXISTS brainx_memories_source_kind_check;

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
      'usage_verified',
      'knowledge_canonical',
      'knowledge_staging',
      'knowledge_generated'
    )
  );
