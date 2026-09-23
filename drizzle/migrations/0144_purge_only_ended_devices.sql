-- 0144 — only an ended device can be purged.
--
-- soft-purge clears a device's identity columns and sets ts_purged; a purged
-- device's credentials are revoked (0141) and /bearer treats it as ended. An
-- OPEN device must therefore never be purged: it would be cut off while in use.
-- The current worker purges ended devices only, but one from before that change
-- can still run on an old replica during a migrate-on-boot rollout, and any
-- future writer could forget. The database refuses the transition instead.
CREATE OR REPLACE FUNCTION instance_attestation_purge_only_ended()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.ts_actual_end IS NULL THEN
    RAISE EXCEPTION
      'instance_attestation % cannot be purged while it is live (end it first)', NEW.instance_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION instance_attestation_purge_only_ended() IS
  'Only an ended device can be purged: purging a live one would cut it off while in use.';

DROP TRIGGER IF EXISTS instance_attestation_purge_only_ended ON instance_attestation;
CREATE TRIGGER instance_attestation_purge_only_ended
  BEFORE UPDATE OF ts_purged ON instance_attestation
  FOR EACH ROW
  WHEN (OLD.ts_purged IS NULL AND NEW.ts_purged IS NOT NULL)
  EXECUTE FUNCTION instance_attestation_purge_only_ended();
