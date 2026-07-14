-- 0021: itemise unallocated spend — make attribution_record.project_id (and
-- cost_owning_unit_id) NULLABLE.
--
-- Until now the joiner SKIPPED any record it couldn't attribute to a project, so
-- unallocated spend lived only as the live-reader worklist + the actuals gap (two
-- sources that could disagree). Making project_id nullable lets the joiner write
-- project-LESS rows, so attribution_record becomes the SINGLE source of truth for
-- every spend state — project-attributed, tagged-only, and untagged. It also lets
-- a mis-tagged project session be moved back to unallocated by NULLing the project
-- rather than deleting the ledger row. This activates the long-anticipated
-- 'WHERE project_id IS NULL' path (see rollups/finance.get.ts).
--
-- Safe: existing rows all have a project_id, so dropping NOT NULL changes nothing
-- for them; the FK (project_id -> project) still holds for non-null values.

ALTER TABLE attribution_record ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE attribution_record ALTER COLUMN cost_owning_unit_id DROP NOT NULL;

-- The unallocated worklists group project-less rows by conversation per teammate;
-- a partial index keeps that hot path fast without bloating the main indexes.
CREATE INDEX attribution_record_unallocated
  ON attribution_record (teammate_id, claude_session_id)
  WHERE project_id IS NULL;
