-- Behavioural usage signals — a name-keyed, NON-additive telemetry lane separate
-- from the token ledger (Copilot tool/MCP/context/turn signals).
-- Design: docs/design/copilot-usage-signals.md
--
-- One row per (emitting span, signal). `value` is a per-observation gauge
-- aggregated ON READ (count/sum/min/max via fetchSignalCells) — NEVER summed as
-- spend, so this table is deliberately NOT part of attribution_aggregate. It
-- generalises the spend_session_daily "non-additive companion" precedent (0053)
-- to be name-keyed: a new signal is a new row value, never a migration.
CREATE TABLE IF NOT EXISTS usage_signal_record (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id   uuid NOT NULL REFERENCES instance_attestation(instance_id),
  teammate_id   uuid NOT NULL REFERENCES teammate(id),
  tool          text NOT NULL,
  signal_name   text NOT NULL,
  value         numeric(20,4) NOT NULL CHECK (value >= 0),
  ts_event      timestamptz NOT NULL,
  ts_recorded   timestamptz NOT NULL DEFAULT now(),
  source_run_id text
);

-- Dedup: ONE observation per (instance, emitting span, signal). source_run_id is
-- the span id (distinct for chat vs invoke_agent), so the reader's overlapping
-- high-water-mark re-reads are idempotent under ON CONFLICT DO NOTHING. COALESCE
-- guards a null/absent span id. ts_event is INCLUDED as the discriminator of last
-- resort: if two DISTINCT spans both arrive with an empty span id (the wire shape
-- doesn't guarantee one), the COALESCE('') would otherwise collapse them onto one
-- key and silently drop the second real observation — ts_event (= stable
-- TimeGenerated, reproduced on every re-read) keeps them distinct, mirroring the
-- token ledger's key which also carries ts_event. (Expression index → lives here,
-- not in the drizzle schema def.)
--
-- COUPLING: ts_event = reader `_ts = TimeGenerated`, which is STABLE across re-reads
-- ONLY because we ingest via the service-managed Microsoft-OTLP-Logs stream, where
-- TimeGenerated = the record's time_unix_nano (= the span's endTime, reproduced on
-- every re-forward). If the ingestion topology ever moves to a custom DCR transform
-- that fabricates TimeGenerated = now(), this key would re-write the SAME observation
-- every tick — re-examine the dedup key then. (Same dependency the token ledger rides.)
CREATE UNIQUE INDEX IF NOT EXISTS usage_signal_record_dedup_unique
  ON usage_signal_record (instance_id, COALESCE(source_run_id, ''), signal_name, ts_event);

-- Read path: fetchSignalCells scans one teammate's trailing 28-day window.
CREATE INDEX IF NOT EXISTS usage_signal_record_teammate_event
  ON usage_signal_record (teammate_id, ts_event);

-- RLS — teammate-self read (privacy: a developer sees only their OWN behavioural
-- signals), admins/global-finops see all. Mirrors insight_ack (0046). The
-- reconciliation worker writes via the RLS-exempt owner role exactly as it writes
-- attribution_record; fetchSignalCells additionally filters teammate_id explicitly
-- so read scoping is correct even where RLS is bypassed.
ALTER TABLE usage_signal_record ENABLE ROW LEVEL SECURITY;

CREATE POLICY usage_signal_record_self ON usage_signal_record
  FOR ALL
  USING (teammate_id::text = current_setting('app.user_teammate_id', true))
  WITH CHECK (teammate_id::text = current_setting('app.user_teammate_id', true));

CREATE POLICY usage_signal_record_admin ON usage_signal_record
  FOR ALL
  USING (current_setting('app.user_role', true) IN ('global-finops', 'admin'));
