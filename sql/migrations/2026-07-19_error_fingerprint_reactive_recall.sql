-- BRAINX_REACTIVE_ERROR_RECALL_FINGERPRINT_20260719
-- Reactive error-recall: when an agent hits a tool/runtime error, look up the
-- fix that already resolved the SAME error (Sentry-style fingerprint exact-match,
-- with a vector fallback). This column stores a normalized, deterministic
-- signature of the error so an agent that phrases the symptom differently still
-- collapses to the same key (text-free-form vector match measured weak at ~0.53,
-- below the 0.55 recall gate — the fingerprint is what fixes that).
--
-- Additive + nullable: in PostgreSQL 11+ an ADD COLUMN with no default and no
-- volatile expression is a catalog-only change (no table rewrite) — safe on the
-- ~37k-row live table. The btree index backs the exact-match lookup path.
-- Populated idempotently by lib/error-recall.js backfillFingerprints() (the plugin
-- write path is intentionally NOT touched — fingerprints are derived, not inserted
-- inline — to keep the 57-agent-blast-radius change minimal).

ALTER TABLE brainx_memories
  ADD COLUMN IF NOT EXISTS error_fingerprint text;

CREATE INDEX IF NOT EXISTS brainx_memories_error_fingerprint_idx
  ON brainx_memories (error_fingerprint)
  WHERE error_fingerprint IS NOT NULL;
