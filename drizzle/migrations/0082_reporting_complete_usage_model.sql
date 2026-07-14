-- 0082: reporting-consolidation Wave 1 primitive — extend v_complete_usage with
-- (model, token_type), add month-scan indexes, and fold the quarantined-telemetry
-- exclusion into the aggregate lane.
--
-- Spec: docs/design/reporting-consolidation/00-build-design.md §4 ("Required
-- migration") + §5; owner ratification docs/design/reporting-consolidation/
-- 02-owner-decisions.md ("Quarantined-telemetry exclusion added to the primitives
-- migration + lane-firewall tests"). The build design numbers this "0079"; the next
-- free number at build time is 0082 (0078 = provider_enterprise github_app_id).
--
-- THREE additions, one idempotent view recreate:
--
-- 1. model / token_type drivers. The reporting "drivers" panel ranks spend by model.
--    The attribution branch carries the real per-record model + token_type. The
--    unaccounted branch (the API−OTel gap, mig 0071) has NEITHER — the provider usage
--    API returns a per-(teammate, day, tool) total with no model split — so it emits
--    model = NULL and token_type = 'unknown'. The NULL model renders as one explicit
--    "unattributed" bar so the model drivers still SUM BACK to the headline (design §4:
--    "NULL renders as explicit unattributed bar and model drivers sum back").
--
-- 2. Quarantined-telemetry exclusion (owner decision; gate-warning fold-in). A
--    conversation the developer CONFIRMED a forgery (over-emission →
--    session_quarantine reason = 'api-uncorroborated', still open) is already excluded
--    from the personal "My usage" lane (server/utils/me-queries.ts:184-187, 209-212,
--    321-324). The aggregate lane read raw attribution_record and did NOT exclude it,
--    so a confirmed forgery still inflated every rollup. This recreate folds the SAME
--    NOT EXISTS in so the aggregate lane and the personal lane agree on one definition
--    of usage. Only 'api-uncorroborated' (the dev-confirmed forgery) is excluded — the
--    informational 'no-covering-heartbeat' coverage flag is NOT a usage exclusion,
--    matching me-queries exactly. security_invoker keeps the subquery under the
--    caller's RLS, so a viewer who cannot see a quarantine row simply does not exclude
--    it (fail-open to today's behaviour — never a new leak).
--
-- 3. Month-scan indexes. Reporting scans a MONTH across ALL teammates (not one
--    teammate's rows), which the existing teammate-leading composites
--    (actual_spend(teammate_id, date), unaccounted_usage(teammate_id, day)) cannot
--    prune. Add date/day-leading indexes: actual_spend(date), unaccounted_usage(day).
--
-- CREATE OR REPLACE preserves the existing 9 output columns in order and APPENDS
-- (model, token_type) — the only shape change CREATE OR REPLACE VIEW permits — so
-- every existing consumer (org-tree / manager / practice rollups, which select named
-- columns) is untouched.

CREATE OR REPLACE VIEW v_complete_usage
WITH (security_invoker = true) AS
  SELECT
    ar.teammate_id, ar.region_id, ar.org_unit_id, ar.cost_owning_unit_id, ar.project_id, ar.tool,
    ar.ts_event, ar.cost_usd, ar.tokens,
    ar.model,                       -- real per-record model (drivers axis)
    ar.token_type                   -- real per-record token type
  FROM attribution_record ar
  WHERE NOT EXISTS (
    -- §A integrity: drop dev-confirmed forgeries (mirrors me-queries.ts). resolved_at
    -- NULL = still-open quarantine; reason 'api-uncorroborated' = the dev said "not mine".
    SELECT 1 FROM session_quarantine sq
     WHERE sq.teammate_id = ar.teammate_id
       AND sq.conversation_id = ar.claude_session_id
       AND sq.resolved_at IS NULL
       AND sq.reason = 'api-uncorroborated'
  )
  UNION ALL
  SELECT
    uu.teammate_id, uu.region_id, uu.org_unit_id, NULL::uuid AS cost_owning_unit_id, uu.project_id, uu.tool,
    (uu.day::timestamp AT TIME ZONE 'UTC') AS ts_event,   -- the API gap is dated to its day (UTC)
    uu.cost_usd, COALESCE(uu.tokens, 0)::bigint AS tokens,
    NULL::text AS model,            -- API gap has no model split → explicit "unattributed" bar
    'unknown'::text AS token_type   -- and no token-type dimension
  FROM unaccounted_usage uu
  WHERE uu.cost_usd > 0;

COMMENT ON VIEW v_complete_usage IS
  'Per-teammate COMPLETE usage = attribution_record (OTel, minus dev-confirmed forgeries) UNION ALL unaccounted_usage (API−OTel gap). Extended in 0082 with (model, token_type): attribution carries real values, the API gap carries NULL model / ''unknown'' token_type so model drivers sum back through an explicit unattributed bucket. provider-billing-attribution-model.md §A.';

-- Reporting scans a MONTH across all teammates → date/day-leading indexes.
CREATE INDEX IF NOT EXISTS actual_spend_date_idx ON actual_spend (date);
CREATE INDEX IF NOT EXISTS unaccounted_usage_day_idx ON unaccounted_usage (day);
