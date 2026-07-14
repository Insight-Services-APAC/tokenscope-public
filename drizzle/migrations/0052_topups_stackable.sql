-- 0052 — make top-ups stackable: scope the allocation no-overlap EXCLUDE to
-- baselines (and any future non-top-up kind) only.
--
-- mig 0008's EXCLUDE forbade two allocation rows of the SAME kind with
-- overlapping effective ranges. For baselines that is correct (one baseline
-- per period is unambiguous). For TOP-UPS it was wrong: top-ups are additive,
-- and fetchProjectAllocation (server/usage/consumption.ts) already SUMS every
-- baseline + top-up whose range contains now() — so two June top-ups should
-- simply stack to baseline + a + b. The constraint was the only thing stopping
-- "add more budget to this month": an admin topping up an over-budget project
-- that already had a top-up hit a 409 ("a top-up already covers part of this
-- range") with no way forward, because top-ups are append-only (only the
-- baseline is editable).
--
-- Partial rebuild is safe: every existing row satisfied the full constraint,
-- so it satisfies this strict subset. Baselines stay mutually non-overlapping;
-- top-ups become freely stackable. The DROP+ADD is transactional (the migrate
-- runner wraps each file), so there is no window without overlap protection.

ALTER TABLE allocation DROP CONSTRAINT IF EXISTS allocation_scope_dev_kind_eff_excl;

ALTER TABLE allocation ADD CONSTRAINT allocation_scope_dev_kind_eff_excl
  EXCLUDE USING gist (
    scope_type WITH =,
    scope_id WITH =,
    COALESCE(teammate_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    allocation_kind WITH =,
    effective WITH &&
  )
  WHERE (allocation_kind <> 'top-up');
