-- 0137 — worker_run (started_at) index for the O4 duty-cycle summary.
-- Design: docs/design/performance-observability-baseline.md (O4, dr-M8/dr-H7):
-- the summary aggregates ALL workers over runs started in the trailing 24 h;
-- the existing worker_run_name_started_idx leads on worker_name and cannot
-- serve an all-workers started_at range scan.
--
-- LOCK WINDOW: plain CREATE INDEX (blocks writes, not reads) — the 0134 shape;
-- sub-second at current scale. lock_timeout makes this abort-and-retry at the
-- next deploy instead of queuing behind a mid-run dispatch writer.
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS worker_run_started_at_idx
  ON worker_run (started_at);

ANALYZE worker_run;
