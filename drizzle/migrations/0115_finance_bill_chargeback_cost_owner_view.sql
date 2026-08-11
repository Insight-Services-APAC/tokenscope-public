-- 0115 — v_finance_bill_chargeback reads the shared cost-owner map (0114).
--
-- This is the FIFTH and highest-traffic copy of the correlated ancestor LATERAL.
-- Inside this view it runs once per `actual_spend` row for EVERY §B query in the
-- application, so its cost scales with ledger volume and grows forever.
--
-- Measured on a fixture matching the real shape — a UNION-ALL source (as
-- v_complete_usage is) at 132 org_units and ~98k rows:
--   correlated LATERAL : 931.7 ms, 394,329 shared buffer hits
--   shared map join    :  43.6 ms,   1,867 shared buffer hits
--
-- WHY THE OLD FORM LOOKED FINE IN TESTING AND WAS NOT IN PRODUCTION. Over a
-- plain table Postgres elects a Memoize node above the LATERAL, so it evaluates
-- once per DISTINCT org_unit (132×) and the defect is invisible — 13.9ms vs
-- 9.1ms, a 1.5× difference nobody would chase. Over a UNION-ALL source Memoize
-- is not chosen, and the same LATERAL evaluates once per ROW (98,340×). The
-- defect is therefore a property of the SOURCE SHAPE, not of the join, which is
-- why a micro-benchmark on a table would have cleared it.
--
-- CHANGE IS MECHANICAL AND OUTPUT-PRESERVING. Same column signature, so
-- CREATE OR REPLACE keeps the OID and every dependent view
-- (v_finance_chargeback_month and friends) re-reads this definition without
-- being dropped. The ancestor rule is byte-identical — reflexive `<@`, deepest
-- wins, retired ancestors skipped.
--
-- WHAT KEEPS UNALLOCATED SPEND IN THE BILL is the map's TOTALITY, not this
-- LEFT: v_org_unit_cost_owner emits a row for EVERY org_unit, including those
-- with a NULL owner, and teammate.org_unit_id is NOT NULL — so an inner join
-- would select exactly the same rows today. The LEFT is defence-in-depth for
-- the day either of those stops holding; the invariant with teeth is the
-- one-row-per-org_unit assertion in the migration's test, which is what
-- actually fails if the map ever stops covering an unowned unit.
--
-- Everything else is 0085 verbatim, INCLUDING the §A-exclusion tool list, which
-- is deliberately duplicated here rather than referenced: a SQL view cannot
-- import shared/usage/github-surface.ts, and a pg_get_viewdef test pins these
-- literals to exclusion-only use.
CREATE OR REPLACE VIEW v_finance_bill_chargeback WITH (security_invoker = true) AS
SELECT a.teammate_id, a.date AS period_date, a.tool,
       c.cost_owning_unit_id,
       -- The COST-OWNING unit's region, which is what 0085 selected via
       -- `anc.region_id` — deliberately NOT the teammate's own region.
       c.cost_owning_unit_region_id AS region_id,
       SUM(a.cost_usd) AS bill_usd, SUM(a.input_tokens + a.output_tokens) AS bill_tokens
FROM actual_spend a JOIN teammate t ON t.id = a.teammate_id
LEFT JOIN v_org_unit_cost_owner c ON c.org_unit_id = t.org_unit_id
WHERE NOT a.chargeback_exempt
  -- §A-exclusion predicate: the unified GitHub firewall (GITHUB_FIREWALL_EXCLUSIONS).
  AND a.tool NOT IN ('copilot', 'copilot-agent', 'copilot-license', 'copilot-usage', 'copilot-unclassified', 'copilot-cli')
GROUP BY a.teammate_id, a.date, a.tool, c.cost_owning_unit_id, c.cost_owning_unit_region_id;

COMMENT ON VIEW v_finance_bill_chargeback IS
  'Chargeable §B bill per (teammate, date, tool), homed to the teammate''s nearest live cost-owning ancestor via v_org_unit_cost_owner (mig 0114 — the single implementation; do NOT re-inline the correlated LATERAL this replaced). NULL cost_owning_unit_id = unallocated and MUST stay in the total. Excludes chargeback_exempt rows and every Copilot lane (those bill pooled per cost-centre via v_finance_copilot_pool_chargeback). provider-billing-attribution-model.md §B.';
