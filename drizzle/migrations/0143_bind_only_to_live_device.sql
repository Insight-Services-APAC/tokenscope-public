-- 0143 — a live credential can only be bound to a live device of its teammate.
--
-- Mig 0141 revokes a device's credentials when the device ends, which covers
-- every credential bound BEFORE the end. A bind landing AFTER it would leave a
-- live credential on an ended device with no second end to revoke it. The
-- application binder refuses that (issueInstanceEmitCredentialTx), but a
-- binder that predates it still runs during a migrate-on-boot rolling deploy,
-- and any future writer could forget. The database is the boundary.
--
-- Fires only when a LIVE credential gains or changes its device binding or
-- its teammate (confirm-instance re-points both, device first), so refresh,
-- grant bookkeeping and revocation never enter it. FOR SHARE waits
-- for an in-flight end of the device and then judges its committed state.

CREATE OR REPLACE FUNCTION oauth_token_bind_only_to_live_device()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM instance_attestation
     WHERE instance_id = NEW.instance_id
       AND teammate_id = NEW.teammate_id
       AND ts_actual_end IS NULL
       AND ts_purged IS NULL
       FOR SHARE
  ) THEN
    RAISE EXCEPTION
      'oauth_token % cannot be bound to device %: it is ended, purged or not this teammate''s',
      NEW.id, NEW.instance_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION oauth_token_bind_only_to_live_device() IS
  'A live credential binds only to a live device of its teammate: a bind after the device ended would outlive mig 0141''s revoke-on-end.';

DROP TRIGGER IF EXISTS oauth_token_bind_only_to_live_device ON oauth_token;
CREATE TRIGGER oauth_token_bind_only_to_live_device
  BEFORE INSERT OR UPDATE OF instance_id, teammate_id ON oauth_token
  FOR EACH ROW
  WHEN (NEW.instance_id IS NOT NULL AND NEW.revoked_at IS NULL)
  EXECUTE FUNCTION oauth_token_bind_only_to_live_device();

-- Repair binds that landed before this guard existed. Each migration file
-- commits on its own, so during a migrate-on-boot rollout an old binder can
-- bind a live credential to a device that 0141 already saw end. Revoke every
-- live credential bound to a device that is ended, purged or not its
-- teammate's. (Updating revoked_at does not fire the bind trigger above.)
UPDATE oauth_token t
   SET revoked_at = now()
 WHERE t.revoked_at IS NULL
   AND t.instance_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM instance_attestation ia
      WHERE ia.instance_id = t.instance_id
        AND ia.teammate_id = t.teammate_id
        AND ia.ts_actual_end IS NULL
        AND ia.ts_purged IS NULL
   );
