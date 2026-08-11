-- 0129 — report_access_grant: per-teammate report-access grants replace the
-- three-mode report-visibility policy (mig 0087).
--
-- WHY. The three named modes ('standard' / 'region-admins-see-all' /
-- 'all-admins-see-all') were an org-wide dial: ONE knob decided who got the
-- widened report set, and it could only ever say "every region admin" or
-- "every cost-centre owner", never "this one". An owner who wants to hand ONE
-- finance analyst the whole-company pack without touching every region
-- admin's access had no way to say so. This migration replaces the dial with
-- an explicit, per-teammate, per-permission grant — the cou_owner shape
-- (mig 0048), not the governance-setting shape.
--
-- SHAPE. Two permissions, ('operational', 'finance') — see
-- shared/auth/report-visibility.ts's REPORT_ACCESS_PERMISSIONS, the single
-- source of truth the CHECK below is pinned against (0084-style — a unit
-- test reads this file off disk). A grant is soft-revoked
-- (revoked_at/revoked_by, cou_owner's pattern) and may carry an expiry;
-- ACTIVE = revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()).
-- The partial unique index enforces at most one ACTIVE grant per
-- (teammate, permission) — re-granting after a revoke (or an expiry) is a new
-- row, never an UPDATE, so history survives.
--
-- BACKFILL PRESERVES TODAY'S ACCESS EXACTLY, so upgrading changes nothing
-- until an admin acts. It reads the (about to be dropped) policy mode once
-- and grants BOTH permissions to everyone the OLD FULL_GRANTS matrix would
-- have elevated:
--   - global-finops / platform-admin — already org-wide, every mode.
--   - admin, under 'region-admins-see-all' or 'all-admins-see-all'.
--   - any ACTIVE cou_owner, under 'all-admins-see-all' only (mirrors
--     server/auth/report-scope.ts's computeOwnsCostCentre exactly:
--     co.revoked_at IS NULL AND ou.retired_at IS NULL).
-- Only is_active, non-provisional teammates are eligible — a provisional
-- shadow (mig 0057) has no confirmed identity to grant anything to.
--
-- report_visibility_setting IS DROPPED IN THIS SAME MIGRATION. Every
-- reader/writer moves in the same code change (shared/auth/report-visibility.ts,
-- server/auth/report-scope.ts, server/api/v1/reports/meta.get.ts, the admin
-- report-visibility endpoints, replaced by admin/report-access/*) — 0034-style,
-- no straggler left pointing at a table that no longer exists.
--
-- ROLLBACK. House convention: no down-migration. Recreating
-- report_visibility_setting from report_access_grant would be lossy — the
-- mode dial had no per-teammate memory — so a rollback restores 'standard'
-- (report-scope.ts's own fail-closed default when the table is absent), not
-- whatever mode was set pre-migration.

CREATE TABLE report_access_grant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teammate_id uuid NOT NULL REFERENCES teammate(id),
  permission text NOT NULL CHECK (permission IN ('operational','finance')),
  granted_by uuid REFERENCES teammate(id),   -- NULL = system (migration backfill)
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES teammate(id),
  -- A revocation must carry its actor; an active row must not (cou_owner's shape).
  CONSTRAINT report_access_grant_revoke_shape CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL))
);

CREATE UNIQUE INDEX report_access_grant_active_unique
  ON report_access_grant (teammate_id, permission) WHERE revoked_at IS NULL;

CREATE INDEX report_access_grant_teammate_active_idx
  ON report_access_grant (teammate_id) WHERE revoked_at IS NULL;

-- ─── RLS (mirrors 0048:44-66's cou_owner pattern) ───────────────────────────
-- RLS is INERT at runtime today (the app connects as the table owner, no
-- FORCE ROW LEVEL SECURITY) — the app-layer requireRole gate on
-- server/api/v1/admin/report-access/* is the LIVE path. These policies are
-- defence-in-depth for the day FORCE lands, exactly as 0087's comment said of
-- the report_visibility_setting table this migration retires.
ALTER TABLE report_access_grant ENABLE ROW LEVEL SECURITY;

-- Self: a teammate sees their own grants.
CREATE POLICY report_access_grant_self ON report_access_grant
  FOR SELECT
  USING (teammate_id::text = current_setting('app.user_teammate_id', true));

-- Org-wide admin: global-finops / platform-admin manage every grant. The
-- admin surface is org-wide only (no region arm) — see the endpoints' own
-- requireRole('global-finops') gate (platform-admin passes any requireRole).
CREATE POLICY report_access_grant_admin ON report_access_grant
  FOR ALL
  USING (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin'));

-- ─── Backfill: preserve today's access exactly ──────────────────────────────
WITH policy_mode AS (
  SELECT COALESCE((SELECT mode FROM report_visibility_setting WHERE key = 'policy'), 'standard') AS mode
),
eligible AS (
  SELECT DISTINCT t.id AS teammate_id
  FROM teammate t
  CROSS JOIN policy_mode pm
  WHERE t.is_active AND t.provisional IS NOT TRUE
    AND (
      t.role IN ('global-finops', 'platform-admin')
      OR (pm.mode IN ('region-admins-see-all', 'all-admins-see-all') AND t.role = 'admin')
      OR (pm.mode = 'all-admins-see-all' AND EXISTS (
            SELECT 1 FROM cou_owner co
            JOIN org_unit ou ON ou.id = co.org_unit_id
            WHERE co.teammate_id = t.id AND co.revoked_at IS NULL AND ou.retired_at IS NULL))
    )
)
INSERT INTO report_access_grant (teammate_id, permission, granted_by)
SELECT e.teammate_id, perm, NULL
FROM eligible e
CROSS JOIN unnest(ARRAY['operational', 'finance']) AS perm;

-- ─── report_visibility_setting retires in this same change (0034-style) ────
-- Every reader/writer moved in this migration's companion code change:
-- shared/auth/report-visibility.ts (REPORT_VISIBILITY_MODES/reportGrants →
-- REPORT_ACCESS_PERMISSIONS/effectiveReportGrants), server/auth/report-scope.ts
-- (getReportVisibilityMode → resolveReportPermissions), server/api/v1/reports/
-- meta.get.ts, and the admin/report-visibility.get/put.ts endpoints (deleted,
-- replaced by admin/report-access/*). Nothing reads or writes this table after
-- this migration.
DROP TABLE report_visibility_setting;
