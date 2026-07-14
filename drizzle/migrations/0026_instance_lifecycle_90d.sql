-- 0026: instance lifecycle follows the durable OAuth credential, not the dead 12h token.
--
-- Root cause of the 2026-06-06 attribution outage + the re-enrol treadmill:
-- /setup/exchange stamped instance_attestation.ts_expected_end = ts_start + 12h
-- (the DEAD session-token TTL), even though the durable OAuth emit credential
-- lives 90 days (refresh token). session-gc then closed still-emitting instances
-- at 12h, and the read-joiner dropped closed + already-attributed instances, so
-- spend stopped attributing while emission continued.
--
-- The code is fixed forward (exchange now stamps ts_start + 90d; session-gc's
-- NULL fallback + the joiner's recently-closed re-scan are aligned). This
-- migration repairs EXISTING OPEN instances still carrying the short ~12h TTL so
-- session-gc does not close them prematurely.
--
-- Idempotent: only touches open, non-purged instances whose expected end is well
-- under the durable life (i.e. the legacy short TTL). Re-running is a no-op
-- because the updated rows then sit beyond the threshold.

UPDATE instance_attestation
   SET ts_expected_end = ts_start + INTERVAL '90 days'
 WHERE ts_actual_end IS NULL
   AND ts_purged IS NULL
   AND ts_expected_end < ts_start + INTERVAL '80 days';

-- The legacy 12h per-instance session token is removed (ADR-0005 superseded it
-- with the durable OAuth emit credential). /setup/exchange no longer writes
-- session_token_hash, and /bearer + /end no longer read it, so the column must be
-- nullable. We DROP NOT NULL only (NOT the column) so the currently-deployed app,
-- which still SELECTs the column during the deploy window, keeps working; the
-- column becomes vestigial (never written/read after this) and existing rows keep
-- their historical hash. Idempotent: dropping an already-nullable NOT NULL is a no-op.
ALTER TABLE instance_attestation ALTER COLUMN session_token_hash DROP NOT NULL;
