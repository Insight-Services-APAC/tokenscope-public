-- 0080: copilot_pool_bill — the per-(org, month) POOLED Copilot bill, READ from the
-- enterprise billing usage report (never recomputed).
--
-- Intent: docs/design/provider-billing-attribution-model.md §B + reporting-consolidation
-- build-design §6 Wave 0. Copilot's bill is POOLED per (org, sku) — it has NO per-user
-- field and cannot live in actual_spend (teammate_id NOT NULL). This is the sibling grain
-- (must-build primitive #4): one row per (enterprise, org, month) carrying the bill's own
-- net lines, homed to a cost-owning unit via the provider_org → CoU map (mig 0079).
--
-- The copilot-pool-bill worker is a READER, not a calculator. Each figure is READ straight
-- off the bill report — canonical §B cost shape:
--   license_net_usd        = the "Copilot Enterprise" SKU NET (the seat license — NOT
--                            seats × flat-rate; WRONG model #2 is purged). NULL = the SKU
--                            line was ABSENT for this org-month → NO license charge written,
--                            the worker alerts, and the month reports UNSETTLED (never a
--                            flat-rate fallback).
--   overage_net_usd        = the AI-Credits / Cloud-Agent SKU NET — the POOLED chargeable
--                            authority (on the live NFR bill this was $0: the pool covered
--                            all consumption). Never Σusage − pool; read the bill net.
--   included_allowance_usd = the `included` DISCOUNT line (the pool allowance) — NOT the SKU
--                            net (that is the license). Context only.
--   usage_gross_usd        = gross AI-credit consumption (context / the unsettled signal).
--   seats                  = the license line's seat quantity (context).
--
-- HOMING (D-Homing = point-in-time via the org→CoU config map):
--   * provider_org_id + cost_owning_unit_id — the org's bill homes to its mapped CoU.
--     cost_owning_unit_id NULL = the org is unmapped → VISIBLE unallocated bucket.
--   * provider_org_id NULL — the SINGLE explicit "unallocated enterprise-residual" line per
--     (enterprise, month): a bill line that genuinely carries no org dimension (or an org
--     with no provider_org registry row). NEVER a pro-rata spread across orgs (that is the
--     allocation-guess-as-charge pattern §B rejects) — it is one visible residual row.
--
-- Exempt orgs are NOT written here at all (canonical §B: "simply not written — no pool leak,
-- no allocation"); their usage still surfaces `indicative` via the usage lane
-- (v_teammate_usage_daily copilot branch).

CREATE TABLE copilot_pool_bill (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The month this bill covers (always the 1st, UTC). Month-grain: Copilot settles at
  -- month-end + settle, so the row is per calendar month, never a day-1 spike.
  month date NOT NULL,
  provider_enterprise_id uuid NOT NULL REFERENCES provider_enterprise(id),
  -- The github org this pooled bill is for. NULL = the single unallocated enterprise-residual
  -- line (a bill line with no org dimension, or an unregistered org).
  provider_org_id uuid REFERENCES provider_org(id),
  -- The CoU the org's bill homes to (copied from provider_org.cost_owning_unit_id at write
  -- time). NULL = unmapped org OR the enterprise-residual line → visible unallocated bucket.
  cost_owning_unit_id uuid REFERENCES org_unit(id),
  seats integer,
  -- NULL license_net_usd = SKU line absent → UNSETTLED (no charge, worker alerts). See header.
  license_net_usd numeric(14, 6),
  included_allowance_usd numeric(14, 6),
  usage_gross_usd numeric(14, 6),
  overage_net_usd numeric(14, 6),
  pulled_at timestamptz NOT NULL DEFAULT now(),
  raw_payload jsonb
);

-- One row per (month, org). Partial so the residual (NULL org) rows are governed separately.
CREATE UNIQUE INDEX copilot_pool_bill_month_org_uidx
  ON copilot_pool_bill (month, provider_org_id)
  WHERE provider_org_id IS NOT NULL;

-- At most ONE unallocated enterprise-residual line per (enterprise, month). (Scoped by
-- enterprise so two reconciled github enterprises can each carry a residual for the same
-- month; the build-design's "(month, provider_org_id)" is the non-null half above.)
CREATE UNIQUE INDEX copilot_pool_bill_month_residual_uidx
  ON copilot_pool_bill (month, provider_enterprise_id)
  WHERE provider_org_id IS NULL;

-- The finance views read per (month, cou); index the homing key for the monthly rollups.
CREATE INDEX copilot_pool_bill_month_cou_idx ON copilot_pool_bill (month, cost_owning_unit_id);

COMMENT ON TABLE copilot_pool_bill IS
  'Per-(enterprise, org, month) POOLED Copilot bill, READ from the enterprise billing usage report (never recomputed). The §B chargeback authority for Copilot; homed org→CoU via provider_org.cost_owning_unit_id. provider-billing-attribution-model.md §B.';
