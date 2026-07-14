-- Region-trigger backfill for pre-existing drifted rows (mig 0066 follow-up).
--
-- Mig 0066 added trigger `teammate_sync_region_id` (the BEFORE INSERT/UPDATE
-- function that derives teammate.region_id from its org_unit's region on every
-- write). Rows written BEFORE that trigger existed may have a region_id that no
-- longer matches their org_unit's region (the JIT path used to default region_id
-- to the first region while placement re-homed org_unit_id independently — H-A).
--
-- We backfill ONLY the SAFE rows: bill-provisioned teammates (entra_oid LIKE
-- 'bill:%') that have NO live instance session. These have never signed in and
-- never emitted under a live session, so silently snapping their region_id to the
-- correct value has no downstream effect to unwind.
--
-- We deliberately LEAVE drifted rows for a real (signed-in / live-session)
-- teammate to an admin. For a live teammate a region change is not a value fix —
-- it must go through the admin region-PATCH path, which runs a REVOKE CASCADE
-- (instance/session revocation + re-attribution) so spend is correctly re-homed.
-- Auto-moving such a row here would change its region WITHOUT that cascade,
-- leaving live sessions and spend stranded under the old region. So drifted live
-- rows are intentionally NOT touched — an admin resolves them through the proper
-- revoke-cascade flow.
--
-- Idempotent: `region_id IS DISTINCT FROM ou.region_id` makes a re-run a no-op
-- once a row is corrected.

UPDATE teammate t
SET region_id = ou.region_id
FROM org_unit ou
WHERE ou.id = t.org_unit_id
  AND t.region_id IS DISTINCT FROM ou.region_id
  AND t.entra_oid LIKE 'bill:%'
  AND NOT EXISTS (
    SELECT 1 FROM instance_attestation ia
    WHERE ia.teammate_id = t.id AND ia.ts_actual_end IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM oauth_token o
    WHERE o.teammate_id = t.id AND o.revoked_at IS NULL
  );
