-- 0085: the Copilot §B chargeback lane split (copilot-surface-lanes design D2/D3).
--
-- Intent: split the single pooled Copilot chargeback figure into THREE visible lanes,
-- Σ lanes == the invoice (the #142 catch-all pattern applied to Copilot — nothing
-- vanishes into a log line):
--   copilot-license      ← license_net_usd      (seat SKUs)
--   copilot-usage        ← overage_net_usd      (AI-credit / coding-agent SKUs)
--   copilot-unclassified ← unclassified_net_usd (NEW column: Copilot bill lines matching
--     neither classifier — visible in every view/UI lane, EXCLUDED from every
--     chargeableUsd until classified; the worker alerts on any unclassified > $0).
--
-- NAMESPACE RULE (design D2, r1-F3): 'copilot-cli' and 'copilot-agent' are §A USAGE
-- tool literals ONLY. They are RETIRED from every chargeback view: no *_chargeback*
-- view may emit or filter a §A copilot tool except to EXCLUDE §A rows. The exclusion
-- is the UNIFIED GitHub firewall set (GITHUB_FIREWALL_EXCLUSIONS in
-- shared/usage/github-surface.ts — every GitHub lane id + §A tool literal), not a
-- single hand literal, so a future §B bill writer landing ANY GitHub id in
-- actual_spend can never leak into an Anthropic arm (r1 finding 1). Enforced
-- mechanically by a pg_get_viewdef integration test. v_finance_bill_showback is
-- unaffected (showback shows every dollar; only *_chargeback* views enforce the rule).
--
-- Conservation invariants (design D2, r1-F1):
--   C1 (columns vs raw): per (enterprise, month, org): license_net + overage_net +
--       unclassified_net == Σ raw Copilot items' netAmount — enforced at runtime by the
--       worker (post-aggregation assertion → 'copilot-bill-unclassified' alert on delta).
--   C2 (lanes vs columns): Σ(3 lane rows) == the same three columns (regression identity).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The unclassified column. DEFAULT 0 backfills every existing row (historical
--    months were fully classified by construction — the old aggregator put every
--    Copilot line into license or overage, so their unclassified is genuinely $0).
ALTER TABLE copilot_pool_bill
  ADD COLUMN unclassified_net_usd numeric(14, 6) NOT NULL DEFAULT 0;

COMMENT ON COLUMN copilot_pool_bill.unclassified_net_usd IS
  'NET of Copilot-product bill lines matching neither the license nor the usage (AI-credit/agent) classifier. Visible as the copilot-unclassified chargeback lane; NEVER folded into a chargeableUsd; any value > 0 raises a copilot-bill-unclassified alert (classify the SKU + re-run the month; do not enable Copilot chargeback mode while > 0). copilot-surface-lanes design D2/D3.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 1b. v_finance_bill_chargeback — the actual_spend-rooted §B ROOT view (mig 0081)
--     re-created with the UNIFIED GitHub firewall (r1 finding 1): the exclusion
--     widens from the single 'copilot-cli' literal to EVERY GitHub id a tool
--     column can carry — the §A usage tools ('copilot-cli' + the mig-0086
--     'copilot-agent') AND the lane ids ('copilot' + the three §B chargeback
--     lanes). Fixing the ROOT view firewalls every daily-grain consumer (the
--     Across/Regional billed KPIs, chargeback trend/dow, cost-centre charge arm,
--     fetchAnthropicCharges) in one place. List mirrors GITHUB_FIREWALL_EXCLUSIONS
--     in shared/usage/github-surface.ts (a SQL view cannot import TS; the
--     pg_get_viewdef test pins the §A tool literals to exclusion-only use).
--     Everything else is 0081 verbatim; same column signature keeps the OID.
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
  -- §A-exclusion predicate: the unified GitHub firewall (GITHUB_FIREWALL_EXCLUSIONS).
  AND a.tool NOT IN ('copilot', 'copilot-agent', 'copilot-license', 'copilot-usage', 'copilot-unclassified', 'copilot-cli')
GROUP BY a.teammate_id, a.date, a.tool, cc.cost_owning_unit_id, cc.region_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. v_finance_copilot_pool_chargeback — one row per LANE per (cou, month).
--    Same column signature as mig 0081 (CREATE OR REPLACE keeps the OID, so the
--    dependent v_finance_chargeback_month re-reads the new definition). The old
--    single 'copilot-cli' row becomes three lane rows; the 0081 view emitted a
--    row for every (cou, month) group regardless of amount, and each lane row
--    keeps that convention (zero-amount lane rows are NOT skipped — UI/CSV
--    consumers elide zeros; the view stays a pure identity over the columns).
CREATE OR REPLACE VIEW v_finance_copilot_pool_chargeback WITH (security_invoker = true) AS
SELECT
  b.cost_owning_unit_id,
  ou.region_id,
  lane.tool,
  b.month AS period_month,
  lane.charge_usd
FROM (
  SELECT
    b0.cost_owning_unit_id,
    b0.month,
    SUM(COALESCE(b0.license_net_usd, 0)) AS license_usd,
    SUM(COALESCE(b0.overage_net_usd, 0)) AS overage_usd,
    SUM(COALESCE(b0.unclassified_net_usd, 0)) AS unclassified_usd
  FROM copilot_pool_bill b0
  GROUP BY b0.cost_owning_unit_id, b0.month
) b
LEFT JOIN org_unit ou ON ou.id = b.cost_owning_unit_id
CROSS JOIN LATERAL (
  VALUES
    ('copilot-license'::text, b.license_usd),
    ('copilot-usage'::text, b.overage_usd),
    ('copilot-unclassified'::text, b.unclassified_usd)
) AS lane(tool, charge_usd);

COMMENT ON VIEW v_finance_copilot_pool_chargeback IS
  'Copilot per-CoU pooled NET chargeback split into the three §B lanes (tool = copilot-license ← license_net, copilot-usage ← overage_net, copilot-unclassified ← unclassified_net), grain (cou, lane, month). NULL cou = visible unallocated. Σ lanes == the pooled bill columns (C2). copilot-unclassified is NEVER chargeable. The ONLY Copilot chargeback source; no per-user/teammate column may enter this view. NAMESPACE RULE: tool=''copilot-cli'' is §A-only and must not appear in chargeback views except in §A-exclusion predicates. provider-billing-attribution-model.md §B + copilot-surface-lanes D2.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. v_finance_chargeback_month — text unchanged in substance (the copilot arm IS
--    the pool view, which now emits the three lane rows through the kept OID), but
--    re-created to restate the comment contract. The Anthropic arm's NOT IN filter
--    is a §A-EXCLUSION predicate over the UNIFIED GitHub firewall set (belt-and-
--    braces on top of 1b — a §A copilot tool literal may appear in a chargeback
--    view ONLY inside such an exclusion).
CREATE OR REPLACE VIEW v_finance_chargeback_month WITH (security_invoker = true) AS
  SELECT cost_owning_unit_id, region_id, tool,
         date_trunc('month', period_date)::date AS period_month,
         SUM(bill_usd) AS charge_usd
  FROM v_finance_bill_chargeback
  -- §A-exclusion predicate: the unified GitHub firewall (GITHUB_FIREWALL_EXCLUSIONS).
  WHERE tool NOT IN ('copilot', 'copilot-agent', 'copilot-license', 'copilot-usage', 'copilot-unclassified', 'copilot-cli')
  GROUP BY cost_owning_unit_id, region_id, tool, date_trunc('month', period_date)
  UNION ALL
  SELECT cost_owning_unit_id, region_id, tool, period_month, charge_usd
  FROM v_finance_copilot_pool_chargeback;

COMMENT ON VIEW v_finance_chargeback_month IS
  'Monthly chargeback: Anthropic per-teammate (month-rolled) ∪ Copilot per-org pooled net as the three §B lanes (copilot-license / copilot-usage / copilot-unclassified, from copilot_pool_bill ONLY). Grain (cou, tool, month); NULL cou = visible unallocated. copilot-unclassified is NEVER chargeable. NAMESPACE RULE: the §A copilot tools (''copilot-cli''/''copilot-agent'') appear only inside the unified-firewall §A-exclusion predicate. reporting-consolidation build-design §6 + copilot-surface-lanes D2.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. v_finance_bill_totals_month — the github arm gains unclassified in the total
--    (Σ=bill is whole-truth: every read dollar is in the bill footing, even the
--    not-yet-chargeable unclassified slice — the Σ=bill check reconciles against the
--    chargeback view, which also carries the unclassified lane, so the identity holds).
CREATE OR REPLACE VIEW v_finance_bill_totals_month WITH (security_invoker = true) AS
  SELECT date_trunc('month', a.date)::date AS period_month,
         'anthropic'::text AS provider,
         SUM(a.cost_usd) AS bill_usd,
         FALSE AS unsettled
  FROM actual_spend a
  -- §A-exclusion predicate: the unified GitHub firewall (GITHUB_FIREWALL_EXCLUSIONS).
  WHERE a.tool NOT IN ('copilot', 'copilot-agent', 'copilot-license', 'copilot-usage', 'copilot-unclassified', 'copilot-cli')
    AND NOT a.chargeback_exempt
  GROUP BY date_trunc('month', a.date)
  UNION ALL
  SELECT b.month AS period_month,
         'github'::text AS provider,
         SUM(COALESCE(b.license_net_usd, 0) + COALESCE(b.overage_net_usd, 0)
             + COALESCE(b.unclassified_net_usd, 0)) AS bill_usd,
         bool_or(b.license_net_usd IS NULL AND COALESCE(b.usage_gross_usd, 0) > 0) AS unsettled
  FROM copilot_pool_bill b
  GROUP BY b.month;

COMMENT ON VIEW v_finance_bill_totals_month IS
  'Σ bill per (provider, month) — Anthropic from actual_spend (chargeable, non-copilot), Copilot from copilot_pool_bill ONLY (license + overage + unclassified: whole-truth footing). Backs the Finance Σ=bill check; `unsettled` = a Copilot month with usage but no read license SKU. NAMESPACE RULE: the §A copilot tools (''copilot-cli''/''copilot-agent'') appear only inside the unified-firewall §A-exclusion predicate. reporting-consolidation build-design §6 + copilot-surface-lanes D2.';
