-- 0054: index diet + append-optimised autovacuum on attribution_record
-- (Phase B — ledger retention epic).
--
-- attribution_record is the insert-hot ledger; every index is write
-- amplification on the joiner's hot path. Drop the activity index (0 scans in
-- production — the `activity` dimension now lives in spend_rollup_daily / 0053,
-- so no read needs it on RAW).
--
-- The other low-scan indexes (cost_owning_unit / teammate / recorded / ...) are
-- DELIBERATELY KEPT for now: the per-CoU finance and per-teammate/per-project
-- reads still hit raw, and the rollup's own incremental day-set scans ts_recorded
-- — dropping these before those reads migrate off raw would regress live paths
-- (review M4). Revisit once the read migration completes.
DROP INDEX IF EXISTS attribution_record_activity;

-- Append-heavy table: trigger insert-driven autovacuum sooner (PG14+; default
-- 0.2) so the visibility map and freezing keep up as the ledger grows, instead
-- of a giant catch-up vacuum at scale.
ALTER TABLE attribution_record SET (autovacuum_vacuum_insert_scale_factor = 0.05);
