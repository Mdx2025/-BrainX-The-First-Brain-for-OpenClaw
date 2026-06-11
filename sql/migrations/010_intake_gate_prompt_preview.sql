-- 010_intake_gate_prompt_preview.sql
-- Add a bounded prompt excerpt to intake gate telemetry so skipped/fired
-- prompt decisions can be audited without joining against runtime injections.

ALTER TABLE brainx_intake_gates
  ADD COLUMN IF NOT EXISTS prompt_preview TEXT;
