-- 0043: make the bearer-auth-failed health signal actually atomic (CORE-5,
-- robustness review 2026-06-09).
--
-- recordBearerAuthFailed used INSERT … WHERE NOT EXISTS, which is NOT atomic
-- under concurrency: two transactions both pass NOT EXISTS and both insert,
-- and the 0029 partial index is non-unique — so multiple open
-- bearer-auth-failed rows per instance double-count the disaster signal (the
-- went-silent worker alerts per open row). Replace the 0029 index with a
-- partial UNIQUE one; the helper adds ON CONFLICT DO NOTHING.

-- Dedup any already-doubled open episodes first (keep the EARLIEST detection —
-- the episode's true start), or the unique index cannot build.
UPDATE instance_attestation_health h
   SET resolved_at = now()
 WHERE h.status = 'bearer-auth-failed'
   AND h.resolved_at IS NULL
   AND EXISTS (
     SELECT 1 FROM instance_attestation_health earlier
      WHERE earlier.instance_id = h.instance_id
        AND earlier.status = 'bearer-auth-failed'
        AND earlier.resolved_at IS NULL
        AND (earlier.detected_at < h.detected_at
             OR (earlier.detected_at = h.detected_at AND earlier.id < h.id))
   );

DROP INDEX IF EXISTS instance_attestation_health_open_bearer;

-- Same shape as 0029 (the /bearer resolve probe and the went-silent worker
-- filter on this exact predicate) — now UNIQUE: one open episode per instance.
CREATE UNIQUE INDEX IF NOT EXISTS instance_attestation_health_open_bearer
  ON instance_attestation_health (instance_id)
  WHERE status = 'bearer-auth-failed' AND resolved_at IS NULL;
