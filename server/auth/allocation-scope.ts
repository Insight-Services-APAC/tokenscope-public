/*
 * allocation-scope — the app-level authorization predicate for the
 * `allocation` table.
 *
 * Design intent (docs/design/user-journeys.md §Screen 4): an allocation
 * is within a manager's authority iff the manager's org_unit.path is an
 * ancestor of (or equal to) the project's cost_owning_unit path. Admins
 * and global-finops are unbounded.
 *
 * This is the LIVE authorization gate. RLS (allocation_admin_only +
 * allocation_manager_scope, migration 0007) mirrors the same predicate
 * but is inert at runtime until Epic 10's non-owner DB role lands — the
 * app connects as the table owner, which bypasses RLS unless FORCE ROW
 * LEVEL SECURITY is set. Until then, every allocation handler MUST embed
 * this predicate; do not rely on RLS as the scope boundary.
 *
 * Used by the allocation list / detail / patch / topups endpoints so the
 * four queries cannot diverge — a divergence here is a privilege-
 * escalation bug, so it lives in one place.
 */
import { sql, type SQL } from 'drizzle-orm'

/**
 * Returns a boolean SQL predicate restricting an `allocation` row to the
 * caller's authority. `tableRef` is the table name or alias the calling
 * query uses for the allocation row (e.g. `'a'` for `allocation a`, or
 * `'allocation'` for an unaliased `FROM allocation`). It is a code
 * constant, never user input.
 *
 * Reads the per-request GUCs set by withRequestRls / withRlsContext:
 *   - app.user_role     — bypass for admin / global-finops
 *   - app.user_org_path — the caller's org subtree (ltree)
 */
export function allocationScopePredicate(tableRef: string): SQL {
  const scopeId = sql.raw(`${tableRef}.scope_id`)
  const scopeType = sql.raw(`${tableRef}.scope_type`)
  return sql`(
    current_setting('app.user_role', true) IN ('admin', 'global-finops')
    OR EXISTS (
      SELECT 1
      FROM project p
      JOIN org_unit cou ON cou.id = p.cost_owning_unit_id
      WHERE p.id = ${scopeId}
        AND ${scopeType} = 'project'
        AND cou.path <@ current_setting('app.user_org_path', true)::ltree
    )
  )`
}
