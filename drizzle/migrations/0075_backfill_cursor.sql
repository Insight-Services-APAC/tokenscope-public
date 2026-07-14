-- 0075: resumable backfill — add a cursor to reconciliation_backfill_request (mig 0074).
--
-- A GitHub backfill pulls per-seat-PER-DAY, so a wide window (days × seats) easily exceeds the
-- worker's request budget. The worker therefore processes the window in bounded DAY CHUNKS within
-- a time budget, persisting how far it got; the next invocation resumes from cursor_date. NULL
-- until first claimed (then set to start_date); 'succeeded' when it passes end_date.
ALTER TABLE reconciliation_backfill_request ADD COLUMN cursor_date date;
