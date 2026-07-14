-- 0048 — org-journey foundation: explicit CC ownership + project-assignment roles
--
-- cou_owner: the P&L (cost-owning unit) owner is typically 2-3 levels removed
-- from the developers in the org chart, so ownership CANNOT be derived from
-- LTREE adjacency or teammate.org_unit_id — it is an explicit assignment.
-- 1..n owners per CoU. Soft-revoke (revoked_at) so ownership history survives
-- for audit; active ownership = revoked_at IS NULL. The org_unit must be a
-- cost-owning unit — cross-table, so enforced at the API layer (and re-checked
-- by the assignment endpoint), not by a CHECK.

CREATE TABLE cou_owner (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_unit_id uuid NOT NULL REFERENCES org_unit(id),
  teammate_id uuid NOT NULL REFERENCES teammate(id),
  assigned_by uuid REFERENCES teammate(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES teammate(id),
  -- A revocation must carry its actor; an active row must not.
  CONSTRAINT cou_owner_revoke_shape CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL)
    OR (revoked_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX cou_owner_active_unique
  ON cou_owner (org_unit_id, teammate_id)
  WHERE revoked_at IS NULL;

CREATE INDEX cou_owner_teammate_active_idx
  ON cou_owner (teammate_id)
  WHERE revoked_at IS NULL;

-- project_assignment.role — 'manager' (PM: may manage the project's budget
-- top-ups, J2) | 'member'. All existing rows become members; PMs are
-- designated explicitly.
ALTER TABLE project_assignment
  ADD COLUMN role text NOT NULL DEFAULT 'member';
ALTER TABLE project_assignment
  ADD CONSTRAINT project_assignment_role_check CHECK (role IN ('manager', 'member'));

-- ─── RLS ──────────────────────────────────────────────────────────────

ALTER TABLE cou_owner ENABLE ROW LEVEL SECURITY;

-- Self: a teammate sees their own ownership rows (drives "My cost centres").
CREATE POLICY cou_owner_self ON cou_owner
  FOR SELECT
  USING (teammate_id::text = current_setting('app.user_teammate_id', true));

-- Region admins govern ownership inside their region; global roles see all.
-- (platform-admin included here; the 0002-era lists predate the role — known
-- gap, tracked in docs/build/dogfood-followups.md §6.)
CREATE POLICY cou_owner_admin ON cou_owner
  FOR ALL
  USING (
    current_setting('app.user_role', true) IN ('global-finops', 'platform-admin')
    OR (
      current_setting('app.user_role', true) = 'admin'
      AND EXISTS (
        SELECT 1 FROM org_unit ou
        WHERE ou.id = cou_owner.org_unit_id
          AND ou.region_id::text = current_setting('app.user_region_id', true)
      )
    )
  );

-- ─── CC-owner read ladder (the J3 view's three read paths) ────────────

-- A project whose lead CC the caller owns…
CREATE POLICY project_cou_owner ON project
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM cou_owner co
      WHERE co.org_unit_id = project.cost_owning_unit_id
        AND co.teammate_id::text = current_setting('app.user_teammate_id', true)
        AND co.revoked_at IS NULL
    )
  );

-- …its project-scoped spend aggregates…
CREATE POLICY attribution_aggregate_cou_owner ON attribution_aggregate
  FOR SELECT
  USING (
    scope_type = 'project'
    AND EXISTS (
      SELECT 1
      FROM project p
      JOIN cou_owner co ON co.org_unit_id = p.cost_owning_unit_id
      WHERE p.id = attribution_aggregate.scope_id
        AND co.teammate_id::text = current_setting('app.user_teammate_id', true)
        AND co.revoked_at IS NULL
    )
  );

-- …and its allocations (budget vs burn).
CREATE POLICY allocation_cou_owner ON allocation
  FOR SELECT
  USING (
    scope_type = 'project'
    AND EXISTS (
      SELECT 1
      FROM project p
      JOIN cou_owner co ON co.org_unit_id = p.cost_owning_unit_id
      WHERE p.id = allocation.scope_id
        AND co.teammate_id::text = current_setting('app.user_teammate_id', true)
        AND co.revoked_at IS NULL
    )
  );

-- NOTE: project_assignment (and teammate) carry NO RLS today — they are
-- app-layer scoped, and several existing policies subquery project_assignment,
-- so enabling RLS on it has a blast radius beyond this migration. Member
-- rosters for CC owners are therefore served by an API endpoint that gates on
-- cou_owner app-side (J3), consistent with the current posture.
