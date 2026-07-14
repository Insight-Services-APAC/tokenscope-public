-- 0059: emit-on-install + provisional attribution — BILL-ANCHORED finance (slice 4).
-- See docs/design/emit-on-install-provisional-attribution.md §"finance = the bill".
--
-- THE MODEL (authoritative, simple): finance = the provider bill (`actual_spend`)
-- per user, homed to that user's cost-owning unit. OTel is ONLY the project overlay
-- (the tagged split) plus the untagged remainder. There is NO coverage gate — money
-- never waits on a per-(teammate, day) reconciliation marker; the bill IS the truth
-- and it already names both the amount and the person (actor.email -> teammate).
--
-- This REVERTS v_finance_reportable_spend to its gate-free 0056 body (the earlier
-- slice-4 draft turned it into a fail-closed coverage gate; that approach is dropped
-- with reconciliation_coverage) and adds the two bill-anchored views below.
--
-- v_finance_reportable_spend stays the OTel-side view (raw + cold rollup + applied
-- reconciliation deltas, advisory excluded) — it still powers the project overlay's
-- tagged operand and the non-finance signal surfaces. The CHARGEABLE truth is the
-- bill, surfaced by v_finance_bill_chargeback / v_finance_project_overlay.

-- 1. Revert the cross-charge view to the gate-free 0056 body. Column list is
--    byte-identical to 0056/0059-draft so CREATE OR REPLACE is legal.
CREATE OR REPLACE VIEW v_finance_reportable_spend WITH (security_invoker = true) AS
  SELECT source_id, source, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id,
         tool, model, category, occurred_at, cost_usd, tokens, spend_class
    FROM v_effective_spend
   WHERE spend_class <> 'indicative'::text;

-- 2. v_finance_bill_chargeback — the chargeable truth. One row per
--    (teammate, day, tool) bill, homed to the NEAREST cost-owning ancestor of the
--    teammate's org_unit via LTREE. A teammate with no cost-owning ancestor ->
--    cost_owning_unit_id NULL (the unallocated bucket). Sums across actual_spend
--    `source` (a teammate active in several reconciled orgs has one row per org;
--    the day's bill is their total).
CREATE VIEW v_finance_bill_chargeback WITH (security_invoker = true) AS
SELECT a.teammate_id, a.date AS period_date, a.tool, cc.cost_owning_unit_id, cc.region_id,
       SUM(a.cost_usd) AS bill_usd, SUM(a.input_tokens + a.output_tokens) AS bill_tokens
FROM actual_spend a JOIN teammate t ON t.id = a.teammate_id
LEFT JOIN LATERAL (
  SELECT anc.id AS cost_owning_unit_id, anc.region_id
  FROM org_unit home JOIN org_unit anc ON home.path <@ anc.path
  WHERE home.id = t.org_unit_id AND anc.is_cost_owning_unit = TRUE AND anc.retired_at IS NULL
  ORDER BY nlevel(anc.path) DESC LIMIT 1
) cc ON TRUE
GROUP BY a.teammate_id, a.date, a.tool, cc.cost_owning_unit_id, cc.region_id;

-- 3. v_finance_project_overlay — the bill SPLIT into tagged projects (scaled so it
--    never exceeds the bill) plus the untagged remainder. By construction the rows
--    for a (teammate, day, tool) sum back to bill_usd:
--      * bill + zero OTel        -> all untagged (= bill)
--      * OTel < bill             -> untagged = bill - tagged
--      * OTel > bill             -> tagged scaled down to the bill, untagged = 0
--    The tagged operand is OTel-attributed, project-tagged, non-advisory spend.
CREATE VIEW v_finance_project_overlay WITH (security_invoker = true) AS
WITH tagged AS (
  SELECT es.teammate_id, (es.occurred_at AT TIME ZONE 'UTC')::date AS period_date, es.tool, es.project_id,
         SUM(es.cost_usd) AS otel_usd
  FROM v_effective_spend es
  WHERE es.spend_class <> 'indicative' AND es.source IN ('attribution','rollup') AND es.project_id IS NOT NULL
  GROUP BY es.teammate_id, (es.occurred_at AT TIME ZONE 'UTC')::date, es.tool, es.project_id),
tagged_tot AS (SELECT teammate_id, period_date, tool, SUM(otel_usd) AS tagged_otel FROM tagged GROUP BY 1,2,3)
SELECT b.cost_owning_unit_id, b.region_id, b.teammate_id, b.period_date, b.tool, g.project_id,
       g.otel_usd * LEAST(1, b.bill_usd / NULLIF(tt.tagged_otel,0)) AS charge_usd
FROM v_finance_bill_chargeback b JOIN tagged_tot tt USING (teammate_id, period_date, tool)
JOIN tagged g USING (teammate_id, period_date, tool)
UNION ALL
SELECT b.cost_owning_unit_id, b.region_id, b.teammate_id, b.period_date, b.tool, NULL::uuid,
       GREATEST(0, b.bill_usd - COALESCE(tt.tagged_otel,0))
FROM v_finance_bill_chargeback b LEFT JOIN tagged_tot tt USING (teammate_id, period_date, tool);
