-- Explainable JIT recall decisions.
-- Stores compact, non-blocking diagnostics for why candidate memories were
-- selected or dropped. This is telemetry only; it does not change injection
-- behavior.

ALTER TABLE brainx_runtime_injections
  ADD COLUMN IF NOT EXISTS decision_summary JSONB,
  ADD COLUMN IF NOT EXISTS top_candidates JSONB;
