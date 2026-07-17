-- 0087: report_visibility_setting — the single admin-configurable knob controlling
-- who sees which /reports SCOPES (task #19). One easy-to-understand mode on top of
-- the comprehensive RBAC; the enforcement lives in shared/auth/report-visibility.ts
-- (reportGrants) + server/auth/report-scope.ts. READ-ONLY blast radius: nothing here
-- widens a write path — the mode only loosens report READ scopes.
--
-- WHY A TABLE, NOT governance_setting: that table is deliberately NUMERIC-only
-- ("a future non-numeric dial earns its own column, not a type erasure" — mig 0049).
-- This is a single enum-valued policy with its own updated_by/at audit trail, so it
-- earns its own single-row table (the same rationale mig 0083 used for the
-- directory-exclusion policy).
--
-- SINGLE LOGICAL ROW: `key` is a PK pinned to 'policy' by CHECK, so there can only
-- ever be one row. `mode` is CHECK-pinned to the three literals — a unit test pins
-- these literals to the TS module (REPORT_VISIBILITY_MODES), 0084-style, so the DB
-- and the code can never drift.
--
-- NO SEED ROW ON PURPOSE: an ABSENT row ⇒ 'standard' (getReportVisibilityMode
-- fail-closes). So on upgrade the behaviour is byte-identical to today until an admin
-- explicitly picks a looser mode, and a rollback that drops the table degrades to
-- 'standard' rather than erroring (sg-L11).

CREATE TABLE report_visibility_setting (
  key        TEXT PRIMARY KEY DEFAULT 'policy' CHECK (key = 'policy'),
  mode       TEXT NOT NULL CHECK (mode IN ('standard', 'region-admins-see-all', 'all-admins-see-all')),
  updated_by UUID REFERENCES teammate(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS mirrors governance_setting (mig 0049) / directory_exclusion_pattern (mig 0083):
-- the policy value is not sensitive — readable by any authenticated user (every report
-- request reads it to resolve grants); writes are admin-shaped. UNLIKE those two, the
-- WRITE is RE-NARROWED to platform-admin / global-finops ONLY (a region admin must NOT
-- be able to grant themselves cross-region visibility — the #121 write pattern). NOTE
-- RLS is inert at runtime today (owner connection); the app-layer requireRole gate on
-- the admin PUT is the live path.
ALTER TABLE report_visibility_setting ENABLE ROW LEVEL SECURITY;

CREATE POLICY report_visibility_setting_read ON report_visibility_setting
  FOR SELECT
  USING (true);

CREATE POLICY report_visibility_setting_write ON report_visibility_setting
  FOR ALL
  USING (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin'));
