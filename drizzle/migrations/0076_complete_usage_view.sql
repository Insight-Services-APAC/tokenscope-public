-- 0076: v_complete_usage — the canonical "complete usage" source for the aggregate rollups.
--
-- The aggregate rollups (org-tree, practice, manager/team) historically summed ONLY
-- attribution_record (OTel-emitted). Copilot emits little/no OTel and its real per-user usage
-- lives in reconciliation_record → surfaced per (teammate, day, tool) as unaccounted_usage (the §A
-- gap = API − OTel). So Copilot was invisible in every aggregate while the individual "My usage"
-- page (which already reads attribution + unaccounted) showed it. This view unifies the two so the
-- WHOLE app agrees on one definition of complete usage:
--
--     complete usage = OTel-captured (attribution_record) + the API-minus-OTel gap (unaccounted_usage)
--                    = the provider API truth, per teammate.
--
-- NO DOUBLE-COUNT: unaccounted_usage is the GAP (max(0, API − OTel)), not the full amount, so for a
-- teammate with BOTH OTel and API usage, attribution(OTel) + unaccounted(API−OTel) = API exactly.
-- For a Copilot user with no OTel, attribution=0 + unaccounted=full gross = the real usage.
--
-- Columns are attribution-shaped so the rollups swap `FROM attribution_record ar` →
-- `FROM v_complete_usage ar` with minimal change. The unaccounted lane has no cost_owning_unit_id
-- (NULL — it's not project-CoU spend) and no per-event ts; its day maps to a UTC-MIDNIGHT ts_event
-- so the rollups' `ts_event >= month_start` MTD + `date_trunc('week', ts_event)` filters keep
-- working (the day lands in the same UTC month/week it was reconciled into). security_invoker honours RLS.

CREATE VIEW v_complete_usage
WITH (security_invoker = true) AS
  SELECT
    teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool,
    ts_event, cost_usd, tokens
  FROM attribution_record
  UNION ALL
  SELECT
    teammate_id, region_id, org_unit_id, NULL::uuid AS cost_owning_unit_id, project_id, tool,
    (day::timestamp AT TIME ZONE 'UTC') AS ts_event,   -- the API gap is dated to its day (UTC)
    cost_usd, COALESCE(tokens, 0)::bigint AS tokens
  FROM unaccounted_usage
  WHERE cost_usd > 0;

COMMENT ON VIEW v_complete_usage IS
  'Per-teammate COMPLETE usage = attribution_record (OTel) UNION ALL unaccounted_usage (API−OTel gap). The aggregate rollups read this so Copilot (and Claude API gaps) appear everywhere, blended, no double-count. provider-billing-attribution-model.md §A.';

-- The rollups join the unaccounted lane by org_unit_id (region is clamped via org_unit); the table
-- only had (teammate_id, day) + a project_id partial index, so add the org_unit_id index so the
-- aggregate scans don't seq-scan the unaccounted side.
CREATE INDEX IF NOT EXISTS unaccounted_usage_org_unit_idx ON unaccounted_usage (org_unit_id);
