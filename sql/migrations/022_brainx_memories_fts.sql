-- BRAINX_SEARCH_HYBRID_FTS_20260702
-- Hybrid retrieval: lexical (FTS) candidate source alongside the vector stage.
-- Why: dense multi-topic memories embed poorly — eval showed 5/11 targets ABSENT
-- from the top-60 vector candidates even at minSimilarity=0.05, while all of them
-- contain exact rare tokens from the query (markers, "dead-letter", project names).
-- Config 'simple' (no stemming): exact lexemes — right for markers/code/mixed ES-EN.
-- The expression MUST match lib/openai-rag.js lex_candidates verbatim for GIN use.
CREATE INDEX IF NOT EXISTS brainx_memories_fts_idx ON brainx_memories
USING GIN (to_tsvector('simple', left(coalesce(content,''),8000) || ' ' || left(coalesce(context,''),500)));
