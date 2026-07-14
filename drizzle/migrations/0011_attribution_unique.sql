-- Read-joiner idempotency: at most one attribution_record per
-- (session_id, ts_event, token_type, model). The joiner used a non-atomic
-- SELECT-then-INSERT; under concurrent / overlapping runs (a scheduled tick
-- racing an inline assign-join, or a replayed trigger) that double-counted
-- spend. The joiner now inserts ON CONFLICT DO NOTHING against this index.
-- (adversarial-review R1 #5)

-- Collapse any pre-existing duplicates first so the unique index can build
-- (a.id < b.id deletes the lower-id twins, so the highest id per tuple survives).
DELETE FROM attribution_record a
USING attribution_record b
WHERE a.id < b.id
  AND a.session_id = b.session_id
  AND a.ts_event   = b.ts_event
  AND a.token_type = b.token_type
  AND a.model      = b.model;

CREATE UNIQUE INDEX IF NOT EXISTS attribution_record_session_event_unique
  ON attribution_record (session_id, ts_event, token_type, model);
