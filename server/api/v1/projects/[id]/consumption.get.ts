/*
 * GET /api/v1/projects/{id}/consumption — month-to-date consumption
 * total for a project, irrespective of the caller's assignment.
 *
 * Used by the allocator editor's ConsumptionCard so managers viewing
 * a project they aren't assigned to still see real numbers (rather
 * than $0 from a /me-scoped fetch).
 *
 * Scope: managers see consumption only for projects whose
 * cost_owning_unit is within their org subtree (app.user_org_path); a
 * region `admin` is bounded to the project's region via
 * requireRegionScope (API-1 — the same requireRegionScope pattern the
 * admin/* endpoints apply); global-finops /
 * platform-admin are unbounded. This app-level clamp is the live gate —
 * RLS is bypassed at runtime (owner DB connection) until Epic 10's
 * non-owner role lands, so we cannot lean on the attribution_record
 * policy here. Same rationale as server/auth/allocation-scope.ts. An
 * out-of-subtree project id returns 0 (no row) for a manager, never
 * another org's sum.
 */
import { defineEventHandler, createError } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole, requireRegionScope } from '../../../../auth/rbac'
import { getDb } from '../../../../db'
import { withRequestRls } from '../../../../db/request-rls'
import { requireUuidParam } from '../../../../utils/require-uuid-param'
import { monthStartIso } from '../../../../utils/period'

interface ConsumptionRow extends Record<string, unknown> {
  project_id: string
  total_cost_usd: string
  total_tokens: string
}

export default defineEventHandler(async (event) => {
  const session = await requireRole(event, 'manager', 'admin', 'global-finops')
  const id = requireUuidParam(event, 'id', 'project id')

  const db = getDb()
  // Region-bound the admin to the PROJECT's region before reading any spend
  // (API-1): without this, a region-scoped admin could read any project's
  // consumption cross-region by id — the breakdown/export endpoints close the
  // identical hole via requireRegionScope. Managers are NOT region-gated here
  // (requireRegionScope would deny them outright); their bound is the
  // org-subtree predicate in the query below.
  const projRows = await db.execute<{ region_id: string }>(sql`
    SELECT region_id::text AS region_id FROM project WHERE id = ${id}::uuid LIMIT 1
  `)
  const proj = [...projRows][0]
  if (!proj) {
    throw createError({ statusCode: 404, statusMessage: 'Project not found' })
  }
  if (session.role !== 'manager') {
    await requireRegionScope(event, proj.region_id)
  }

  const monthStart = monthStartIso()

  const rows = await withRequestRls(event, async (tx) =>
    tx.execute<ConsumptionRow>(sql`
      SELECT p.id::text AS project_id,
             COALESCE(SUM(ar.cost_usd), 0)::text AS total_cost_usd,
             COALESCE(SUM(ar.tokens), 0)::text   AS total_tokens
      FROM project p
      JOIN org_unit cou ON cou.id = p.cost_owning_unit_id
      LEFT JOIN attribution_record ar
        ON ar.project_id = p.id
       AND ar.ts_event >= ${monthStart}::timestamptz
      WHERE p.id = ${id}::uuid
        AND (
          current_setting('app.user_role', true) IN ('admin', 'global-finops')
          OR cou.path <@ current_setting('app.user_org_path', true)::ltree
        )
      GROUP BY p.id
    `),
  )

  const row = [...rows][0]
  if (!row) {
    return { project_id: id, total_cost_usd: '0.00', total_tokens: 0 }
  }
  return {
    project_id: row.project_id,
    total_cost_usd: Number(row.total_cost_usd).toFixed(2),
    total_tokens: Number(row.total_tokens),
  }
})
