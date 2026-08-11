-- 0110 — a holding node may never be cost-owning, enforced by the DATABASE.
--
-- Intent: the rule already existed (server/db/org-units.ts
-- assertHoldingNodeNotCostOwning) but only as a helper that two HTTP handlers
-- happen to call. Raw SQL, a migration, a seed or a future worker could set the
-- flag and nothing would stop it — and the consequence is not a cosmetic one:
-- the chargeback view homes spend on the nearest cost-owning ANCESTOR, so a
-- cost-owning holding node instantly becomes every unplaced teammate's cost
-- centre. Every unhomed dollar would report as homed, to a bucket nobody owns
-- and no P&L answers for, with not one person actually placed. A silent,
-- plausible zero is worse than the defect it hides.
--
-- So the invariant becomes structural. The API checks STAY — they exist to give
-- an admin a sentence explaining why, which a constraint violation cannot.
--
-- KEYED ON unit_type, matching shared/placement/holding-nodes.ts: a holding node
-- is defined by BEING a holding node, so a second one minted under a different
-- code is covered too. (A SQL constraint cannot import the TS constant; the
-- literal here is the same value HOLDING_UNIT_TYPE carries, and mig 0098 already
-- spells it the same way in the org_unit RLS policy.)
--
-- WHAT THIS DOES NOT COVER, stated plainly so the next reader does not
-- over-trust it: retyping a holding node to something else and THEN flipping the
-- flag satisfies this constraint, because the final row is no longer a holding
-- node. The API refuses to retype an existing holding node at all
-- (assertHoldingNodeTypeImmutable); raw SQL still can.

-- The repair before the constraint. A row in this state is already the defect
-- above — live, and mis-reporting every unplaced dollar as homed — so restoring
-- the invariant is the only correct direction; nothing legitimately depends on a
-- holding node being cost-owning. Announced rather than done silently.
DO $$
DECLARE offenders integer;
BEGIN
  SELECT COUNT(*) INTO offenders FROM org_unit WHERE unit_type = 'holding' AND is_cost_owning_unit;
  IF offenders > 0 THEN
    RAISE NOTICE 'mig 0110: clearing is_cost_owning_unit on % holding node(s) — a holding node may never be cost-owning', offenders;
    UPDATE org_unit SET is_cost_owning_unit = FALSE WHERE unit_type = 'holding' AND is_cost_owning_unit;
  END IF;
END $$;

ALTER TABLE org_unit
  ADD CONSTRAINT org_unit_holding_never_cost_owning
  CHECK (unit_type <> 'holding' OR NOT is_cost_owning_unit);

COMMENT ON CONSTRAINT org_unit_holding_never_cost_owning ON org_unit IS
  'A holding node (unit_type = ''holding'', shared/placement/holding-nodes.ts HOLDING_UNIT_TYPE) may never be cost-owning: chargeback homes spend on the nearest cost-owning ancestor, so marking one cost-owning would report every unplaced teammate''s spend as homed to a bucket nobody owns. server/db/org-units.ts keeps the same rule at the API for a legible error.';
