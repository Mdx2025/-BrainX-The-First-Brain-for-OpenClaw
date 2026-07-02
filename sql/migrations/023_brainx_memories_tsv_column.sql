-- BRAINX_SEARCH_HYBRID_FTS_20260702 (parte 2): tsvector ALMACENADO.
-- La expresión inline obligaba a recomputar to_tsvector por fila matcheada en
-- ts_rank (~2.3k filas densas por query) → +250ms p50. La columna generada se
-- mantiene sola (GENERATED ALWAYS ... STORED) y el índice pasa a la columna.
ALTER TABLE brainx_memories
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', left(coalesce(content,''),8000) || ' ' || left(coalesce(context,''),500))) STORED;

CREATE INDEX IF NOT EXISTS brainx_memories_tsv_idx ON brainx_memories USING GIN (content_tsv);

-- El índice de expresión de la migración 022 queda superseded por la columna.
DROP INDEX IF EXISTS brainx_memories_fts_idx;
