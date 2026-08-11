-- 0099 — instance_attestation.tool must be non-blank.
--
-- `tool` is already NOT NULL, and every application writer goes through the
-- `EmitTool` union ('claude-code' | 'copilot-cli'), so a blank or
-- whitespace-only value should be unreachable. That is a COMPILE-time
-- guarantee, though, not a database one: a raw-SQL backfill, a migration, or a
-- future writer that bypasses the type can still produce ''.
--
-- Why that matters rather than being a tidiness nit: the cross-tool guard in
-- server/auth/emit-provision.ts decides whether re-provisioning an existing
-- instance is safe by comparing the STORED tool against the requested one. A
-- blank stored tool makes that comparison undecidable, and the guard's whole
-- job is to prevent re-provisioning from revoking the other CLI's live emit
-- credential on the same host. The guard now fails CLOSED on a blank value
-- (409), so the failure mode is a refused setup rather than a destroyed
-- credential; this constraint removes the state entirely so the refusal is
-- unreachable in the first place.
--
-- No backfill is paired with this: if any row DID carry a blank tool, silently
-- rewriting it would be guessing which CLI owns the device, and guessing wrong
-- reintroduces exactly the credential-revocation bug it is meant to prevent.
-- Such a row needs a human who knows the device.
--
-- WHY A TRIGGER AND NOT A CHECK CONSTRAINT. Two earlier revisions of this file
-- both reached for `ADD CONSTRAINT ... CHECK`, and both were wrong for the same
-- unexamined reason. A validating CHECK aborts the migration (and every
-- migration after it) on a pre-existing blank row. `NOT VALID` avoids that, but
-- a CHECK — valid or not — is re-evaluated against the WHOLE new row version on
-- every UPDATE, not just against writes that touch the constrained column. A
-- legacy blank row would therefore become permanently un-updatable: it could
-- not be revoked (server/api/v1/me/instances/[instanceId]/revoke.post.ts:52),
-- ended, region-reassigned, PII-purged (server/workers/soft-purge.ts:45), or
-- even have its bearer refreshed (server/api/v1/instances/[instanceId]/bearer.get.ts:184).
-- That converts "one refused setup" into "one row no operator can remediate and
-- no worker can maintain" — strictly worse than the state being closed.
--
-- A `BEFORE INSERT OR UPDATE OF tool` trigger is the mechanism that matches the
-- intent: it fires on every INSERT and on any UPDATE whose SET list mentions
-- `tool`, and it ignores UPDATEs that leave the column alone. New blanks are
-- impossible, blank-to-blank rewrites are impossible, and unrelated lifecycle
-- maintenance on a legacy row still works — including the UPDATE that ends it,
-- which is how a human resolves one.

CREATE OR REPLACE FUNCTION instance_attestation_tool_nonblank()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF btrim(NEW.tool) = '' THEN
    RAISE EXCEPTION
      'instance_attestation.tool must be non-blank (instance_id=%)', NEW.instance_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION instance_attestation_tool_nonblank() IS
  'tool must be non-blank: the cross-tool re-provisioning guard (server/auth/emit-provision.ts) compares stored vs requested tool to decide whether rotating this instance''s emit credential would revoke another CLI''s. A blank value makes that undecidable.';

DROP TRIGGER IF EXISTS instance_attestation_tool_nonblank ON instance_attestation;

CREATE TRIGGER instance_attestation_tool_nonblank
  BEFORE INSERT OR UPDATE OF tool ON instance_attestation
  FOR EACH ROW
  EXECUTE FUNCTION instance_attestation_tool_nonblank();
