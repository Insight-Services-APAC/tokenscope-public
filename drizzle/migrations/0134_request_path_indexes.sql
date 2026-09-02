-- 0134 — covering indexes for the request-path scans that had none.
-- Design + measurements: docs/design/request-floor-performance.md.
--
-- provider_usage_fact: every windowed read filters bare `date`
-- (engine/tier-exposure.ts, engine/billed-axis.ts) or the arm-2/3 expression
-- `(date::timestamp AT TIME ZONE 'UTC')` (v_complete_usage arm 3,
-- v_usage_month_floor's MIN — 0133's own header concedes it scans). 0126 built
-- the expression index for the OTHER three fill-arm tables and skipped this
-- one. Both shapes get an index; the expression one also gives ANALYZE
-- per-expression statistics (the 0126 D2 rationale, verbatim shape).
--
-- allocation: reads are keyed `(scope_type, scope_id [, allocation_kind])`
-- (usage/consumption.ts fetchProjectAllocations, engine/budget-axis.ts,
-- engine/usage-coverage.ts, me/inbox LATERAL). The only index carrying
-- scope columns is the partial GiST EXCLUDE, which (a) is a constraint
-- shape, not a probe shape, and (b) excludes every `top-up` row.
--
-- reconciliation_record: `MIN(period_date)` (reports/meta.get.ts) has no
-- leading-column index — `(teammate_id, period_date)` cannot serve it.
--
-- session_quarantine: the arm-1 anti-join probe
-- `(teammate_id, conversation_id) WHERE resolved_at IS NULL` appears in
-- v_complete_usage arm 1 and three request-path queries; existing indexes
-- lead on conversation_id+instance_id or bare teammate_id.
--
-- LOCK WINDOW: one transaction, plain CREATE INDEX (blocks writes, not
-- reads) — the 0121/0126 shape; sub-second at current scale. lock_timeout
-- bounds the other direction: a busy writer (a mid-run ingest worker) makes
-- this migration ABORT and retry at the next deploy, instead of queuing
-- behind the writer while holding SHARE locks on the tables already indexed.
-- The CONCURRENTLY escape hatch is a follow-up migration if these tables
-- grow to where a deploy-time write stall matters.
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS provider_usage_fact_date_idx
  ON provider_usage_fact (date);
CREATE INDEX IF NOT EXISTS provider_usage_fact_date_utc_idx
  ON provider_usage_fact ((date::timestamp AT TIME ZONE 'UTC'));
CREATE INDEX IF NOT EXISTS allocation_scope_kind_idx
  ON allocation (scope_type, scope_id, allocation_kind);
CREATE INDEX IF NOT EXISTS reconciliation_record_period_date_idx
  ON reconciliation_record (period_date);
CREATE INDEX IF NOT EXISTS session_quarantine_teammate_conv_open_idx
  ON session_quarantine (teammate_id, conversation_id)
  WHERE resolved_at IS NULL;

ANALYZE provider_usage_fact;
ANALYZE allocation;
ANALYZE reconciliation_record;
ANALYZE session_quarantine;
