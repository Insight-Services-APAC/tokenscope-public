-- 0106 — Workstream C (the Copilot money model): effective-dated rate plans
-- (ADR-0011 D9) + configurable overage-allocation policy + persisted
-- allocations (ADR-0011 D10).
--
-- Design: docs/design/usage-completeness-and-provider-governance.md §5.3/§5.4,
-- §8.4. NEITHER new table ever feeds copilot_pool_bill.license_net_usd /
-- overage_net_usd — those remain READ, bill-anchored, from the enterprise
-- billing usage report (copilot-pool-bill worker). This migration adds
-- FORECAST/SHOWBACK inputs (the rate plan) and a DISTRIBUTION of the
-- already-imported overage net (the allocation) — never a reconstruction of
-- the bill.
--
-- ============================================================================
-- PART 1 — copilot_rate_plan: effective-dated (enterprise, valid_from,
-- valid_to) seat price + included allowance, replacing the scalar
-- provider_enterprise.flat_seat_price_usd / included_allowance_usd as the
-- FORECAST/SHOWBACK source of truth. Mirrors rate_card's own EXCLUDE-gist
-- non-overlap pattern (0001/0050/0051) — one live plan per enterprise per
-- instant, retired rows exempted from the exclusion so a
-- retire-then-correct workflow stays possible.
-- ============================================================================
CREATE TABLE copilot_rate_plan (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_enterprise_id  uuid NOT NULL REFERENCES provider_enterprise(id),
  effective               tstzrange NOT NULL,
  flat_seat_price_usd     numeric(14, 6),
  included_allowance_usd  numeric(14, 6),
  notes                   text,
  created_by              uuid REFERENCES teammate(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  -- Soft-void (mirrors rate_card.retired_at): a plan entered in error is
  -- retired, never deleted, and is excluded from the non-overlap exclusion so
  -- the corrected replacement can occupy the same period.
  retired_at              timestamptz,
  EXCLUDE USING gist (provider_enterprise_id WITH =, effective WITH &&) WHERE (retired_at IS NULL)
);

COMMENT ON TABLE copilot_rate_plan IS
  'Effective-dated Copilot seat price + included allowance per provider_enterprise (ADR-0011 D9). FORECAST/SHOWBACK input ONLY -- never used to reconstruct copilot_pool_bill.license_net_usd/overage_net_usd, which are read straight from the bill. server/governance/copilot-rate-plan.ts resolves the plan in force for the period being computed so a later plan change never re-costs a closed month. usage-completeness-and-provider-governance.md §5.3.';

CREATE INDEX copilot_rate_plan_lookup ON copilot_rate_plan (provider_enterprise_id) WHERE retired_at IS NULL;

-- ============================================================================
-- PART 2 — provider_enterprise.overage_allocation_policy (ADR-0011 D10).
-- Configurable per enterprise; consumption-share is Insight's default and the
-- policy every enterprise starts on.
-- ============================================================================
ALTER TABLE provider_enterprise
  ADD COLUMN overage_allocation_policy text NOT NULL DEFAULT 'consumption-share'
  CHECK (overage_allocation_policy IN ('consumption-share', 'excess-share', 'excess-equal', 'seat-share'));

COMMENT ON COLUMN provider_enterprise.overage_allocation_policy IS
  'ADR-0011 D10: how a PAID pooled overage (copilot_pool_bill.overage_net_usd, already real money on the bill) is DISTRIBUTED across cost-owning units. Never derives or creates a charge -- allocation only redistributes the imported overage net; conservation (Σ allocations == overage net, to the cent) is enforced by server/governance/copilot-overage-allocation.ts. consumption-share = Insight default.';

-- ============================================================================
-- PART 3 — copilot_overage_allocation: the PERSISTED distribution of one
-- (enterprise, month)'s paid overage net across cost-owning units. Grain
-- (provider_enterprise_id, month, cost_owning_unit_id); NULL cost_owning_unit_id
-- is the explicit unallocated bucket (mirrors copilot_pool_bill's own NULL-CoU
-- convention), written exactly once when the paid overage has zero
-- attributable weight. Two partial unique indexes give "at most one row per
-- (enterprise, month, real CoU)" AND "at most one unallocated row per
-- (enterprise, month)" -- a plain UNIQUE cannot express both because SQL
-- treats NULL <> NULL, so a bare (ent, month, cou) UNIQUE would silently allow
-- duplicate unallocated rows.
-- ============================================================================
CREATE TABLE copilot_overage_allocation (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_enterprise_id  uuid NOT NULL REFERENCES provider_enterprise(id),
  month                   date NOT NULL,
  cost_owning_unit_id     uuid REFERENCES org_unit(id),
  policy                  text NOT NULL CHECK (policy IN ('consumption-share', 'excess-share', 'excess-equal', 'seat-share')),
  -- The raw (pre-normalisation) weight this recipient contributed -- usage$,
  -- excess$, or a seat count depending on policy. Context/audit only; the
  -- money is allocated_usd.
  weight                  numeric(20, 6) NOT NULL DEFAULT 0,
  -- Cent-exact (allocateCents produces 2dp values) -- Σ allocated_usd for one
  -- (enterprise, month) equals the imported overage net to the cent
  -- (server/governance/copilot-overage-allocation.ts asserts this on write).
  allocated_usd           numeric(14, 2) NOT NULL,
  -- Denormalised context: the total being distributed, repeated on every row
  -- of the (enterprise, month) set -- aids auditing a single row without a
  -- join back to copilot_pool_bill.
  overage_net_usd         numeric(14, 6) NOT NULL,
  computed_at             timestamptz NOT NULL DEFAULT now(),
  -- The worker_run that computed this (NULL for an admin-triggered recompute
  -- outside a worker dispatch, e.g. a policy-change-triggered recompute).
  run_id                  uuid REFERENCES worker_run(id)
);

CREATE UNIQUE INDEX copilot_overage_allocation_cou_unique
  ON copilot_overage_allocation (provider_enterprise_id, month, cost_owning_unit_id)
  WHERE cost_owning_unit_id IS NOT NULL;

CREATE UNIQUE INDEX copilot_overage_allocation_unallocated_unique
  ON copilot_overage_allocation (provider_enterprise_id, month)
  WHERE cost_owning_unit_id IS NULL;

CREATE INDEX copilot_overage_allocation_month_idx ON copilot_overage_allocation (provider_enterprise_id, month);

COMMENT ON TABLE copilot_overage_allocation IS
  'ADR-0011 D10: the persisted per-cost-owning-unit distribution of one (enterprise, month)''s PAID pooled Copilot overage (copilot_pool_bill.overage_net_usd). NULL cost_owning_unit_id = the explicit unallocated bucket (paid overage with zero attributable weight). Idempotent delete-and-replace under the copilotOverageAllocation advisory lock (server/db/advisory-lock.ts) -- see server/governance/copilot-overage-allocation.ts. v_finance_copilot_pool_chargeback reads this in place of the org-homed overage_net_usd sum when rows exist for an (enterprise, month), never both (no double charge). usage-completeness-and-provider-governance.md §5.4.';

-- ============================================================================
-- PART 4 — backfill: seed an open-ended rate plan for every EXISTING
-- provider_enterprise that already carries a scalar flat_seat_price_usd and/or
-- included_allowance_usd, so the resolver (server/governance/copilot-rate-plan.ts)
-- returns the IDENTICAL figures for every past and future period immediately
-- after this migration -- preserving today's behaviour exactly at cutover,
-- the same principle the governance cutover (mig 0104) and finance_period
-- (mig 0102) backfills follow. Anthropic enterprises (always NULL/NULL) get
-- no row -- avoids meaningless empty plans for a provider that has no
-- Copilot billing structure at all.
-- ============================================================================
INSERT INTO copilot_rate_plan (provider_enterprise_id, effective, flat_seat_price_usd, included_allowance_usd, notes)
SELECT id, tstzrange(NULL, NULL), flat_seat_price_usd, included_allowance_usd,
       'Backfilled from provider_enterprise scalar fields at migration 0106 cutover (open-ended -- preserves pre-cutover behaviour for every period until a new dated plan is created).'
FROM provider_enterprise
WHERE flat_seat_price_usd IS NOT NULL OR included_allowance_usd IS NOT NULL;
