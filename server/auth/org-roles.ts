/*
 * org-roles — capability gates derived from RELATIONSHIP rows, not
 * role-enum entries (J1, mig 0048):
 *
 *   - CC ownership: an active cou_owner row. The P&L owner is typically
 *     2-3 levels removed from developers in the org chart, so this is an
 *     explicit assignment — a teammate of ANY role can be a CC owner.
 *   - Project management: project_assignment.role = 'manager' with a
 *     currently-effective range. A PM may manage their project's budget
 *     top-ups regardless of their org role.
 *
 * Like assertProjectScope, these are the LIVE gates — RLS is inert at
 * runtime (owner DB connection) until Epic 10's non-owner role lands,
 * so every CC-owner / PM read path must call these app-side.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

type Db = PostgresJsDatabase<Record<string, unknown>>

/** Active cost-owning units the teammate owns (empty array = not an owner). */
export async function getOwnedCostCentreIds(db: Db, teammateId: string): Promise<string[]> {
  const rows = await db.execute<{ org_unit_id: string }>(sql`
    SELECT org_unit_id::text AS org_unit_id
    FROM cou_owner
    WHERE teammate_id = ${teammateId}::uuid AND revoked_at IS NULL
  `)
  return [...rows].map((r) => r.org_unit_id)
}

/** True when the teammate holds a currently-effective PM assignment on the project. */
export async function isProjectManager(
  db: Db,
  teammateId: string,
  projectId: string,
): Promise<boolean> {
  const rows = await db.execute<{ ok: boolean }>(sql`
    SELECT TRUE AS ok
    FROM project_assignment
    WHERE project_id = ${projectId}::uuid
      AND teammate_id = ${teammateId}::uuid
      AND role = 'manager'
      AND effective @> now()
    LIMIT 1
  `)
  return [...rows].length > 0
}

/*
 * NOTE (review R1-F4): an earlier requireProjectBudgetAuthority helper
 * was removed — it admitted 'admin' without region scope, and handlers
 * need the project row anyway, so the dual gate is inlined at each call
 * site (allocations [id].get / topups.post) where the scope predicate
 * can be applied correctly. Don't reintroduce a role-only shortcut here.
 */
