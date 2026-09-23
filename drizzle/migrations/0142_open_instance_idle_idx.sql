-- 0142 — index session-gc's idle-device scan.
--
-- session-gc closes idle devices in chunks (server/workers/session-gc.ts,
-- idleDevicePredicate). Without an index every chunk scanned the whole
-- instance_attestation table, ended rows included, so a large idle cohort
-- could spend the run's budget scanning instead of closing.
--
-- Partial over OPEN rows only: ended rows are never candidates and would only
-- grow the index. Keyed on the last sign of life, the predicate's selective
-- term; ts_expected_end is filtered from the heap. COALESCE over two columns is
-- immutable, unlike the `timestamptz + interval` the rule is stated in.
CREATE INDEX IF NOT EXISTS instance_attestation_open_last_sign_idx
  ON instance_attestation ((COALESCE(last_bearer_at, ts_start)))
  WHERE ts_actual_end IS NULL;

-- Bring every open device's ts_expected_end up to its idle-window rule, so a
-- session-gc from BEFORE this change (still reachable on an old replica while a
-- migrate-on-boot rollout drains) reads the same answer as the new one. The old
-- worker closes on ts_expected_end alone, which until now was fixed at
-- enrolment + 90 days even for a device minting daily. Idempotent.
UPDATE instance_attestation
   SET ts_expected_end = COALESCE(last_bearer_at, ts_start) + interval '90 days'
 WHERE ts_actual_end IS NULL
   AND (ts_expected_end IS NULL
        OR ts_expected_end < COALESCE(last_bearer_at, ts_start) + interval '90 days');
