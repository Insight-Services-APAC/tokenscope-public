-- 0073: split the bill view into SHOWBACK (all) vs CHARGEBACK (exempt-excluded).
--
-- Intent: ADR-0010 rules 3 & 5. Before this, v_finance_bill_chargeback summed ALL
-- actual_spend rows and was (mis)used as BOTH the showback bill lane (practice/region
-- manager view) AND the finance chargeback lane — so there was no single place to
-- exclude chargeback-exempt cost from chargeback ONLY. The fix:
--
--   * v_finance_bill_showback   — ALL rows (incl. chargeback_exempt). The practice /
--     region SHOWBACK reads this: a manager sees every dollar their people consume
--     (rule 3 — no chargeback filter on showback).
--   * v_finance_bill_chargeback — now filtered to WHERE NOT chargeback_exempt. The
--     finance cross-charge surfaces AND v_finance_project_overlay (built FROM this
--     view) inherit the exclusion in exactly ONE place (rule 5). No other reader or
--     view changes.
--
-- The exempt filter applies BEFORE the SUM: a teammate active in BOTH a billed and an
-- exempt org (D5) has a LARGER showback total than chargeback total, by construction.
--
-- Backward-compat: every pre-0072 row is chargeback_exempt=false (mig 0072 default), so
-- `WHERE NOT chargeback_exempt` is a no-op over existing data — the finance chargeback
-- numbers are byte-identical to pre-0073. Only newly-written exempt Copilot rows differ.

-- 1. Showback bill — all rows, NO exempt filter. Column shape identical to chargeback
--    so readers swap the view name and nothing else.
CREATE VIEW v_finance_bill_showback WITH (security_invoker = true) AS
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

-- 2. Chargeback bill — exclude chargeback-exempt rows (the SINGLE exclusion point).
--    CREATE OR REPLACE keeps the exact column signature (mig 0059), so the dependent
--    v_finance_project_overlay stays valid and now sees only chargeable rows.
CREATE OR REPLACE VIEW v_finance_bill_chargeback WITH (security_invoker = true) AS
SELECT a.teammate_id, a.date AS period_date, a.tool, cc.cost_owning_unit_id, cc.region_id,
       SUM(a.cost_usd) AS bill_usd, SUM(a.input_tokens + a.output_tokens) AS bill_tokens
FROM actual_spend a JOIN teammate t ON t.id = a.teammate_id
LEFT JOIN LATERAL (
  SELECT anc.id AS cost_owning_unit_id, anc.region_id
  FROM org_unit home JOIN org_unit anc ON home.path <@ anc.path
  WHERE home.id = t.org_unit_id AND anc.is_cost_owning_unit = TRUE AND anc.retired_at IS NULL
  ORDER BY nlevel(anc.path) DESC LIMIT 1
) cc ON TRUE
WHERE NOT a.chargeback_exempt
GROUP BY a.teammate_id, a.date, a.tool, cc.cost_owning_unit_id, cc.region_id;
