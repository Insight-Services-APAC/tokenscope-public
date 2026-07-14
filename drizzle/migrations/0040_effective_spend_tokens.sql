-- 0040: add `tokens` to the effective-spend views (Stream A).
--
-- The finance rollups report a token total alongside cost. When they switch from
-- `attribution_record` to v_finance_reportable_spend (the cross-charge gate), the
-- view must carry tokens. Reconciliation rows are USD-denominated (a signed delta),
-- not token-denominated, so they contribute 0 tokens. cost_basis stays OFF the view
-- (it's a fidelity axis read directly from attribution_record, not money).
--
-- Recreated (DROP + CREATE) rather than CREATE OR REPLACE because appending a column
-- mid-list + the dependent SELECT * view is cleaner to recreate. security_invoker
-- preserved (the views run with the querying role's RLS).

DROP VIEW IF EXISTS v_finance_reportable_spend;
DROP VIEW IF EXISTS v_effective_spend;

CREATE VIEW v_effective_spend
WITH (security_invoker = true) AS
SELECT
  ar.id                AS source_id,
  'attribution'::text  AS source,
  ar.teammate_id,
  ar.region_id,
  ar.org_unit_id,
  ar.cost_owning_unit_id,
  ar.project_id,
  ar.tool,
  ar.model,
  NULL::text           AS category,
  ar.ts_event          AS occurred_at,
  ar.cost_usd,
  ar.tokens,
  CASE
    WHEN ar.cost_basis = 'telemetry-only' THEN 'indicative'
    ELSE 'estimated'
  END                  AS spend_class
FROM attribution_record ar
UNION ALL
SELECT
  rr.id                AS source_id,
  'reconciliation'::text AS source,
  rr.teammate_id,
  rr.region_id,
  rr.org_unit_id,
  rr.cost_owning_unit_id,
  rr.project_id,
  NULL::text           AS tool,
  NULL::text           AS model,
  rr.category,
  -- Bucket by the SPEND period, not when the engine ran — else a walk-back (gated
  -- past the lag buffer, so always computed in a later period) or a month-boundary
  -- re-pull lands in the wrong finance month. Cast in UTC EXPLICITLY: period_date is
  -- a bare DATE, and a plain ::timestamptz uses the session TimeZone, which would
  -- shift the month boundary under a non-UTC server (e.g. Australia/Sydney).
  (rr.period_date::timestamp AT TIME ZONE 'UTC') AS occurred_at,
  rr.delta_usd         AS cost_usd,
  0::bigint            AS tokens,
  rr.spend_class
FROM reconciliation_record rr
WHERE rr.status = 'applied';

CREATE VIEW v_finance_reportable_spend
WITH (security_invoker = true) AS
SELECT * FROM v_effective_spend WHERE spend_class <> 'indicative';
