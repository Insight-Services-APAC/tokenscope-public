-- 0050 — rate-card scope dimensions + temporal selection (COST-4 / COST-6).
--
-- PRECEDENCE CONTRACT (resolveRateCard in server/workers/azure-monitor-reader.ts
-- implements this; keep the two in sync):
--   Selection order for an event = (cou match) > (region match) > (global).
--   Within each tier only cards whose `effective` range CONTAINS the event
--   timestamp (effective @> ts_event) AND retired_at IS NULL are candidates;
--   ties within a tier break to the highest version.
--   The scope ladder is strict: a CoU-scoped card is always region-scoped too
--   (CHECK below) — there is no "CoU X in any region" card.
--
-- region_id NULL = global card; cou_id NULL = not CoU-scoped.

ALTER TABLE rate_card ADD COLUMN region_id uuid REFERENCES region(id);
ALTER TABLE rate_card ADD COLUMN cou_id uuid REFERENCES org_unit(id);

ALTER TABLE rate_card ADD CONSTRAINT rate_card_cou_requires_region
  CHECK (cou_id IS NULL OR region_id IS NOT NULL);

-- The 0001 exclusion (scope_key WITH =, effective WITH &&) forbade ANY two
-- overlapping cards per scope_key — which would make a region-scoped card and
-- the global card mutually exclusive for the same period. Rebuild it with the
-- scope dimensions in the key: at most one card per (scope_key, region, cou)
-- per overlapping period, i.e. the no-overlap invariant now holds WITHIN a
-- scope tier instead of across all tiers. COALESCE to a zero-uuid sentinel
-- because gist `=` treats NULLs as never-equal — without it two GLOBAL cards
-- (region_id NULL) could overlap, losing the 0001 protection.
ALTER TABLE rate_card DROP CONSTRAINT rate_card_scope_key_effective_excl;
ALTER TABLE rate_card ADD CONSTRAINT rate_card_scope_key_effective_excl
  EXCLUDE USING gist (
    scope_key WITH =,
    COALESCE(region_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    COALESCE(cou_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    effective WITH &&
  );

-- Lookup support for the joiner's per-(tool, region, day) resolution: the
-- WHERE clause always pins scope_key + retired_at IS NULL; the remaining
-- predicates (effective @> ts, region tier) filter the handful of live cards
-- per scope.
CREATE INDEX rate_card_scope_lookup ON rate_card (scope_key) WHERE retired_at IS NULL;
