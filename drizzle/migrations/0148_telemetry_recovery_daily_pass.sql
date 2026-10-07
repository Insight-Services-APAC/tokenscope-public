-- 0148 — the daily deep read becomes a scheduled telemetry_recovery_request.
--
-- The scheduled deep rescan re-read every selected instance's 7-day window,
-- one query per instance, inside an azure-monitor-read tick: unbounded heap
-- (OOM at 1 Gi on Dev, 2026-10-02) and the joiner's lock held for ~40 min.
-- telemetry-recovery now drains a system-queued request instead, one instance
-- and one day at a time. Design: docs/design/bounded-daily-deep-read.md.

-- Who queued it. 'scheduled' rows are queued by the worker and have no requester.
ALTER TABLE telemetry_recovery_request
  ADD COLUMN kind text NOT NULL DEFAULT 'operator',
  ADD CONSTRAINT trr_kind_chk CHECK (kind IN ('operator', 'scheduled'));

-- Resume point inside the instance at cursor_index: days of its window done.
ALTER TABLE telemetry_recovery_request
  ADD COLUMN cursor_day integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT trr_cursor_day_chk CHECK (cursor_day >= 0 AND cursor_day <= lookback_days);

-- One in-flight request per kind, so an operator's recovery is not refused
-- while the daily pass drains.
DROP INDEX telemetry_recovery_request_inflight_unique;
CREATE UNIQUE INDEX telemetry_recovery_request_inflight_unique
  ON telemetry_recovery_request (kind)
  WHERE status IN ('pending', 'running');

COMMENT ON TABLE telemetry_recovery_request IS
  'Widened re-reads of already-ingested telemetry, drained one instance-day at a time by the telemetry-recovery worker: operator recoveries and the scheduled daily 7-day pass.';
