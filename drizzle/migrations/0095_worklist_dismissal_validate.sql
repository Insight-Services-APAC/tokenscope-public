-- 0095: validate the constraints 0094 added NOT VALID.
--
-- Separate FILE on purpose, not fussiness: migrate.ts wraps each file in one
-- transaction, so a VALIDATE in 0094 would run while that transaction still
-- holds the ACCESS EXCLUSIVE lock its DROP CONSTRAINT took — the full-table scan
-- would block every tag and dismissal for its duration, which is exactly what
-- splitting ADD ... NOT VALID from VALIDATE exists to avoid. In its own
-- transaction, VALIDATE CONSTRAINT takes only SHARE UPDATE EXCLUSIVE and readers
-- and writers keep running.
--
-- Both constraints hold trivially on existing data (no row has dismissed_at set
-- — the column did not exist a moment ago), so this is fast and cannot fail. It
-- is what makes the constraints enforceable by the planner and, more to the
-- point, what makes "tagged and dismissed" unrepresentable rather than merely
-- discouraged.

ALTER TABLE session_assignment VALIDATE CONSTRAINT session_assignment_project_or_activity;
ALTER TABLE session_assignment VALIDATE CONSTRAINT session_assignment_tagged_xor_dismissed;
ALTER TABLE unaccounted_usage VALIDATE CONSTRAINT unaccounted_usage_tagged_xor_dismissed;
