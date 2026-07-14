-- 0027: project end_date model — EXPAND step (expand/contract, not rename-in-place).
--
-- Replaces the binary, past-only `retired_at` with a nullable, FUTURE-datable
-- `end_date`. NULL = open-ended. "Retire" becomes `end_date = now`; a planned
-- end is a future date; states (active / ending-soon / ended) derive from
-- `end_date` vs now. The who/when of the action lives in `audit_event`.
--
-- DEPLOY SAFETY: we ADD + backfill `end_date` and LEAVE `retired_at` in place
-- (vestigial) rather than RENAME. A rename is an add+drop in one shot, which
-- breaks the still-draining OLD app revision during a rolling Container Apps
-- deploy (it would `SELECT retired_at` against a column that no longer exists).
-- The new app reads/writes only `end_date`; `retired_at` is no longer read or
-- written by any code path. A FOLLOW-UP migration drops `retired_at` once the
-- old revision has fully drained (the "contract" step) — never in the same
-- deploy that introduces the readers of the new column.
--
-- Idempotent-friendly: ADD COLUMN IF NOT EXISTS + a backfill that only touches
-- rows where end_date is still NULL.

ALTER TABLE project ADD COLUMN IF NOT EXISTS end_date TIMESTAMPTZ;
UPDATE project SET end_date = retired_at WHERE end_date IS NULL AND retired_at IS NOT NULL;
