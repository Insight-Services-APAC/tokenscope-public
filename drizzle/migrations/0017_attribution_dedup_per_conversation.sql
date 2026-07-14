-- 0017: include claude_session_id in the attribution dedup key.
--
-- The 0011 unique index (instance_id, ts_event, token_type, model) predates the
-- per-conversation model. Multiple Claude conversations now share one
-- instance_id, so two DIFFERENT conversations emitting a record with the same
-- (ts_event, token_type, model) would COLLIDE — the joiner's ON CONFLICT DO
-- NOTHING would silently drop the second conversation's row, under-counting
-- spend and losing that conversation's attribution. Add claude_session_id to the
-- key.
--
-- COALESCE(claude_session_id, '') because NULLs are DISTINCT in a plain unique
-- index — without the coalesce, two legacy/NULL-conversation rows with the same
-- 4-tuple would NO LONGER dedup (a regression). Coalescing NULL to '' preserves
-- the original 4-tuple dedup for conversation-less rows while adding
-- conversation-awareness for the rest.

DROP INDEX IF EXISTS attribution_record_session_event_unique;
CREATE UNIQUE INDEX attribution_record_session_event_unique
  ON attribution_record (instance_id, (COALESCE(claude_session_id, '')), ts_event, token_type, model);
