-- 0035: add source_run_id to the attribution_record dedup key.
--
-- The current unique index (migration 0017) is:
--   UNIQUE (instance_id, COALESCE(claude_session_id,''), ts_event, token_type, model)
--
-- Problem: two parallel Copilot subagent `chat` calls to the same model in the
-- same millisecond share the same parent conversation.id (= claude_session_id)
-- and the same ts_event + token_type + model. Without source_run_id in the key,
-- the second INSERT is silently dropped by ON CONFLICT DO NOTHING → under-count.
--
-- Fix: add source_run_id (= the spanId / requestId — a per-call unique value) to
-- the key, COALESCE'd to '' so NULL legacy rows keep the old 5-tuple dedup:
--   UNIQUE (instance_id, COALESCE(claude_session_id,''), ts_event, token_type,
--           model, COALESCE(source_run_id,''))
--
-- Claude-dedup safety: a re-emitted Claude record with the SAME request_id / spanId
-- still deduplicates to one row (same source_run_id). Two DISTINCT request_ids at
-- the same 5-tuple BOTH persist — this is a latent fix, not a regression.
-- NULL legacy rows (source_run_id IS NULL) dedup on COALESCE('') = the original key.
--
-- Idempotent: DROP INDEX IF EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS.

DROP INDEX IF EXISTS attribution_record_session_event_unique;

CREATE UNIQUE INDEX IF NOT EXISTS attribution_record_session_event_unique
  ON attribution_record (
    instance_id,
    (COALESCE(claude_session_id, '')),
    ts_event,
    token_type,
    model,
    (COALESCE(source_run_id, ''))
  );
