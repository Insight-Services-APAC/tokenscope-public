-- 0005_teammate_role — add durable role column for Wave-V JIT teammate bootstrap.
--
-- Wave-V originally read NUXT_BOOTSTRAP_ADMIN_EMAIL on every session-fetch
-- and re-derived role from that. The flaw: if the env var ever rotates
-- (typo correction, admin handoff, secret rotation), every admin's session
-- silently drops to `developer` at next fetch. Anchoring the resolved role
-- on the row itself fixes the flicker AND lets stop-impersonating restore
-- the original role (admin vs global-finops) without the [VERIFY] note's
-- "always restores as admin" caveat.
--
-- Default `developer` matches the pre-migration runtime behaviour for
-- every existing row. Per-persona role seeding lives in drizzle/seed.ts
-- (R2 F12 — migration-level UPDATEs were removed because seed re-runs
-- after every TRUNCATE-CASCADE and is the canonical owner of role-bound
-- demo personas).
ALTER TABLE teammate
  ADD COLUMN role TEXT NOT NULL DEFAULT 'developer';
