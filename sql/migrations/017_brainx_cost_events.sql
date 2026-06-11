-- 017_brainx_cost_events.sql
-- BRAINX_COST_TRACKING_20260608
-- Per-operation LLM cost ledger.
-- One row per LLM call. Tracked from inside openai-rag.js, embedding-client.js,
-- agent-llm.js, and the plugin router (extensions/brainx/src/bridge.ts).
-- Cost is derived from brainx_model_pricing at insert time so reports stay
-- correct when OpenAI changes a price (only the table needs updating).

CREATE TABLE IF NOT EXISTS brainx_cost_events (
  id              BIGSERIAL PRIMARY KEY,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  operation_type  TEXT NOT NULL CHECK (operation_type IN (
    'embedding_add',
    'embedding_search',
    'embedding_inject',
    'router_classify',
    'distill_or_recap'
  )),
  model           TEXT NOT NULL,
  provider        TEXT NOT NULL DEFAULT 'openai',
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  total_tokens    INTEGER,
  cost_usd        NUMERIC(12,6) NOT NULL,
  agent_id        TEXT,
  session_id      TEXT,
  surface         TEXT,
  call_site       TEXT,
  request_id      TEXT,
  duration_ms     INTEGER,
  status          TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error', 'rate_limited')),
  error_message   TEXT
);

CREATE INDEX IF NOT EXISTS idx_cost_events_occurred      ON brainx_cost_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_cost_events_agent_occurred ON brainx_cost_events (agent_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_cost_events_op_occurred   ON brainx_cost_events (operation_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_cost_events_model_occurred ON brainx_cost_events (model, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_cost_events_surface_occurred ON brainx_cost_events (surface, occurred_at DESC);

-- Pricing table — single source of truth for cost derivation.
-- Update when providers change prices; cost_usd is computed at write time.
CREATE TABLE IF NOT EXISTS brainx_model_pricing (
  model           TEXT PRIMARY KEY,
  input_per_1k    NUMERIC(12,6) NOT NULL,
  output_per_1k   NUMERIC(12,6) NOT NULL,
  effective_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes           TEXT
);

-- Seed: OpenAI public pricing as of 2026-06-08.
INSERT INTO brainx_model_pricing (model, input_per_1k, output_per_1k, notes) VALUES
  ('text-embedding-3-small', 0.000020, 0.000000, 'OpenAI embeddings; 1536d default'),
  ('text-embedding-3-large', 0.000130, 0.000000, 'OpenAI embeddings; 3072d'),
  ('gpt-5.4-mini',           0.000250, 0.002000, 'BrainX router_llm default'),
  ('gpt-5-mini',             0.000250, 0.002000, 'Likely fallback for distill jobs'),
  ('gpt-4o-mini',            0.000150, 0.000600, 'OpenAI gpt-4o-mini'),
  ('gpt-4o',                 0.002500, 0.010000, 'OpenAI gpt-4o')
ON CONFLICT (model) DO NOTHING;
