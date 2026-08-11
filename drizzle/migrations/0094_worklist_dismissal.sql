-- 0094: dismissal — the third decision on the needs-tagging worklist.
--
-- Design: docs/design/needs-tagging-worklist.md.
--
-- WHY. The "Needs tagging" queue can only be retired two ways today: give the
-- item a budget, or give it an activity. A $0.01 subagent "hello" on the command
-- line deserves neither, so it sits in the queue forever and the developer
-- learns to ignore the whole card — including the $60 day-rows underneath it.
-- A queue that cannot reach empty stops being a queue.
--
-- WHAT DISMISSAL IS. A WORKLIST STATE, never a ledger state. Dismissing means "I
-- have decided: this is mine, it is not project work, and it is not worth a
-- label." The spend is NOT deleted, NOT hidden from any total, and NOT
-- re-attributed — it stays unallocated and still charges to the teammate's cost
-- centre exactly as before. What changes is only which bucket of the unallocated
-- split it lands in: `dismissed` instead of `needs tagging`. Read paths that
-- report the unallocated TOTAL must keep counting it.
--
-- If that invariant is ever weakened, "dismiss" becomes a button that makes
-- spend disappear, which is the one thing a chargeback tool must never ship.
--
-- TWO THINGS THE SCHEMA ENFORCES SO NO CALL SITE HAS TO REMEMBER THEM:
--
--   1. TAGGED XOR DISMISSED. A row can carry tags or a dismissal, never both.
--      "Tagged and also left unallocated" is a contradiction, and without the
--      constraint it is reachable by a stale client or by a dismissal racing a
--      tag (both writers would each be individually correct). The constraint
--      makes the contradiction unrepresentable rather than relying on every
--      present and future writer clearing the other side.
--
--   2. A DISMISSAL REMEMBERS WHAT IT DISMISSED (dismissed_cost_usd). A decision
--      about $0.01 is not a decision about the $65 that key later grows into —
--      an unaccounted day's delta is recomputed on every reconciliation run, and
--      a dismissed conversation can keep emitting. Storing the amount at the
--      moment of the decision is what lets the system hand an item back when it
--      materially outgrows what was waved through (see sweepStaleDismissals),
--      instead of letting "dismiss" quietly absorb unbounded future spend.
--
-- Both worklist item kinds get the same treatment so one bulk action can span them:
--   session_assignment  — a conversation (claude_session_id)
--   unaccounted_usage   — a provider-recorded (teammate, day, tool) row (§A)
--
-- REVERSIBLE by construction: dismissed_at IS NULL is the un-dismissed state, so
-- Restore is a single write and tagging (which supersedes a dismissal) clears it.

-- ── sessions ────────────────────────────────────────────────────────────────
-- session_assignment is already the per-(conversation, teammate) DECISION
-- RECORD; "I decided not to tag this" is a decision, so it belongs here rather
-- than in a parallel table that every read path would have to join separately.
ALTER TABLE session_assignment ADD COLUMN dismissed_at TIMESTAMPTZ;
ALTER TABLE session_assignment ADD COLUMN dismissed_cost_usd NUMERIC(14, 6);

COMMENT ON COLUMN session_assignment.dismissed_at IS
  'Worklist-only: set = the teammate decided to leave this conversation unallocated (it leaves "needs tagging"; its spend stays unallocated and still charges to their cost centre). Cleared by any tag write.';
COMMENT ON COLUMN session_assignment.dismissed_cost_usd IS
  'The conversation''s unallocated spend AT the moment of dismissal. The system hands the item back when its spend materially outgrows this (sweepStaleDismissals) — a decision about $0.01 is not a decision about $65.';

-- 0020 required a row to carry a project or an activity, so a dismissal-only row
-- (both axes NULL) would violate it. Dismissal is the third way for a row to be
-- meaningful. NOT VALID: the ADD then takes no full-table scan under the
-- ACCESS EXCLUSIVE lock; migration 0095 validates it in its OWN transaction
-- (this runner wraps each FILE in one transaction, so a VALIDATE here would hold
-- the exclusive lock from the DROP above until commit and buy nothing).
ALTER TABLE session_assignment DROP CONSTRAINT session_assignment_project_or_activity;
ALTER TABLE session_assignment
  ADD CONSTRAINT session_assignment_project_or_activity
  CHECK (project_id IS NOT NULL OR activity IS NOT NULL OR dismissed_at IS NOT NULL) NOT VALID;

-- TAGGED XOR DISMISSED (see header). Also validated in 0095.
ALTER TABLE session_assignment
  ADD CONSTRAINT session_assignment_tagged_xor_dismissed
  CHECK (dismissed_at IS NULL OR (project_id IS NULL AND activity IS NULL)) NOT VALID;

-- No index here: every READ path probes (claude_session_id, teammate_id), which
-- the existing session_assignment_session_teammate_unique index already serves,
-- and the "my dismissed" listing rides session_assignment_teammate_idx. The one
-- reader that scans BY dismissed_at is the stale-dismissal sweep, which is
-- indexed in 0096 — keep that pairing in mind before adding another scanner.

-- ── provider-recorded days (§A) ─────────────────────────────────────────────
-- unaccounted_usage already carries its own tag axes (project_id / activity /
-- tagged_at / tagged_by), so dismissal is more columns on the same row. NULL
-- project_id keeps meaning "not attributed"; dismissed_at answers the different
-- question "has the teammate decided about it".
ALTER TABLE unaccounted_usage ADD COLUMN dismissed_at TIMESTAMPTZ;
ALTER TABLE unaccounted_usage ADD COLUMN dismissed_cost_usd NUMERIC(14, 6);

COMMENT ON COLUMN unaccounted_usage.dismissed_at IS
  'Worklist-only: set = the teammate decided to leave this provider-recorded day unallocated. Spend is unchanged and still counts in the unallocated total; it just leaves the needs-tagging queue.';
COMMENT ON COLUMN unaccounted_usage.dismissed_cost_usd IS
  'The day''s reconciled delta AT the moment of dismissal. Reconciliation recomputes that delta on every run, so a dismissal that predates a large upward revision is stale and is handed back (sweepStaleDismissals).';

ALTER TABLE unaccounted_usage
  ADD CONSTRAINT unaccounted_usage_tagged_xor_dismissed
  CHECK (dismissed_at IS NULL OR (project_id IS NULL AND activity IS NULL)) NOT VALID;
