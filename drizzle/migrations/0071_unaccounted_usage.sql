-- 0071: unaccounted_usage — the per-(teammate, day) reconciliation of the provider
-- API truth against what OTel actually captured.
--
-- Intent: docs/design/provider-billing-attribution-model.md §A (usage completeness).
-- The provider usage API is the COMPLETE truth of a person's spend across every
-- container/client, OTel-enrolled or not. OTel only captures enrolled containers, so
-- it UNDERCOUNTS (a forgotten/un-enrolled container spends real money, emits nothing).
-- Reconciliation closes the gap, per (teammate, day, tool):
--     unaccounted = max(0, API daily total − Σ OTel captured that day)
-- The API has NO session ids — only a daily total — so the delta surfaces as ONE
-- taggable record per (teammate, day, tool), in the same "needs tagging" flow as a
-- session. The developer tags each DAY to a project/activity. Day-by-day, never a
-- single monthly lump. This is ATTRIBUTION (usage completeness), NOT chargeback.
--
-- No double-count: by construction OTel-captured + unaccounted = the API total. A
-- recompute (late OTel arriving for a day) just SHRINKS the delta; the project/activity
-- TAG is preserved across recompute.

CREATE TABLE unaccounted_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teammate_id uuid NOT NULL REFERENCES teammate(id),
  -- Denormalised dimensions (from the teammate) so RLS + region/practice rollups work
  -- the same way they do for attribution_record.
  region_id uuid REFERENCES region(id),
  org_unit_id uuid REFERENCES org_unit(id),
  day date NOT NULL,
  tool text NOT NULL,
  -- The reconciled delta (API − OTel) for this (teammate, day, tool), USD. >= 0.
  cost_usd numeric(14, 6) NOT NULL,
  tokens bigint NOT NULL DEFAULT 0,
  -- The dev's tag. project_id NULL = still "needs tagging".
  project_id uuid REFERENCES project(id),
  activity text,
  source text NOT NULL DEFAULT 'api-reconciled',
  computed_at timestamptz NOT NULL DEFAULT now(),
  tagged_at timestamptz,
  tagged_by uuid REFERENCES teammate(id),
  -- One reconciled record per person-day-tool (the API's finest grain).
  CONSTRAINT unaccounted_usage_teammate_day_tool_unique UNIQUE (teammate_id, day, tool)
);

COMMENT ON TABLE unaccounted_usage IS
  'ADR/provider-billing-attribution-model §A: per-(teammate,day,tool) API-minus-OTel reconciled usage, taggable in the needs-tagging flow. Attribution, not chargeback.';

CREATE INDEX unaccounted_usage_teammate_day_idx ON unaccounted_usage (teammate_id, day);
CREATE INDEX unaccounted_usage_project_idx ON unaccounted_usage (project_id) WHERE project_id IS NOT NULL;

-- RLS: the owning teammate sees their own rows (the personal "My usage" path); region/
-- org-scoped roles + admins see within scope (rollups), mirroring attribution_record.
ALTER TABLE unaccounted_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY unaccounted_usage_owner ON unaccounted_usage
  FOR ALL
  USING (
    teammate_id::text = current_setting('app.user_teammate_id', true)
    OR region_id::text = current_setting('app.user_region_id', true)
    OR current_setting('app.user_role', true) IN ('global-finops', 'admin', 'platform-admin')
  );

CREATE POLICY unaccounted_usage_org_scope ON unaccounted_usage
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM org_unit ou
      WHERE ou.id = unaccounted_usage.org_unit_id
        AND ou.path <@ current_setting('app.user_org_path', true)::ltree
    )
    OR current_setting('app.user_role', true) IN ('global-finops', 'admin', 'platform-admin')
  );
