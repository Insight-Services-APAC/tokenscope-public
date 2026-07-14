-- 0051 — make the rate-card overlap EXCLUDE ignore retired cards (R1 F13).
--
-- 0050 rebuilt the 0001 EXCLUDE per scope tier but kept it TOTAL: a
-- retired card still occupied its period, so the retire-then-recreate
-- correction workflow the rate-card admin surface ships (retire the
-- wrong card, create the corrected one for the same period) was
-- physically impossible — the corrected card 23P01'd against the
-- retired row. Partial on retired_at IS NULL: only LIVE cards contend.
-- The joiner already filters retired_at IS NULL, so a retired card can
-- never price an event regardless.
--
-- Safe rebuild: dropping the constraint then re-adding can't fail on
-- existing data — every row satisfying the total constraint satisfies
-- the partial one.

ALTER TABLE rate_card DROP CONSTRAINT IF EXISTS rate_card_scope_key_effective_excl;

ALTER TABLE rate_card ADD CONSTRAINT rate_card_scope_key_effective_excl
  EXCLUDE USING gist (
    scope_key WITH =,
    COALESCE(region_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    COALESCE(cou_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    effective WITH &&
  )
  WHERE (retired_at IS NULL);
