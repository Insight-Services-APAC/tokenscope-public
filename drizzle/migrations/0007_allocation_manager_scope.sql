-- TokenScope RLS — manager scope for allocation.
--
-- Context: 0002_rls.sql created only `allocation_admin_only`, which
-- restricts the `allocation` table to admin / global-finops. But the
-- allocator editor (Epic 12) admits the `manager` role at the app layer
-- (requireRole(..., 'manager', 'admin', 'global-finops')). That made the
-- app-level gate LESS restrictive than RLS — a violation of the
-- documented invariant "app-level requireRole checks must be at least as
-- restrictive as RLS" (docs/design/data-model.md). With RLS authoritative
-- (Epic 10's non-owner DB role) managers would otherwise be blocked from
-- their own allocations entirely.
--
-- This policy grants a manager scoped visibility: an allocation is in
-- scope iff it is project-scoped and the project's cost_owning_unit path
-- is within the caller's org subtree (app.user_org_path). It mirrors,
-- one-for-one, the app-level predicate in
-- server/auth/allocation-scope.ts. Multiple permissive FOR ALL policies
-- are OR-combined, so admin/global-finops keep full access via
-- allocation_admin_only.
--
-- NOTE: this only takes runtime effect once the app connects under a
-- non-owner DB role (or FORCE ROW LEVEL SECURITY is set). Until then the
-- app-level predicate is the live gate; this keeps the two in lockstep
-- so the boundary doesn't silently flip when the non-owner role lands.

CREATE POLICY allocation_manager_scope ON allocation
  FOR ALL
  USING (
    scope_type = 'project'
    AND EXISTS (
      SELECT 1
      FROM project p
      JOIN org_unit cou ON cou.id = p.cost_owning_unit_id
      WHERE p.id = allocation.scope_id
        AND cou.path <@ current_setting('app.user_org_path', true)::ltree
    )
  );
