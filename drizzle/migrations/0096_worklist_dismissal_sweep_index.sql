-- 0096: index the dismissal flag, because it now has a reader.
--
-- 0094 deliberately shipped NO index on dismissed_at, and said so: every read
-- path probes (claude_session_id, teammate_id) or (teammate_id, day), which
-- existing indexes already serve, so a partial index would have been write cost
-- with no reader.
--
-- sweepStaleDismissals is that reader. It runs from the joiner on every tick and
-- from every reconciliation run, and its driving predicate is exactly
-- `dismissed_at IS NOT NULL` with no teammate bound — a sequential scan of the
-- whole table each time, on the hot path of the worker that writes attribution.
-- The justification 0094 gave stopped being true the moment the sweep landed.
--
-- Partial, so the index holds only the dismissed rows (a small minority, and the
-- exact set the sweep wants) and costs nothing on the far more common write of a
-- tagged row.

CREATE INDEX session_assignment_dismissed_idx
  ON session_assignment (dismissed_at) WHERE dismissed_at IS NOT NULL;

CREATE INDEX unaccounted_usage_dismissed_idx
  ON unaccounted_usage (dismissed_at) WHERE dismissed_at IS NOT NULL;
