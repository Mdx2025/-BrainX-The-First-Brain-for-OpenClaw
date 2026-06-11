-- BrainX query_log self-test kind separation (production-safe, idempotent)
-- INJECT_SELFTEST_TAG_20260601
-- Scope: let recall-health's self-calibrating thermometer stop measuring itself.
--
-- Root cause: `brainx doctor` runs a fixed sentinel inject probe
-- ("openclaw memory prefix duplication", always 0 results by design) that was
-- logged under query_kind='inject' — the same kind recall-health reads. At doctor's
-- cadence (~20/day) the probe dominated the inject surface (~50% zero-result) and
-- the inject warning could never clear. Self-tests now log under '*_selftest' kinds,
-- which recall-health excludes, so the inject surface reflects real runtime traffic
-- only and self-calibrates against its own baseline.

-- 1) Allow the self-test kinds (also re-asserts 'contradiction_check', which was
--    present in live DBs but missing from the canonical schema CHECK — drift fix).
ALTER TABLE brainx_query_log DROP CONSTRAINT IF EXISTS brainx_query_log_query_kind_check;
ALTER TABLE brainx_query_log ADD CONSTRAINT brainx_query_log_query_kind_check
  CHECK (query_kind IN ('search', 'inject', 'contradiction_check', 'inject_selftest', 'search_selftest'));

-- 2) Backfill: relabel the historical deterministic doctor inject probe as a self-test
--    so both the current and baseline windows are honest immediately. Keyed on the
--    sha256(32) of the fixed probe query "openclaw memory prefix duplication".
UPDATE brainx_query_log
   SET query_kind = 'inject_selftest'
 WHERE query_kind = 'inject'
   AND query_hash = '914ecbde4b9500b6ca9d3da9b2c3c186';
