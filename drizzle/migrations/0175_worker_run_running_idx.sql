-- 0175: worker_run (started_at) WHERE status = 'running', for the stuck-run sweep (#623).
--
-- reapStaleWorkerRuns (server/workers/run-health.ts) runs on every dispatch
-- tick: UPDATE worker_run ... WHERE status = 'running' AND started_at < cutoff.
-- Neither existing index is keyed on status, and `started_at < cutoff` matches
-- nearly every row, so the planner scanned the whole table each time. On dev
-- (Admin > Diagnostics > Database performance, 12 Nov): 122,438 calls at a
-- mean of 41.5 ms, and 197,218 sequential scans of worker_run.
--
-- The partial index holds only the rows still running (a handful), so the
-- sweep reads a few index entries. A run leaves it when it finishes, so it
-- stays tiny. PO agreed on #623.
--
-- LOCK WINDOW: plain CREATE INDEX, the 0137 shape. It takes SHARE on
-- worker_run: reads carry on, writes wait until the build commits. While the
-- build itself waits for a writer to finish, later worker_run writes (a
-- dispatch's start row, the sweep) queue behind it too, for at most the 5 s
-- lock_timeout per attempt. lock_timeout bounds only that wait, not the build;
-- the build reads the whole table once, and worker_run is small. On a lock
-- timeout the runner retries (6 attempts, drizzle/migrate.ts). If every attempt
-- times out, this transaction rolls back, the booting container stops
-- (entrypoint.sh), on Container Apps the revision already serving keeps
-- serving, and the next boot applies it.
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS worker_run_running_started_idx
  ON worker_run (started_at) WHERE status = 'running';
