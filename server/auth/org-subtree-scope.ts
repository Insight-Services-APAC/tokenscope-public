/*
 * org-subtree-scope — the in-query authorization predicate for resolving an
 * org_unit root in the org-tree rollup (server/api/v1/rollups/org-tree.get.ts).
 *
 * RLS is INERT at runtime (the app connects as the table owner, no FORCE ROW
 * LEVEL SECURITY) so this MUST be embedded in-query; a handler that "relies on
 * RLS" here is a cross-region spend leak. The role split mirrors
 * financeRegionFilter (server/auth/finance-scope.ts) exactly — the same
 * region-scoped-admin contract every admin/* endpoint applies:
 *
 *   - global-finops / platform-admin  → unbounded (platform-admin is mapped to
 *                                        'global-finops' at the GUC layer by
 *                                        withRequestRls, so one clause covers both)
 *   - admin                           → their OWN region, never another
 *   - developer / manager             → their own org subtree (ltree <@)
 *
 * NOTE this deliberately does NOT copy allocation-scope's "admin is unbounded"
 * semantics: that predates the multi-region operating model. For a region-scoped
 * spend view, admin must be hard-bound to their region (see finance-scope.ts).
 */
import { sql, type SQL } from 'drizzle-orm'

/**
 * Returns a boolean SQL predicate restricting an `org_unit` row to the caller's
 * authority. `ref` is the table name or alias the calling query uses for the
 * org_unit row (a code constant, never user input). The referenced row must
 * expose `path` (ltree) and `region_id` (uuid).
 *
 * Reads the per-request GUCs set by withRequestRls / withRlsContext:
 *   - app.user_role       — role split above
 *   - app.user_region_id  — the admin region clamp (NULLIF-guarded so an empty
 *                           GUC for a global-finops caller can't throw on ::uuid)
 *   - app.user_org_path   — the dev/manager subtree (ltree)
 */
export function orgSubtreeScopePredicate(ref: string): SQL {
  const path = sql.raw(`${ref}.path`)
  const regionId = sql.raw(`${ref}.region_id`)
  // Structure matters: every non-global role is region-clamped FIRST, then the path check
  // applies only WITHIN that region. A flat `... OR path <@ org_path` would let an admin (or
  // manager) pass on a colliding path from ANOTHER region, because org_unit paths are only
  // unique per-region — so the region clamp wraps the path check, it does not sit beside it.
  return sql`(
    current_setting('app.user_role', true) = 'global-finops'
    OR (
      ${regionId} = NULLIF(current_setting('app.user_region_id', true), '')::uuid
      AND (
        current_setting('app.user_role', true) = 'admin'
        OR ${path} <@ current_setting('app.user_org_path', true)::ltree
      )
    )
  )`
}

/**
 * SIBLING of {@link orgSubtreeScopePredicate} for the manager rollup
 * (server/api/v1/rollups/manager.get.ts). It is deliberately NOT unified with it:
 *
 *   - shape — this scopes by an org_unit_id COLUMN via an `<col> IN (SELECT id
 *     FROM org_unit WHERE …)` subquery (the manager's tables — teammate, project,
 *     attribution_record — expose `org_unit_id` / `cost_owning_unit_id`, not an
 *     ltree `path`), whereas orgSubtreeScopePredicate filters a row's own `path`.
 *   - value source — this reads the caller's role / region / selected-region from
 *     JS (the resolved `Session` + the request's region pick), NOT the per-request
 *     GUCs, and supports a global-finops "selected region else all" branch the
 *     scope predicate has no equivalent for. (The subtree path is still the GUC,
 *     matching the original hand-rolled clause exactly.)
 *
 * Unifying the two would change one of those axes and so the SQL, so they share
 * the role-split CONTRACT (manager → subtree, admin → own region, global → a
 * selected region else all) but not an implementation.
 *
 * `regionCol` / `subtreeCol` are code-constant column refs (never user input);
 * the referenced columns are a region uuid and an org_unit_id respectively.
 */
export function managerScopePredicate(
  caller: { role: string; regionId: string },
  effectiveRegionId: string | null,
  regionCol: string,
  subtreeCol: string,
): SQL {
  const rc = sql.raw(regionCol)
  const sc = sql.raw(subtreeCol)
  if (caller.role === 'manager') {
    return sql`${sc} IN (SELECT id FROM org_unit WHERE path <@ current_setting('app.user_org_path', true)::ltree AND region_id = ${caller.regionId}::uuid)`
  }
  if (caller.role === 'admin') {
    return sql`${rc} = ${caller.regionId}::uuid`
  }
  // global-finops / platform-admin: a selected region, else all.
  return effectiveRegionId ? sql`${rc} = ${effectiveRegionId}::uuid` : sql`TRUE`
}
