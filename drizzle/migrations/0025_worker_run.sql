-- 0025: worker_run — per-dispatch execution-health ledger.
--
-- The diagnostics freshness panel measures DATA recency (max ts_recorded)
-- and so reported "flowing" green while the joiner cron was FAILING every
-- run with a 504 — a partially-completing worker still advances ts_recorded.
-- The operator had no surface that showed the failing worker.
--
-- This table records the OUTCOME of each worker dispatch (running → success
-- | failure) so per-worker execution health can be surfaced in admin
-- diagnostics. Written by POST /api/v1/internal/run-worker/{name}.
--
-- Additive + idempotent.

CREATE TABLE IF NOT EXISTS worker_run (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_name   text NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  -- 'running' | 'success' | 'failure'
  status        text NOT NULL,
  duration_ms   integer,
  rows_affected integer,
  -- Truncated (~500 chars) failure message — never a secret.
  error         text,
  region_id     uuid
);

-- Backs the latest-per-worker read (DISTINCT ON / window function) + the
-- trailing-failure count in the diagnostics endpoint.
CREATE INDEX IF NOT EXISTS worker_run_name_started_idx
  ON worker_run (worker_name, started_at DESC);
