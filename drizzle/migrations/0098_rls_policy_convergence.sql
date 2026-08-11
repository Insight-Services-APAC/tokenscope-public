-- 0098: RLS policy convergence — S11 "Database trust layer".
--
-- Closes: infra-ci-tooling:mitm:0001 (TLS half lives in
-- infra/modules/keyvault-secrets.bicep + drizzle/connect.ts, not here),
-- global:config:0001, global:config:asvs-0003, global:config:asvs-0015, plus the
-- triage-found defects "admin sits in ~20 region-bypass clauses" and "38 of 58
-- tables have no policy" (this migration adds 3 of the highest-value 38: org_unit,
-- teammate, oauth_token — the remaining 35 are UF-1).
--
-- IMPORTANT — what this migration deliberately does NOT do: it does not set FORCE
-- ROW LEVEL SECURITY and does not provision a non-owner DB role. The app connects
-- as the table owner, and table owners bypass RLS unless FORCE is set — so every
-- policy below is INERT at runtime today. That is precisely what makes this
-- migration safe to ship: 47 of 173 API handlers never set the RLS GUCs and 0 of 19
-- RLS-touching workers do, so flipping enforcement on now would make those
-- handlers' SELECTs return zero rows silently (current_setting(...) evaluates NULL)
-- and their INSERTs error. Enforcement is UF-1, gated on universal GUC coverage.
--
-- Three things happen here, all correctness-only (no behaviour change until UF-1):
--
--   (b) ROLE-LIST CONVERGENCE. `admin` is a REGION-scoped role (rbac.ts:44,
--       requireRegionScope) — it must never appear in an UNSCOPED bypass
--       disjunct that grants cross-region reach. Migrations 0002, 0032, 0046,
--       0049, 0055, 0071, 0072 wrote `IN ('global-finops', 'admin')` (or the
--       ARRAY[...] equivalent) for that bypass; newer migrations (0048, 0083,
--       0087) already use the correct `('global-finops', 'platform-admin')`
--       list. This ALTER POLICYs the ~20 stale clauses to match. Two
--       deliberate NON-changes: 0032's `session_quarantine_self_scope` keeps
--       'admin' in its OWN region-AND-scoped arm (region_id = ... AND role IN
--       (...)) — that arm is already correctly bounded, only its final
--       unconditional bypass arm changes. `directory_exclusion_pattern_write`
--       (0083) is UNTOUCHED: that table has no region_id column at all, so
--       'admin' there is not a region-bypass — it is a different, narrower
--       question this story does not own (flagged separately).
--
--   (c) PRIORITY-TABLE COVERAGE. New policies for org_unit, teammate, and
--       oauth_token — the three uncovered tables other stories in this sprint
--       lean on. Every policy cites the app-level predicate it mirrors, per
--       0007_allocation_manager_scope.sql:16-18's existing convention.
--
--   (d) STALE-PREDICATE CONVERGENCE. Five policies hard-code the PRE-S3
--       `path <@ current_setting('app.user_org_path')` check with no gate on
--       whether the caller's OWN placement is a genuine subtree home rather
--       than the region root (which makes `<@` true for every unit in the
--       region — S3's whole point). ALTER POLICY adds the same
--       placed_below_region_root() gate S3 added at the app layer
--       (server/auth/org-subtree-scope.ts::placedBelowRegionRootPredicate())
--       so the DB layer stops encoding a boundary the app layer no longer
--       believes. Without this the sprint would end with two definitions of
--       the boundary — the exact drift 0007:16-18 exists to prevent.

-- ─── Shared helper — S3-aware "genuine leaf" gate ──────────────────────────────
-- Mirrors server/auth/org-subtree-scope.ts::placedBelowRegionRootPredicate()
-- exactly: same three-way structural+naming conjunction (not `unit_type <>
-- 'holding'` alone — misses a non-holding region root; not `code <> 'default'`
-- alone — fails open the moment a region's root isn't literally 'default'; the
-- STRUCTURAL `parent_id IS NOT NULL` is load-bearing, `code <> 'default'` is
-- defence-in-depth), same GUCs, same NULLIF guard so an empty
-- app.user_region_id can't throw on the ::uuid cast. See that file for the full
-- rationale — do not re-derive it here.
--
-- SECURITY DEFINER is not a privilege grant, it is the standard fix for the
-- self-referential-RLS recursion this predicate would otherwise cause when used
-- inside org_unit's OWN policy (org_unit_scope, below): a non-owner querying
-- org_unit would re-trigger org_unit's policy on this function's inner org_unit
-- lookup, which calls the function again -> "infinite recursion detected in
-- policy for relation org_unit". A SECURITY DEFINER function runs ITS queries as
-- the function's OWNER (whoever runs this migration — the same role that owns
-- every table here), and the owner bypasses RLS because FORCE ROW LEVEL SECURITY
-- is not set — that breaks the cycle. It has zero runtime effect until a
-- non-owner role exists (UF-1); it only changes how the recursion is avoided
-- once one does, never the answer. `STABLE` (not `IMMUTABLE`): the GUCs it reads
-- can change within a transaction.
CREATE OR REPLACE FUNCTION placed_below_region_root() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_unit self
    WHERE self.region_id = NULLIF(current_setting('app.user_region_id', true), '')::uuid
      AND self.path = current_setting('app.user_org_path', true)::ltree
      AND self.unit_type <> 'holding'
      AND self.parent_id IS NOT NULL
      AND self.code <> 'default'
  );
$$;

-- ─── (b) + (d): attribution_record — current shape is 0055's (0002's table was ──
-- dropped/recreated during partitioning; only the live 0055 definition can be
-- ALTER POLICY'd). org_scope also gets the (d) predicate fix.
ALTER POLICY attribution_record_region_scope ON attribution_record
  USING (
    (region_id)::text = current_setting('app.user_region_id', true)
    OR current_setting('app.user_role', true) = ANY (ARRAY['global-finops', 'platform-admin'])
  );

ALTER POLICY attribution_record_org_scope ON attribution_record
  USING (
    (
      EXISTS (
        SELECT 1 FROM org_unit ou
        WHERE ou.id = attribution_record.org_unit_id
          AND ou.path <@ current_setting('app.user_org_path', true)::ltree
      )
      AND placed_below_region_root()
    )
    OR current_setting('app.user_role', true) = ANY (ARRAY['global-finops', 'platform-admin'])
  );

-- ─── (b): the remaining 0002-era admin-only / region-scope policies ────────────
ALTER POLICY attribution_aggregate_admin_only ON attribution_aggregate
  USING (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin'));

-- session_attestation was renamed to instance_attestation in migration 0019,
-- which also renamed this policy (session_attestation_region_scope ->
-- instance_attestation_region_scope) — target the LIVE names, not 0002's.
ALTER POLICY instance_attestation_region_scope ON instance_attestation
  USING (
    region_id::text = current_setting('app.user_region_id', true)
    OR current_setting('app.user_role', true) IN ('global-finops', 'platform-admin')
  );

ALTER POLICY allocation_admin_only ON allocation
  USING (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin'));

ALTER POLICY limit_policy_admin_only ON limit_policy
  USING (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin'));

ALTER POLICY tier_assignment_admin_only ON tier_assignment
  USING (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin'));

ALTER POLICY spill_record_admin_only ON spill_record
  USING (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin'));

ALTER POLICY project_region_scope ON project
  USING (
    region_id::text = current_setting('app.user_region_id', true)
    OR current_setting('app.user_role', true) IN ('global-finops', 'platform-admin')
  );

ALTER POLICY repo_project_map_admin_only ON repo_project_map
  USING (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin'));

ALTER POLICY audit_event_admin_only ON audit_event
  USING (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin'));

ALTER POLICY inbox_item_self ON inbox_item
  USING (
    recipient_teammate_id::text = current_setting('app.user_teammate_id', true)
    OR current_setting('app.user_role', true) IN ('global-finops', 'platform-admin')
  );

-- ─── (d): allocation_manager_scope (0007) — predicate-only, no role list to fix ─
ALTER POLICY allocation_manager_scope ON allocation
  USING (
    scope_type = 'project'
    AND EXISTS (
      SELECT 1
      FROM project p
      JOIN org_unit cou ON cou.id = p.cost_owning_unit_id
      WHERE p.id = allocation.scope_id
        AND cou.path <@ current_setting('app.user_org_path', true)::ltree
    )
    AND placed_below_region_root()
  );

-- ─── (b): session_quarantine (0032) — ONLY the unconditional bypass arm changes;──
-- the region-AND-scoped 'admin' in the middle arm is already correctly bounded
-- and stays exactly as it was.
ALTER POLICY session_quarantine_self_scope ON session_quarantine
  USING (
    teammate_id::text = current_setting('app.user_teammate_id', true)
    OR (
      region_id::text = current_setting('app.user_region_id', true)
      AND current_setting('app.user_role', true) IN ('manager', 'admin', 'finance', 'global-finops')
    )
    OR current_setting('app.user_role', true) IN ('global-finops', 'platform-admin')
  );

-- ─── (b): insight_ack (0046) ────────────────────────────────────────────────────
ALTER POLICY insight_ack_admin ON insight_ack
  USING (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin'));

-- ─── (b): governance_setting (0049) — drop 'admin', keep the rest ─────────────
ALTER POLICY governance_setting_write ON governance_setting
  USING (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin'));

-- ─── (b): usage_signal_record (0065) ────────────────────────────────────────────
ALTER POLICY usage_signal_record_admin ON usage_signal_record
  USING (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin'));

-- ─── (b) + (d): unaccounted_usage (0071) ────────────────────────────────────────
ALTER POLICY unaccounted_usage_owner ON unaccounted_usage
  USING (
    teammate_id::text = current_setting('app.user_teammate_id', true)
    OR region_id::text = current_setting('app.user_region_id', true)
    OR current_setting('app.user_role', true) IN ('global-finops', 'platform-admin')
  );

ALTER POLICY unaccounted_usage_org_scope ON unaccounted_usage
  USING (
    (
      EXISTS (
        SELECT 1 FROM org_unit ou
        WHERE ou.id = unaccounted_usage.org_unit_id
          AND ou.path <@ current_setting('app.user_org_path', true)::ltree
      )
      AND placed_below_region_root()
    )
    OR current_setting('app.user_role', true) IN ('global-finops', 'platform-admin')
  );

-- ─── (b) + (d): over_emission (0072) ────────────────────────────────────────────
ALTER POLICY over_emission_owner ON over_emission
  USING (
    teammate_id::text = current_setting('app.user_teammate_id', true)
    OR region_id::text = current_setting('app.user_region_id', true)
    OR current_setting('app.user_role', true) IN ('global-finops', 'platform-admin')
  );

ALTER POLICY over_emission_org_scope ON over_emission
  USING (
    (
      EXISTS (
        SELECT 1 FROM org_unit ou
        WHERE ou.id = over_emission.org_unit_id
          AND ou.path <@ current_setting('app.user_org_path', true)::ltree
      )
      AND placed_below_region_root()
    )
    OR current_setting('app.user_role', true) IN ('global-finops', 'platform-admin')
  );

-- ─── (c): org_unit — mirrors server/auth/org-subtree-scope.ts::orgSubtreeScopePredicate() ──
-- exactly: global-finops unbounded; admin (region-scoped, rbac.ts:44) bound to
-- their OWN region only; developer/manager to their own org subtree, gated by
-- placed_below_region_root() so a caller whose OWN placement IS the region root
-- does not degenerate "subtree" into "the whole region".
ALTER TABLE org_unit ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_unit_scope ON org_unit
  FOR ALL
  USING (
    current_setting('app.user_role', true) = 'global-finops'
    OR (
      region_id = NULLIF(current_setting('app.user_region_id', true), '')::uuid
      AND (
        current_setting('app.user_role', true) = 'admin'
        OR (
          path <@ current_setting('app.user_org_path', true)::ltree
          AND placed_below_region_root()
        )
      )
    )
  );

-- ─── (c): teammate — same role-split CONTRACT as org_unit above, adapted to ────
-- teammate's column shape (org_unit_id, not its own path — the same adaptation
-- managerScopePredicate() makes for the manager rollup in org-subtree-scope.ts).
-- A caller always sees their OWN row regardless of placement (mirrors
-- inbox_item_self's self-clause) — otherwise a teammate placed exactly at the
-- region root could not read their own profile row under the strict subtree gate.
ALTER TABLE teammate ENABLE ROW LEVEL SECURITY;

CREATE POLICY teammate_scope ON teammate
  FOR ALL
  USING (
    current_setting('app.user_role', true) = 'global-finops'
    OR id::text = current_setting('app.user_teammate_id', true)
    OR (
      region_id = NULLIF(current_setting('app.user_region_id', true), '')::uuid
      AND (
        current_setting('app.user_role', true) = 'admin'
        OR (
          org_unit_id IN (
            SELECT id FROM org_unit
            WHERE path <@ current_setting('app.user_org_path', true)::ltree
              AND region_id = NULLIF(current_setting('app.user_region_id', true), '')::uuid
          )
          AND placed_below_region_root()
        )
      )
    )
  );

-- ─── (c): oauth_token — no region/org columns of its own; scope via the bound ──
-- teammate. Mirrors the two live authorization paths: requireOAuthBearer /
-- refreshAccessToken's self-bound flows (server/auth/oauth-bearer.ts), and the
-- admin-users revoke-sessions cascade
-- (server/api/v1/admin/users/[id]/revoke-sessions.post.ts), which is gated by
-- requireRegionScope — a region admin manages tokens only for teammates in THEIR
-- region; global-finops/platform-admin are unbounded. This is a NEW policy, so it
-- carries the CORRECT role list from the start ('platform-admin', never a bare
-- 'admin' in the unconditional arm) — it never had the (b) bug to converge.
ALTER TABLE oauth_token ENABLE ROW LEVEL SECURITY;

CREATE POLICY oauth_token_scope ON oauth_token
  FOR ALL
  USING (
    teammate_id::text = current_setting('app.user_teammate_id', true)
    OR current_setting('app.user_role', true) IN ('global-finops', 'platform-admin')
    OR (
      current_setting('app.user_role', true) = 'admin'
      AND EXISTS (
        SELECT 1 FROM teammate t
        WHERE t.id = oauth_token.teammate_id
          AND t.region_id = NULLIF(current_setting('app.user_region_id', true), '')::uuid
      )
    )
  );
