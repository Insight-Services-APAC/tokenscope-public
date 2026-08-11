-- 0128 — close is a SNAPSHOT, not a lock.
--
-- Design: docs/design/close-is-a-snapshot.md, docs/design/next-sprint-plan.md §1.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────
-- TokenScope is not the billing system of record. The provider's bill is
-- authoritative, and until now a closed month REFUSED it — on two paths at once:
--
--   Anthropic  the 0116 BEFORE ROW trigger on actual_spend (INSERT-new, DELETE,
--              amount-UPDATE and re-date all raise), plus a TRUNCATE guard
--   Copilot    an application-level 409 in copilot-bill-repull.post.ts
--
-- The owner's timeline: close at +2 after month end, Copilot corrects its rows
-- at +6, the bill lands at +10 — and the product rejects it because of a state
-- we set ourselves. "The bill is right, we are not." Refusing the source does
-- not protect the month; it guarantees the month stays wrong, silently, until
-- somebody performs a reopen → re-pull → re-close ceremony.
--
-- So the bill always lands. Closing RECORDS what we reported; it blocks nothing.
-- When a closed month later moves, the product says so and by how much.
--
-- NOTE for anyone reading Reporting.md:792-805, which describes `restate` as the
-- audited path "for a known correction (e.g. a late bill anchor)": the original
-- design SAW this case and chose block-then-restate. This migration reverses
-- that trade deliberately, on the grounds that we are not the record of truth.
-- It is a decision, not a correction of an oversight.
--
-- ── ROLLING DEPLOY ───────────────────────────────────────────────────────────
-- Ordered so an old replica degrades rather than corrupts. The DROP COLUMN is
-- LAST: until an old replica is replaced its `upsertActualSpend` will error on
-- the missing column. Every writer of that column is a cron worker — idempotent
-- and retried on the next tick — and no request path writes it. Stated here
-- rather than discovered.

-- ── 1 · the close guard comes off BOTH lanes ─────────────────────────────────
-- Half of this was invisible to both source documents: the Copilot 409 is in
-- application code and easy to find, while the Anthropic refusal is a database
-- trigger that raises inside a worker. Removing one without the other ships a
-- fix that looks complete and still rejects the bill.
DROP TRIGGER IF EXISTS actual_spend_finance_close_guard ON actual_spend;
DROP TRIGGER IF EXISTS actual_spend_finance_close_guard_truncate ON actual_spend;
DROP FUNCTION IF EXISTS actual_spend_finance_close_guard();
DROP FUNCTION IF EXISTS actual_spend_finance_close_guard_truncate();

-- ── 2 · finance_period becomes reporting_snapshot ────────────────────────────
-- The rename IS the point. "finance_period"/"close" are accounting words for a
-- thing that only ever froze a governance verdict, and that naming is what led a
-- placement design to be built on a period boundary that never existed.
ALTER TABLE finance_period RENAME TO reporting_snapshot;
ALTER INDEX IF EXISTS finance_period_pkey RENAME TO reporting_snapshot_pkey;

-- A row's EXISTENCE is the close. Nothing reopens, so nothing needs a state
-- machine — and every column below existed only to serve one.
ALTER TABLE reporting_snapshot
  DROP COLUMN IF EXISTS state,
  DROP COLUMN IF EXISTS reopened_at,
  DROP COLUMN IF EXISTS reopened_by,
  DROP COLUMN IF EXISTS reopen_reason,
  DROP COLUMN IF EXISTS restated_at,
  DROP COLUMN IF EXISTS restated_by,
  DROP COLUMN IF EXISTS restate_reason;

-- The snapshot itself. Defaults exist ONLY so the ALTER succeeds on any row that
-- predates it; `closeReportingSnapshot` always writes every column explicitly.
ALTER TABLE reporting_snapshot
  ADD COLUMN basis            text     NOT NULL DEFAULT 'project-homed',
  ADD COLUMN snapshot_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN attributed_usd   numeric(14,6) NOT NULL DEFAULT 0,
  ADD COLUMN chargeable_usd   numeric(14,6) NOT NULL DEFAULT 0,
  ADD COLUMN exempt_usd       numeric(14,6) NOT NULL DEFAULT 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- LEGACY ROWS DID NOT RECORD ANY FIGURES, AND MUST NOT PRETEND THEY DID.
--
-- A pre-existing `finance_period` row stored a state machine, not totals. The
-- defaults above turn every one of them into a snapshot claiming the month read
-- $0.00 — which then renders on the admin card as a recorded figure and is a
-- fabricated number, not a missing one.
--
-- `snapshot_version = 0` is the explicit "recorded before we captured totals"
-- marker. It is below SNAPSHOT_VERSION, so the delta already refuses to subtract
-- (`version-changed`), and readers show "figures not recorded" instead of $0.
-- The row is kept rather than deleted: WHEN a month was closed, and by whom, is
-- real history even when the amounts were never stored.
UPDATE reporting_snapshot SET snapshot_version = 0;

-- `basis` is not decoration: without it a delta cannot tell "money moved" from
-- "we changed how we count", and would report a confident wrong number.
ALTER TABLE reporting_snapshot
  ADD CONSTRAINT reporting_snapshot_basis_chk
  CHECK (basis IN ('person-placed', 'project-homed'));

COMMENT ON TABLE reporting_snapshot IS
  'What a calendar month looked like when it was closed — totals, basis, arm row counts, who closed it and when. A record, NOT a lock: ingestion, re-polls and governance recompute all proceed on a closed month exactly as on an open one, and a month that subsequently moves reports its delta against this row. Absence = never closed. See docs/design/close-is-a-snapshot.md.';
COMMENT ON COLUMN reporting_snapshot.basis IS
  'The attribution basis in force at close. A delta across differing bases is not money moving and must refuse to subtract.';
COMMENT ON COLUMN reporting_snapshot.snapshot_version IS
  'Bumped when WHAT is snapshotted changes. A delta across versions refuses rather than comparing unlike things.';
COMMENT ON COLUMN reporting_snapshot.exempt_usd IS
  'The chargeback-excluded portion. Makes a governance verdict flip visible even when the attributed total has not moved.';

-- ── 3 · NO per-unit lines, and no arm row counts ─────────────────────────────
-- Both were drafted and cut before shipping. They had no reader: the delta this
-- change exists for is a MONTH-level statement ("August closed at $X, now reads
-- $Y"), and per-Business-Unit lines plus per-arm row counts were captured on the
-- argument that a snapshot cannot be reconstructed later.
--
-- True, and not a reason. This is not a finance system, and speculative capture
-- for a surface nobody has asked for is the same overengineering that produced
-- the close/reopen/restate machinery this migration is deleting — roughly 1,457
-- lines of it. Add them when something renders them.

-- ── 4 · the per-row verdict freeze goes ──────────────────────────────────────
-- LAST, and deliberately: an old replica writing this column errors until it is
-- replaced. All such writers are idempotent cron workers.
--
-- It has to go for close-is-a-snapshot acceptance 4 — "a governance rule change
-- on a closed month applies, and shows in the delta". A frozen per-row verdict
-- makes that impossible. `exempt_usd` on the snapshot is the bounded, honest
-- replacement: a verdict flip shows as a delta on that measure without
-- materialising a per-row copy of every judgement we have ever made.
ALTER TABLE actual_spend DROP COLUMN IF EXISTS governance_verdict_locked_at;
