-- 0081: the Copilot pooled-chargeback finance views + the overage-row purge.
--
-- Intent: reporting-consolidation build-design §6 Wave 0 (5) + §4 data-lane matrix +
-- owner decisions D-Q6 / D-Showback. Copilot's chargeback comes from EXACTLY ONE surface —
-- copilot_pool_bill (the pooled bill net, mig 0080) — and NEVER from actual_spend. The
-- per-seat / overage copilot rows that copilot-bill.ts writes into actual_spend are
-- showback/display-only and are excluded from every chargeback operand here (test-enforced).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Firewall the legacy per-(teammate,day) chargeback lane against copilot.
--    v_finance_bill_chargeback stays the Anthropic per-teammate chargeback bill; copilot-cli
--    rows (per-seat showback split) are EXCLUDED — the Copilot charge is pooled, not
--    per-teammate (canonical §B / D-Showback). v_finance_bill_showback is UNCHANGED (it keeps
--    copilot rows — showback shows every dollar). CREATE OR REPLACE keeps the exact mig 0059
--    column signature, so the dependent v_finance_project_overlay stays valid (and correctly
--    drops copilot, which has no per-project OTel split).
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
  AND a.tool <> 'copilot-cli'  -- copilot chargeback is POOLED (copilot_pool_bill), never per-seat actual_spend
GROUP BY a.teammate_id, a.date, a.tool, cc.cost_owning_unit_id, cc.region_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. v_finance_copilot_pool_chargeback — the Copilot per-org pooled NET, homed org→CoU.
--    Grain (cou, tool, month). One value per org = license_net + overage_net (both COALESCEd:
--    an UNSETTLED month with a NULL license still charges its known overage). NULL cou =
--    VISIBLE unallocated bucket (unmapped org OR the enterprise-residual line). region_id is
--    derived from the CoU's org_unit (NULL for the residual). Exempt orgs never reach this
--    view (the writer never wrote them).
CREATE VIEW v_finance_copilot_pool_chargeback WITH (security_invoker = true) AS
SELECT
  b.cost_owning_unit_id,
  ou.region_id,
  'copilot-cli'::text AS tool,
  b.month AS period_month,
  SUM(COALESCE(b.license_net_usd, 0) + COALESCE(b.overage_net_usd, 0)) AS charge_usd
FROM copilot_pool_bill b
LEFT JOIN org_unit ou ON ou.id = b.cost_owning_unit_id
GROUP BY b.cost_owning_unit_id, ou.region_id, b.month;

COMMENT ON VIEW v_finance_copilot_pool_chargeback IS
  'Copilot per-org pooled NET chargeback (license_net + overage_net) homed org→CoU, grain (cou, tool, month). NULL cou = visible unallocated. The ONLY Copilot chargeback source. provider-billing-attribution-model.md §B.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. v_finance_chargeback_month — the unified monthly chargeback: Anthropic per-teammate
--    (month-rolled from v_finance_bill_chargeback) ∪ Copilot per-org pooled net. Grain
--    (cou, tool, month). The `tool <> 'copilot-cli'` filter is belt-and-braces (view 1
--    already excludes copilot) so this view can NEVER pick up an actual_spend copilot row.
CREATE VIEW v_finance_chargeback_month WITH (security_invoker = true) AS
  SELECT cost_owning_unit_id, region_id, tool,
         date_trunc('month', period_date)::date AS period_month,
         SUM(bill_usd) AS charge_usd
  FROM v_finance_bill_chargeback
  WHERE tool <> 'copilot-cli'
  GROUP BY cost_owning_unit_id, region_id, tool, date_trunc('month', period_date)
  UNION ALL
  SELECT cost_owning_unit_id, region_id, tool, period_month, charge_usd
  FROM v_finance_copilot_pool_chargeback;

COMMENT ON VIEW v_finance_chargeback_month IS
  'Monthly chargeback: Anthropic per-teammate (month-rolled) ∪ Copilot per-org pooled net (copilot_pool_bill ONLY). Grain (cou, tool, month); NULL cou = visible unallocated. Copilot is ABSENT from every actual_spend-rooted operand. reporting-consolidation build-design §6.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. v_finance_bill_totals_month — Σ bill per (provider, month), each provider from EXACTLY
--    ONE surface: Anthropic from actual_spend (chargeable, non-copilot), Copilot from
--    copilot_pool_bill. This backs the Finance Σ=bill check (Σ v_finance_chargeback_month =
--    Σ v_finance_bill_totals_month) and keeps the raw-actual_spend firewall exception-free —
--    the check reads THIS view, never raw actual_spend + copilot_pool_bill added together
--    (which would double-count the license present in both). `unsettled` flags a Copilot
--    month with activity but no read license (missing SKU line → month reports unsettled).
CREATE VIEW v_finance_bill_totals_month WITH (security_invoker = true) AS
  SELECT date_trunc('month', a.date)::date AS period_month,
         'anthropic'::text AS provider,
         SUM(a.cost_usd) AS bill_usd,
         FALSE AS unsettled
  FROM actual_spend a
  WHERE a.tool <> 'copilot-cli' AND NOT a.chargeback_exempt
  GROUP BY date_trunc('month', a.date)
  UNION ALL
  SELECT b.month AS period_month,
         'github'::text AS provider,
         SUM(COALESCE(b.license_net_usd, 0) + COALESCE(b.overage_net_usd, 0)) AS bill_usd,
         bool_or(b.license_net_usd IS NULL AND COALESCE(b.usage_gross_usd, 0) > 0) AS unsettled
  FROM copilot_pool_bill b
  GROUP BY b.month;

COMMENT ON VIEW v_finance_bill_totals_month IS
  'Σ bill per (provider, month) — Anthropic from actual_spend (chargeable, non-copilot), Copilot from copilot_pool_bill ONLY. Backs the Finance Σ=bill check; `unsettled` = a Copilot month with usage but no read license SKU. reporting-consolidation build-design §6.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Purge the source='copilot-overage' rows from actual_spend. These were idempotent
--    forecasts (max(0, per-user month usage − allowance)), NEVER billed-grade — the canonical
--    §B model rejects per-user overage as a charge (WRONG model #1). The pooled overage now
--    lives in copilot_pool_bill.overage_net_usd (read from the bill). The DELETE is
--    idempotent; the count is NOTICE'd for the migration log (reporting-consolidation risk 4).
--    v_teammate_usage_daily is UNAFFECTED (copilot usage there comes from reconciliation_record,
--    not actual_spend).
DO $$
DECLARE
  deleted_count integer;
BEGIN
  WITH del AS (
    DELETE FROM actual_spend WHERE source = 'copilot-overage' RETURNING 1
  )
  SELECT count(*) INTO deleted_count FROM del;
  RAISE NOTICE '0081: deleted % actual_spend rows with source=''copilot-overage'' (idempotent forecasts, never billed-grade; pooled overage now read into copilot_pool_bill.overage_net_usd)', deleted_count;
END $$;
