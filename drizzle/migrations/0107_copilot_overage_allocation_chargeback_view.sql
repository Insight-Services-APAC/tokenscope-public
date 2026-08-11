-- 0107 — Workstream C: rewire v_finance_copilot_pool_chargeback's copilot-usage
-- lane to read the persisted overage allocation (ADR-0011 D10) when one exists
-- for an (enterprise, month), falling back to the existing org-homed
-- overage_net_usd sum when it does not (an enterprise/month the allocation
-- worker has not yet processed, or one still on a $0 overage).
--
-- Design: docs/design/usage-completeness-and-provider-governance.md §5.4.
-- The license and copilot-unclassified lanes are UNTOUCHED (still a straight
-- SUM off copilot_pool_bill, org-homed) — only copilot-usage's DISTRIBUTION
-- changes; the license/unclassified semantics + the grain
-- (cost_owning_unit_id, region_id, tool, period_month) are identical to the
-- migration-0085 definition this replaces, so v_finance_chargeback_month and
-- v_finance_bill_totals_month (both of which read from this view / from
-- copilot_pool_bill directly) need NO changes.
--
-- NO DOUBLE CHARGE (structural, not conventional): the org-homed fallback arm
-- carries an explicit `WHERE NOT EXISTS (... copilot_overage_allocation ...)`
-- scoped to the SAME (provider_enterprise_id, month) the allocation is
-- computed at, so a bill row can NEVER contribute to both arms at once.
-- SAME TOTAL: whichever arm fires, the per-(enterprise, month) copilot-usage
-- total is either the org-homed sum (unchanged) or the persisted allocation's
-- total (which server/governance/copilot-overage-allocation.ts asserts, by
-- read-back, equals that SAME overage_net_usd sum to the cent) — so
-- Σ copilot-usage is invariant to whether an allocation has been computed.
CREATE OR REPLACE VIEW v_finance_copilot_pool_chargeback WITH (security_invoker = true) AS
WITH lane_rows AS (
  -- License: ALWAYS org-homed straight off the bill — allocation never touches it.
  SELECT b.cost_owning_unit_id, b.month, 'copilot-license'::text AS tool,
         COALESCE(b.license_net_usd, 0) AS charge_usd
  FROM copilot_pool_bill b
  UNION ALL
  -- Unclassified: ALWAYS org-homed straight off the bill — visible everywhere, never charged,
  -- never allocated (D3).
  SELECT b.cost_owning_unit_id, b.month, 'copilot-unclassified'::text AS tool,
         COALESCE(b.unclassified_net_usd, 0) AS charge_usd
  FROM copilot_pool_bill b
  UNION ALL
  -- Overage, ORG-HOMED FALLBACK: only for (enterprise, month) pairs with NO persisted
  -- allocation yet — preserves the pre-Workstream-C behaviour exactly until an allocation
  -- is computed for that pair.
  SELECT b.cost_owning_unit_id, b.month, 'copilot-usage'::text AS tool,
         COALESCE(b.overage_net_usd, 0) AS charge_usd
  FROM copilot_pool_bill b
  WHERE NOT EXISTS (
    SELECT 1 FROM copilot_overage_allocation coa
    WHERE coa.provider_enterprise_id = b.provider_enterprise_id AND coa.month = b.month
  )
  UNION ALL
  -- Overage, PERSISTED ALLOCATION: replaces the org-homed figure for any (enterprise, month)
  -- this HAS been computed for (ADR-0011 D10, consumption-share default, configurable per
  -- enterprise) — splitting the pooled overage across every cost-owning unit whose people
  -- actually consumed, not just the one CoU the org happens to be homed to.
  SELECT coa.cost_owning_unit_id, coa.month, 'copilot-usage'::text AS tool,
         coa.allocated_usd AS charge_usd
  FROM copilot_overage_allocation coa
)
SELECT lr.cost_owning_unit_id, ou.region_id, lr.tool, lr.month AS period_month,
       SUM(lr.charge_usd) AS charge_usd
FROM lane_rows lr
LEFT JOIN org_unit ou ON ou.id = lr.cost_owning_unit_id
GROUP BY lr.cost_owning_unit_id, ou.region_id, lr.tool, lr.month;

COMMENT ON VIEW v_finance_copilot_pool_chargeback IS
  'Copilot per-CoU pooled NET chargeback split into the three §B lanes (copilot-license, copilot-usage, copilot-unclassified), grain (cou, lane, month). copilot-usage reads the PERSISTED overage allocation (copilot_overage_allocation, ADR-0011 D10) when one exists for the (enterprise, month), else falls back to the org-homed overage_net_usd sum -- mutually exclusive by construction (no double charge), same total either way. NULL cou = visible unallocated. Σ lanes == the pooled bill columns (C2 unaffected -- only copilot-usage''s DISTRIBUTION changed). copilot-unclassified is NEVER chargeable. The ONLY Copilot chargeback source; no per-user/teammate column may enter this view. NAMESPACE RULE: tool=''copilot-cli'' is §A-only and must not appear in chargeback views except in §A-exclusion predicates. usage-completeness-and-provider-governance.md §5.4.';
