-- 0057: emit-on-install + provisional attribution — schema foundation (slice 2).
--
-- See docs/design/emit-on-install-provisional-attribution.md ("How it's stored").
-- Backward-compatible: every existing row keeps its current meaning. This adds the
-- IDENTITY-axis provenance plumbing the feature needs:
--
--   IDENTITY axis (provisional -> confirmed): dashboards / display only.
--     * instance_attestation.identity_state + claimed_email
--     * attribution_record.identity_state (propagated by the read joiner at insert)
--     * teammate.provisional + a PARTIAL email-unique (provisional rows neither
--       occupy nor collide with a real teammate's email slot)
--
-- The FINANCE axis is NOT an identity marker: money is anchored to the provider
-- bill (`actual_spend`) per the bill-anchored model (mig 0059) — there is no
-- per-(teammate, day) coverage gate. See the design doc §"finance = the bill".
--
-- Idempotent throughout (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / DROP IF EXISTS).

-- 1. instance_attestation: identity provenance.
--    Existing rows came through the AUTHENTICATED provision flow (provision_emit),
--    so they default 'confirmed'. The emit-on-install enroll path (slice 3) mints
--    rows with identity_state='provisional' + the claimed_email it was handed.
ALTER TABLE instance_attestation
  ADD COLUMN IF NOT EXISTS identity_state text NOT NULL DEFAULT 'confirmed',
  ADD COLUMN IF NOT EXISTS claimed_email text;

ALTER TABLE instance_attestation
  DROP CONSTRAINT IF EXISTS instance_attestation_identity_state_ck;
ALTER TABLE instance_attestation
  ADD CONSTRAINT instance_attestation_identity_state_ck
  CHECK (identity_state IN ('provisional', 'confirmed'));

-- 2. attribution_record: the joiner propagates the emitting instance's
--    identity_state onto each row at insert time, so every downstream surface can
--    decide whether to count / label provisional usage. NULL = legacy rows written
--    before 0057 (treat as 'confirmed' — they predate the provisional path).
ALTER TABLE attribution_record
  ADD COLUMN IF NOT EXISTS identity_state text;

-- 3. teammate: provisional shadow teammates. Slice 3 keys them on
--    entra_oid='provisional:'||uuid (entra_oid stays globally UNIQUE, unchanged).
--    The email UNIQUE constraint becomes a PARTIAL unique index excluding
--    provisional rows, so a claimed/provisional teammate neither occupies a real
--    teammate's email slot nor makes that teammate's first real Entra JIT sign-in
--    throw a unique violation (a self-inflicted outage).
ALTER TABLE teammate
  ADD COLUMN IF NOT EXISTS provisional boolean NOT NULL DEFAULT false;

-- Drop the inline 0001 UNIQUE (PG auto-named it teammate_email_key) and replace it
-- with the partial unique index. Existing rows are all provisional=false, so the
-- new index covers exactly the same rows the old constraint did -> no backfill
-- collision (every real email stays unique). A future drizzle-rendered name is
-- defensively dropped too.
ALTER TABLE teammate DROP CONSTRAINT IF EXISTS teammate_email_key;
ALTER TABLE teammate DROP CONSTRAINT IF EXISTS teammate_email_unique;
CREATE UNIQUE INDEX IF NOT EXISTS teammate_email_unique_real
  ON teammate (email)
  WHERE NOT provisional;
