-- 0042: reconciliation admin observability (Stream: reconciliation-admin).
--
-- worker_run.result: persist the worker's full returned result object (generic for
-- ALL workers). Today extractRowsAffected keeps a single number and the rich per-run
-- breakdown (scopesErrored, skippedInvalid, disposition counts, ...) is dropped. The
-- result objects are small scalar-count shapes with no secrets/PII; the write path
-- size-caps + fail-soft-swallows so a large/unserialisable result can never break a
-- worker.
ALTER TABLE worker_run
  ADD COLUMN IF NOT EXISTS result jsonb;

-- reconciliation_record.run_id: link each delta to the worker_run that wrote it, so an
-- admin can answer "what did this run produce?". computed_at cannot correlate (the
-- hourly idempotent upsert refreshes computed_at on the SAME open proposed row every
-- run, so it tracks the latest touch, not the creating run). ON DELETE SET NULL: a
-- worker_run is observability and may be GC'd independently of the ledger.
ALTER TABLE reconciliation_record
  ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES worker_run(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS reconciliation_record_run_id_idx
  ON reconciliation_record (run_id);
