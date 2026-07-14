-- 0016: Rename the instance-level id to instance_id, and add the
-- per-Claude-conversation claude_session_id to attribution_record.
--
-- "session_id" was always the DEVICE / enrolment (INSTANCE) id minted at
-- /tokenscope:enrol — NOT a Claude conversation. Multiple Claude conversations
-- (and the subagents within them, which share their parent's session.id) all
-- emit under one instance id. The real conversation id is Claude's own
-- session.id, now captured per-record in claude_session_id. See
-- docs/build/dogfood-followups.md §11.
--
-- RENAME COLUMN is atomic and preserves rows, the FKs
-- (attribution_record / session_health -> session_attestation), unique indexes,
-- and RLS policy expressions (Postgres updates dependent objects automatically).
-- claude_session_id is nullable: historical rows stay NULL (fall back to the
-- instance grouping); rows the joiner writes after this carry the conversation id.

ALTER TABLE session_attestation        RENAME COLUMN session_id TO instance_id;
ALTER TABLE attribution_record         RENAME COLUMN session_id TO instance_id;
ALTER TABLE session_attestation_health RENAME COLUMN session_id TO instance_id;

ALTER TABLE attribution_record ADD COLUMN claude_session_id TEXT;
CREATE INDEX IF NOT EXISTS attribution_record_claude_session_idx
  ON attribution_record (claude_session_id);
