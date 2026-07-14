-- 0072: over_emission — the integrity counterpart of unaccounted_usage (mig 0071).
--
-- Intent: docs/design/provider-billing-attribution-model.md §A + ADR-0010 rule 2 / ADR-0008.
-- The provider API is the source of truth. The rare case: OTel emits MORE than the API
-- corroborates — accidentally OR maliciously (a forged/mis-tagged emission). Example: a
-- day's OTel totals $500 (a $450 session + a $50 session) but the provider API for that
-- (teammate, day) is only $50 → $450 is UNCORROBORATED and must be flagged for the
-- developer to review and either make the call (quarantine the suspect session) or
-- escalate. Symmetric to unaccounted_usage:
--     unaccounted (mig 0071) = max(0, API − OTel)   -- usage OTel MISSED  → taggable
--     over_emission (here)    = max(0, OTel − API)   -- usage OTel OVER-reported → review
--
-- The API has no session ids, so the flag is per (teammate, day, tool); the developer
-- picks WHICH session of that day is the forgery (the system never auto-picks). The
-- `quarantined_conversation_id` records that call; the OTel sum the detector compares
-- EXCLUDES open-quarantined conversations, so once the dev quarantines the bogus session
-- the over-emission recomputes to 0.
--
-- Both providers (since mig 0073): the per-(teammate, day, tool) API USAGE truth comes from
-- the v_teammate_usage_daily view — claude-code from actual_spend, copilot-cli GROSS from
-- reconciliation_record (GitHub ai_credit/usage is per-(user, day)). The detector is
-- tool-agnostic; a tool with no API usage that day simply yields api=0 and is never flagged.

CREATE TABLE over_emission (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teammate_id uuid NOT NULL REFERENCES teammate(id),
  region_id uuid REFERENCES region(id),
  org_unit_id uuid REFERENCES org_unit(id),
  day date NOT NULL,
  tool text NOT NULL,
  otel_usd numeric(14, 6) NOT NULL,   -- OTel emitted that day (excl. already-quarantined)
  api_usd numeric(14, 6) NOT NULL,    -- the provider API truth for that (teammate, day)
  over_usd numeric(14, 6) NOT NULL,   -- max(0, otel − api) = the uncorroborated excess
  -- open = awaiting the dev's call; the rest are the dev's resolution.
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'quarantined', 'accepted', 'escalated')),
  quarantined_conversation_id text,   -- the suspect session the dev flagged (if any)
  resolved_at timestamptz,
  resolved_by uuid REFERENCES teammate(id),
  -- The over_usd at the moment the dev resolved it (accept/escalate/quarantine). A later
  -- recompute that MATERIALLY exceeds this watermark re-opens the flag — so a dev who
  -- vouched for $450 isn't silently bound when a NEW $400 forgery lands the same day.
  resolved_over_usd numeric(14, 6),
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT over_emission_teammate_day_tool_unique UNIQUE (teammate_id, day, tool)
);

COMMENT ON TABLE over_emission IS
  'ADR-0010 rule 2 / ADR-0008: per-(teammate,day,tool) uncorroborated OTel excess (OTel > provider API truth). Flagged for developer review → quarantine the suspect session or escalate. Claude-only until a per-teammate-day Copilot API truth exists.';

CREATE INDEX over_emission_teammate_state_idx ON over_emission (teammate_id, state);

ALTER TABLE over_emission ENABLE ROW LEVEL SECURITY;

CREATE POLICY over_emission_owner ON over_emission
  FOR ALL
  USING (
    teammate_id::text = current_setting('app.user_teammate_id', true)
    OR region_id::text = current_setting('app.user_region_id', true)
    OR current_setting('app.user_role', true) IN ('global-finops', 'admin', 'platform-admin')
  );

-- Org/practice-scoped visibility, symmetric with unaccounted_usage (mig 0071) so a
-- practice admin sees both lanes for their subtree, not just the under one.
CREATE POLICY over_emission_org_scope ON over_emission
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM org_unit ou
      WHERE ou.id = over_emission.org_unit_id
        AND ou.path <@ current_setting('app.user_org_path', true)::ltree
    )
    OR current_setting('app.user_role', true) IN ('global-finops', 'admin', 'platform-admin')
  );
