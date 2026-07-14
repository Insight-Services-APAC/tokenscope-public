-- 0045 — session granularity capture
-- Design: docs/design/session-granularity-sprint.md (WS-1 / WS-2).
--
-- 1) attribution_record.query_source — Claude's per-event query_source attr
--    ('main' or an auxiliary lane like 'generate_session_title'). NULL means
--    "captured before this migration / attr absent" — consumers must render
--    NULL as unknown, never assume 'main'. Not part of the dedup index:
--    same-ms aux/main events to the same model carry distinct request_id
--    (source_run_id), which already disambiguates them.
--
-- 2) attribution_aggregate.token_type — adds the missing dimension to the
--    (currently dormant — no writer, no reader) rollup table so the eventual
--    materializer needs no second migration. NULL = all-types rollup,
--    mirroring the nullable tool/model convention. The unique index is
--    rebuilt to include it.
--
-- 3) v_cost_drift — belt-and-braces cost check: our rate-card cost vs
--    Claude's own per-event cost_usd (carried into metadata.law_cost_usd by
--    the read joiner). The KQL mv-expand duplicates the per-event cost onto
--    every token-type row of a span, so the view aggregates it with MAX per
--    span while SUMming our per-type costs. Only spans captured after this
--    migration carry law_cost_usd; the view simply has no row for older spans.

ALTER TABLE attribution_record ADD COLUMN IF NOT EXISTS query_source text;

ALTER TABLE attribution_aggregate ADD COLUMN IF NOT EXISTS token_type text;

DROP INDEX IF EXISTS attribution_aggregate_scope_unique;
CREATE UNIQUE INDEX IF NOT EXISTS attribution_aggregate_scope_unique
  ON attribution_aggregate (scope_type, scope_id, period_start, period_end,
                            tool, model, token_type);

-- security_invoker (PG15+): run with the QUERYING role's RLS, matching the
-- v_effective_spend / v_finance_reportable_spend convention (mig 0039).
CREATE OR REPLACE VIEW v_cost_drift
WITH (security_invoker = true) AS
SELECT
  instance_id,
  COALESCE(claude_session_id, '')                              AS conversation_key,
  ts_event,
  COALESCE(source_run_id, '')                                  AS span_key,
  MAX(model)                                                   AS model,
  SUM(cost_usd)                                                AS rate_card_cost_usd,
  MAX((metadata->>'law_cost_usd')::numeric)                    AS law_cost_usd,
  SUM(cost_usd) - MAX((metadata->>'law_cost_usd')::numeric)    AS drift_usd
FROM attribution_record
WHERE tool = 'claude-code'
  AND metadata ? 'law_cost_usd'
GROUP BY instance_id, COALESCE(claude_session_id, ''), ts_event,
         COALESCE(source_run_id, '');
