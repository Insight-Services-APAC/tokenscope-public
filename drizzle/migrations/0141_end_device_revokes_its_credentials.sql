-- 0141 — ending a device revokes the credentials bound to it.
--
-- A device-bound credential (`oauth_token.instance_id`), and any outstanding
-- handoff that would mint one, must stop working the moment its device stops: ended (`ts_actual_end`), purged (`ts_purged`) or
-- deleted. Nine application paths end a device (self-revoke, /end, DELETE,
-- admin revoke-sessions, admin user/region changes, grant revoke, session-gc)
-- and soft-purge purges one; only re-provisioning revoked the credential. Every
-- other path left it live, so an access token minted before the end kept
-- working until its own 30-day expiry on routes that do not re-check the
-- device (`/instances/{id}/project-resolve`).
--
-- The rule lives here, not at the call sites, so no current or future writer
-- can end a device and forget its credential. Invoker rights, not SECURITY
-- DEFINER: every role that may end a device already holds UPDATE on
-- oauth_token, and oauth_token is outside RLS (server/db/rls-bootstrap.ts).
--
-- Unbound credentials (read/tag, legacy emit: instance_id NULL) are untouched:
-- they do not belong to a device.

CREATE OR REPLACE FUNCTION revoke_credentials_of_ended_device()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Lock order everywhere: device (held by the firing statement), then
  -- emit_handoff, then oauth_token. /setup/redeem, provision_emit and the
  -- credential binder take them in the same order (emit-provision.ts).
  --
  -- An outstanding handoff would otherwise redeem into a fresh credential for
  -- the ended device (the binder refuses that too: issueInstanceEmitCredentialTx).
  UPDATE emit_handoff
     SET consumed_at = now()
   WHERE instance_id = OLD.instance_id
     AND consumed_at IS NULL;
  UPDATE oauth_token
     SET revoked_at = now()
   WHERE instance_id = OLD.instance_id
     AND revoked_at IS NULL;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION revoke_credentials_of_ended_device() IS
  'A device-bound credential dies with its device: fires when instance_attestation is ended, purged or deleted.';

-- AFTER UPDATE, gated by WHEN so the ~29-minute /bearer heartbeat and every
-- other unrelated update never enters the function.
DROP TRIGGER IF EXISTS instance_attestation_end_revokes_credentials ON instance_attestation;
CREATE TRIGGER instance_attestation_end_revokes_credentials
  AFTER UPDATE OF ts_actual_end, ts_purged ON instance_attestation
  FOR EACH ROW
  WHEN (
    (OLD.ts_actual_end IS NULL AND NEW.ts_actual_end IS NOT NULL)
    OR (OLD.ts_purged IS NULL AND NEW.ts_purged IS NOT NULL)
  )
  EXECUTE FUNCTION revoke_credentials_of_ended_device();

-- BEFORE DELETE: the oauth_token.instance_id FK is ON DELETE SET NULL, which
-- would otherwise de-bind the credential first and leave it live and unbound.
DROP TRIGGER IF EXISTS instance_attestation_delete_revokes_credentials ON instance_attestation;
CREATE TRIGGER instance_attestation_delete_revokes_credentials
  BEFORE DELETE ON instance_attestation
  FOR EACH ROW
  EXECUTE FUNCTION revoke_credentials_of_ended_device();

-- A purged device is not live. soft-purge used to select by age alone, so
-- historical rows can be purged without ever being ended; end them at their
-- purge time so every reader that takes `ts_actual_end IS NULL` as "live" is
-- right. soft-purge now purges ended devices only, so this state cannot recur.
-- (The trigger above fires on this UPDATE and revokes their credentials.)
UPDATE instance_attestation
   SET ts_actual_end = ts_purged
 WHERE ts_purged IS NOT NULL
   AND ts_actual_end IS NULL;

-- Close the hole for devices already ended or purged before this migration.
UPDATE emit_handoff h
   SET consumed_at = now()
  FROM instance_attestation ia
 WHERE h.instance_id = ia.instance_id
   AND h.consumed_at IS NULL
   AND (ia.ts_actual_end IS NOT NULL OR ia.ts_purged IS NOT NULL);

UPDATE oauth_token t
   SET revoked_at = now()
  FROM instance_attestation ia
 WHERE t.instance_id = ia.instance_id
   AND t.revoked_at IS NULL
   AND (ia.ts_actual_end IS NOT NULL OR ia.ts_purged IS NOT NULL);
