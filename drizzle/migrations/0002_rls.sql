-- TokenScope RLS — region + org_unit LTREE scope.
--
-- Per docs/design/data-model.md §Row-Level Security policies. App-level
-- requireRole stays as defence-in-depth; RLS is the DB-side ground truth.
--
-- Connection-pool checkout hook sets the three session GUCs:
--   SET LOCAL app.user_region_id = '<uuid>';
--   SET LOCAL app.user_org_path  = '<ltree path>';
--   SET LOCAL app.user_role      = '<role>';
--
-- 'global-finops' and 'admin' bypass region/org scopes per the policy
-- predicates.

-- ─── attribution_record ───────────────────────────────────────────────
ALTER TABLE attribution_record ENABLE ROW LEVEL SECURITY;

CREATE POLICY attribution_record_region_scope ON attribution_record
  FOR ALL
  USING (
    region_id::text = current_setting('app.user_region_id', true)
    OR current_setting('app.user_role', true) IN ('global-finops', 'admin')
  );

CREATE POLICY attribution_record_org_scope ON attribution_record
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM org_unit ou
      WHERE ou.id = attribution_record.org_unit_id
        AND ou.path <@ current_setting('app.user_org_path', true)::ltree
    )
    OR current_setting('app.user_role', true) IN ('global-finops', 'admin')
  );

-- ─── attribution_aggregate ────────────────────────────────────────────
ALTER TABLE attribution_aggregate ENABLE ROW LEVEL SECURITY;

-- Aggregates do not carry region_id directly — admins/global-finops see
-- all; everyone else sees their scope's aggregates via the scope_id.
-- Conservative: only admin/global-finops by default until §scope_id
-- bridging is implemented (Epic 8 wires it).
CREATE POLICY attribution_aggregate_admin_only ON attribution_aggregate
  FOR ALL
  USING (current_setting('app.user_role', true) IN ('global-finops', 'admin'));

-- ─── session_attestation ──────────────────────────────────────────────
ALTER TABLE session_attestation ENABLE ROW LEVEL SECURITY;

CREATE POLICY session_attestation_region_scope ON session_attestation
  FOR ALL
  USING (
    region_id::text = current_setting('app.user_region_id', true)
    OR current_setting('app.user_role', true) IN ('global-finops', 'admin')
  );

-- ─── allocation (governance state) ────────────────────────────────────
ALTER TABLE allocation ENABLE ROW LEVEL SECURITY;

-- Allocations are scope_id-keyed; admin/global-finops see all.
-- Manager scope visibility lands at Epic 3 when org-path lookups join.
CREATE POLICY allocation_admin_only ON allocation
  FOR ALL
  USING (current_setting('app.user_role', true) IN ('global-finops', 'admin'));

-- ─── limit_policy, tier_assignment, burst_request (future) ────────────
ALTER TABLE limit_policy ENABLE ROW LEVEL SECURITY;
CREATE POLICY limit_policy_admin_only ON limit_policy
  FOR ALL
  USING (current_setting('app.user_role', true) IN ('global-finops', 'admin'));

ALTER TABLE tier_assignment ENABLE ROW LEVEL SECURITY;
CREATE POLICY tier_assignment_admin_only ON tier_assignment
  FOR ALL
  USING (current_setting('app.user_role', true) IN ('global-finops', 'admin'));

-- ─── spill_record ─────────────────────────────────────────────────────
ALTER TABLE spill_record ENABLE ROW LEVEL SECURITY;
CREATE POLICY spill_record_admin_only ON spill_record
  FOR ALL
  USING (current_setting('app.user_role', true) IN ('global-finops', 'admin'));

-- ─── project, repo_project_map ────────────────────────────────────────
ALTER TABLE project ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_region_scope ON project
  FOR ALL
  USING (
    region_id::text = current_setting('app.user_region_id', true)
    OR current_setting('app.user_role', true) IN ('global-finops', 'admin')
  );

ALTER TABLE repo_project_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY repo_project_map_admin_only ON repo_project_map
  FOR ALL
  USING (current_setting('app.user_role', true) IN ('global-finops', 'admin'));

-- ─── audit_event — read-only by default; admin-only for full ──────────
ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_event_admin_only ON audit_event
  FOR ALL
  USING (current_setting('app.user_role', true) IN ('global-finops', 'admin'));

-- ─── inbox_item ───────────────────────────────────────────────────────
-- Per-recipient access — every dev sees only their own inbox.
-- Connection hook should set app.user_teammate_id for the recipient check.
ALTER TABLE inbox_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY inbox_item_self ON inbox_item
  FOR ALL
  USING (
    recipient_teammate_id::text = current_setting('app.user_teammate_id', true)
    OR current_setting('app.user_role', true) IN ('global-finops', 'admin')
  );
