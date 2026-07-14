-- 0018: per-conversation assignment (dogfood-followups §13).
--
-- The joiner attributes by the EMITTED project.code_hash (ADR-0004 B′). Records
-- with NO emitted hash (the device-enrol-only path) stay untagged — the joiner
-- has nothing to resolve a project from, and the assign endpoint's attestation
-- hash is deliberately NOT read by the joiner (B′ keeps the attestation hash out
-- of attribution). That left assigning an untagged CONVERSATION unable to
-- actually attribute its spend.
--
-- session_assignment is the missing per-conversation project mapping the
-- joiner CAN read as the fallback: emitted-hash (B′) ELSE this explicit
-- assignment ELSE untagged. Keyed on Claude's per-conversation session.id
-- (claude_session_id) + the teammate it was assigned by. The joiner still
-- applies the membership gate before honouring it, so a stale assignment to a
-- project the teammate has since left spills like any other claim.
--
-- claude_session_id is Claude's own per-conversation id (client-emitted,
-- spoofable-but-noise-only per ADR-0004) — it groups, it never crosses a
-- teammate. The (claude_session_id, teammate_id) uniqueness keeps it one
-- assignment per conversation per teammate; a different teammate's assignment of
-- a (forged) same id maps only their own stream.

CREATE TABLE session_assignment (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claude_session_id TEXT NOT NULL,
  teammate_id       UUID NOT NULL REFERENCES teammate(id),
  project_id        UUID NOT NULL REFERENCES project(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  source            TEXT NOT NULL DEFAULT 'manual',
  CONSTRAINT session_assignment_session_teammate_unique
    UNIQUE (claude_session_id, teammate_id)
);

-- The joiner's fallback lookup is (claude_session_id, teammate_id); the unique
-- constraint already indexes that. A teammate-scoped index supports the
-- untagged worklist's "is this conversation tagged for me" probe.
CREATE INDEX session_assignment_teammate_idx
  ON session_assignment (teammate_id, claude_session_id);
