-- 0032: heartbeat-coverage / quarantined-spend detection (MCP client backbone,
-- design doc §"Heartbeat-coverage / quarantined spend").
--
-- THREAT MODEL (design doc §"untrusted LAW channel"): the emit credential lives
-- in ~/.claude/settings.json on every dev box and is effectively public-write —
-- anyone with an emit token can write SPOOFED attribution_record rows claiming a
-- victim's instance_id / project / email. That telemetry lands provisionally
-- "assigned to you" until reconciliation against Anthropic actuals confirms or
-- WIPES it. This feature is the EARLY/UX detection leg of revoke+detect+reconcile:
-- it surfaces "unverified spend" before reconciliation (which lags ~1h+) by
-- cross-checking spend against the AUTHENTICATED heartbeat instance_attestation.
-- last_bearer_at (stamped on every successful /bearer mint — proof the OWNER held
-- a valid emit credential at time T, which a cross-instance spoofer cannot forge).
--
-- It CATCHES the cross-instance spoof (records claiming a victim instance_id the
-- spoofer can't mint a bearer for → no covering heartbeat). It does NOT catch full
-- emit-credential THEFT (the thief owns the instance, so its /bearer mints heartbeat
-- as the victim) — that stays on revocation + reconciliation. Quarantine is purely
-- INFORMATIONAL: it NEVER auto-revokes or auto-deletes. Reconciliation is the only
-- thing that wipes non-reconciling spend.

-- ── coverage-scan index ─────────────────────────────────────────────────────
-- The coverage check's DRIVING predicate is `ts_event >= cutoff` (the lookback
-- window) — it groups across ALL instances, with no instance_id filter. So the
-- index must LEAD with ts_event to prune the range scan to the window; the trailing
-- (instance_id, claude_session_id) cover the per-session MIN/MAX grouping. (An
-- instance_id-leading index could not satisfy the ts_event range and would be
-- write-amplification on the hottest table for no read benefit.)
CREATE INDEX IF NOT EXISTS attribution_record_session_coverage_idx
  ON attribution_record (ts_event, instance_id, claude_session_id);

-- ── session_quarantine ──────────────────────────────────────────────────────
-- Minimal persisted result of the coverage worker. One row per quarantined
-- (session, instance). Recomputed each run: a session that gains a covering
-- heartbeat (e.g. a late /bearer stamp, or reconciliation) is cleared by the
-- worker. We persist (rather than compute on every read) so the read endpoint /
-- badge is cheap, and so an audit trail of "what looked unverified, and when"
-- exists for the reconciliation reviewer.
CREATE TABLE IF NOT EXISTS session_quarantine (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The CONVERSATION key — COALESCE(claude_session_id, instance_id::text) from the
  -- coverage grouping. Text because legacy rows fall back to the instance id.
  conversation_id    TEXT NOT NULL,
  instance_id        UUID NOT NULL REFERENCES instance_attestation (instance_id),
  teammate_id        UUID NOT NULL REFERENCES teammate (id),
  region_id          UUID NOT NULL REFERENCES region (id),
  org_unit_id        UUID NOT NULL REFERENCES org_unit (id),
  -- The session's observed event window (the span the heartbeat had to cover).
  session_ts_start   TIMESTAMPTZ NOT NULL,
  session_ts_end     TIMESTAMPTZ NOT NULL,
  -- The instance's authenticated-live window at detection time, for the "why".
  instance_ts_start  TIMESTAMPTZ NOT NULL,
  last_bearer_at     TIMESTAMPTZ,
  -- Spend the unverified session claims (informational; reconciliation is truth).
  cost_usd           NUMERIC(14, 6) NOT NULL DEFAULT 0,
  tokens             BIGINT NOT NULL DEFAULT 0,
  -- 'no-covering-heartbeat' today; a discriminator for future reasons.
  reason             TEXT NOT NULL DEFAULT 'no-covering-heartbeat',
  detected_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set when a later run finds the session now covered (cleared, not deleted, so
  -- the reviewer can see it self-resolved). NULL = still quarantined.
  resolved_at        TIMESTAMPTZ
);

-- Upsert key: one live row per (conversation, instance).
CREATE UNIQUE INDEX IF NOT EXISTS session_quarantine_conv_instance_unique
  ON session_quarantine (conversation_id, instance_id);

-- Read endpoint groups by teammate and filters open rows.
CREATE INDEX IF NOT EXISTS session_quarantine_teammate_open_idx
  ON session_quarantine (teammate_id)
  WHERE resolved_at IS NULL;

-- RLS — teammate-scoped (the caller sees only their own quarantined sessions),
-- mirroring inbox_item's recipient check. Region-scoped staff/admin can see
-- in-region rows so the same surface can back an admin view later. The read
-- endpoint ALSO filters teammate_id explicitly (defense in depth), exactly like
-- the other /me reads.
ALTER TABLE session_quarantine ENABLE ROW LEVEL SECURITY;

CREATE POLICY session_quarantine_self_scope ON session_quarantine
  FOR ALL
  USING (
    teammate_id::text = current_setting('app.user_teammate_id', true)
    OR (
      region_id::text = current_setting('app.user_region_id', true)
      AND current_setting('app.user_role', true) IN ('manager', 'admin', 'finance', 'global-finops')
    )
    OR current_setting('app.user_role', true) IN ('global-finops', 'admin')
  );
