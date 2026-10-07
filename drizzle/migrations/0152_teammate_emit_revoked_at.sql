-- 0152 — a separate revocation anchor for device-bound emit credentials (#414).
--
-- teammate.revoked_at is bumped by a role change, a region move, an explicit
-- revoke-sessions and the shadow-teammate retirement. Every emit gate compared
-- against it, so granting someone a role killed their device's durable emit
-- credential and the device went silent until a full re-enrolment.
--
-- emit_revoked_at is bumped only by the events that must end a device's
-- emission: explicit revoke-sessions and retiring a teammate. A role change or
-- region move bumps revoked_at alone, which still re-validates interactive
-- sessions and read/tag credentials. A device-bound emit credential
-- (oauth_token.scope = 'tokenscope.emit' AND instance_id IS NOT NULL) carries
-- no read scope, and its RLS context is read live from the teammate row on
-- every request, so a re-scope reaches it without re-enrolment.
--
-- Backfill copies revoked_at, so every instance and credential that is refused
-- today stays refused after the deploy. Only bumps from here on are split.
ALTER TABLE teammate
  ADD COLUMN emit_revoked_at timestamptz NULL;

UPDATE teammate SET emit_revoked_at = revoked_at WHERE revoked_at IS NOT NULL;

COMMENT ON COLUMN teammate.emit_revoked_at IS
  'Revocation anchor for device emission: device-bound emit credentials and instances enrolled before it are refused. Bumped by revoke-sessions and teammate retirement only, never by a role or region change (#414). revoked_at remains the anchor for interactive sessions and read/tag credentials.';
