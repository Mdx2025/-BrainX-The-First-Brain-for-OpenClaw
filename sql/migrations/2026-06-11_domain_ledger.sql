-- BrainX Domain Ledger
-- Global candidate ledger for personal/business domains: finance, accounting,
-- crypto/trading, proposals, emails, clients, and personal commitments.
-- Workspace memory remains local continuity; this table is the global structured
-- candidate surface. Transcript-derived rows should stay candidate/hypothesis
-- until verified by a tool or an explicit user confirmation.

CREATE TABLE IF NOT EXISTS brainx_domain_ledger (
  id TEXT PRIMARY KEY,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  occurred_at TIMESTAMPTZ,
  domain TEXT NOT NULL,
  record_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate',
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  amount NUMERIC,
  currency TEXT,
  counterparty TEXT,
  project_key TEXT,
  client_key TEXT,
  agent TEXT,
  session_key TEXT,
  session_id TEXT,
  source_kind TEXT NOT NULL DEFAULT 'agent_inference',
  source_path TEXT,
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  sensitivity TEXT NOT NULL DEFAULT 'sensitive',
  verification_state TEXT NOT NULL DEFAULT 'hypothesis',
  confidence REAL NOT NULL DEFAULT 0.65,
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  superseded_by TEXT,
  seen_count INTEGER NOT NULL DEFAULT 1,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS brainx_domain_ledger_occurred_idx
  ON brainx_domain_ledger (occurred_at DESC);

CREATE INDEX IF NOT EXISTS brainx_domain_ledger_domain_status_idx
  ON brainx_domain_ledger (domain, status, occurred_at DESC);

CREATE INDEX IF NOT EXISTS brainx_domain_ledger_record_type_idx
  ON brainx_domain_ledger (record_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS brainx_domain_ledger_agent_idx
  ON brainx_domain_ledger (agent, occurred_at DESC);

CREATE INDEX IF NOT EXISTS brainx_domain_ledger_tags_gin_idx
  ON brainx_domain_ledger USING GIN (tags);

CREATE INDEX IF NOT EXISTS brainx_domain_ledger_metadata_gin_idx
  ON brainx_domain_ledger USING GIN (metadata);
