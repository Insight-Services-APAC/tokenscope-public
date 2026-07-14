-- Case-insensitive real-teammate email uniqueness (bill-driven placement follow-through).
--
-- mig 0057 created teammate_email_unique_real as a PARTIAL unique index on `email`
-- (EXACT case) WHERE NOT provisional. Bill-driven placement (mig 0066) stores
-- createBillTeammate emails lowercased, while Entra JIT sign-in stores the verbatim
-- (mixed-case) claim email and provider bills carry mixed-case actor emails. With an
-- EXACT-case index:
--   * the JIT bind-or-adopt email-collision guard (server/auth/jit-teammate.ts) is
--     bypassable -- `First.Last@` and `first.last@` are distinct slots, so an email
--     recycled to a new oid in a different case mints a DUPLICATE real teammate instead
--     of the intended "already owned by another identity" error; and
--   * two case-variant real rows make the `ORDER BY id LIMIT 1` tiebreak in every
--     teammate-by-email resolver (analytics poller, reconciliation adapter, placement
--     store) a silent mis-bind of spend.
--
-- Re-create the index on lower(email) so uniqueness, the collision guard, and all
-- resolvers agree on a single normalised key. (This is the lower(email) index the
-- reconciliation adapter's own comment flagged as the prerequisite for case-insensitive
-- matching.)
--
-- Assumes no pre-existing case-variant DUPLICATE real emails (true for the synthetic
-- dev/sandbox data). If any exist, this migration fails loudly so they are resolved
-- before the constraint lands -- preferable to silently mis-binding spend.
DROP INDEX IF EXISTS teammate_email_unique_real;
CREATE UNIQUE INDEX IF NOT EXISTS teammate_email_unique_real
  ON teammate (lower(email))
  WHERE NOT provisional;
