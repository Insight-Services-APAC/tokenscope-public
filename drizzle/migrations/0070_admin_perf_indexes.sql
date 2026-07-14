-- 0070: admin-area read-path indexes (Stream: night-sprint-streamline).
--
-- The admin hub + sub-pages run filtered/ordered reads that today fall back to
-- broader scans. These indexes align with the exact WHERE+ORDER BY of the hot
-- admin endpoints. All IF NOT EXISTS + plain (non-CONCURRENTLY) so they apply
-- inside migrate.ts's per-file transaction (CONCURRENTLY can't run in a tx).
--
-- Existing-index audit (verified against 0001/0038/0042/0055 before adding):
--   * audit_event already has `audit_event_actor_ts (actor_teammate_id,
--     ts_recorded)` ASC (0001). Postgres scans a btree backward at ~no cost, so
--     that ASC index already serves `WHERE actor_teammate_id = $1 ORDER BY
--     ts_recorded DESC`; a DESC variant is redundant. SKIPPED (was added then
--     removed in review).
--   * attribution_record is NOT given a fresh ts_event index: a leading-ts_event
--     index already exists — `attribution_record_session_coverage_idx
--     (ts_event, instance_id, claude_session_id)` (0032/0055). A plain
--     (ts_event) index would be redundant with it, so it is intentionally
--     SKIPPED (see roadmap note below).
--   * reconciliation_record has `reconciliation_record_status_idx (status)`
--     alone (0038). The records reader filters status AND (optionally)
--     disposition; a (status, disposition) composite covers the default
--     `status='proposed'` + disposition filter the page sends.

-- Reconciliation records reader: WHERE status = $1 [AND disposition = $2].
CREATE INDEX IF NOT EXISTS reconciliation_record_status_dispo_idx
  ON reconciliation_record (status, disposition);

-- NOTE (skipped): attribution_record (ts_event) — already covered by the
-- leading column of attribution_record_session_coverage_idx. No index added.
