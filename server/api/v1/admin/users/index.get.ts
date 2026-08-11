/*
 * GET /api/v1/admin/users — Wave-VI admin users page list.
 *
 * Sibling of /api/v1/admin/teammates (the existing region-setup grid).
 * The teammates endpoint is keyed off the region-setup contract (Org
 * unit + source + is_active) and is consumed by the EntityTable on the
 * region-admin page; this endpoint is shaped for the new Users sub-page
 * (role + last-sync chrome + role filter) so neither caller drifts the
 * other's response shape.
 *
 * Two-layer RBAC: requireRole(admin / global-finops) at the edge +
 * withRequestRls so RLS denies anything the caller's region doesn't own.
 */
import { defineEventHandler } from 'h3'
import { getValidated } from '../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { ROLES } from '../../../../../shared/auth/roles'
import { LIKE_ESCAPE, escapeLikeLiteral } from '../../../../utils/sql-like'

const Query = z.object({
  region: z.string().uuid(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
  q: z.string().max(120).optional(),
  role: z.enum(ROLES).optional(),
})

interface Row extends Record<string, unknown> {
  id: string
  email: string
  display_name: string | null
  role: string
  region_id: string
  org_unit_path: string
  org_unit_name: string
  org_unit_id: string
  is_active: boolean
  joined_at: string
  last_sync_at: string | null
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')
  const query = await getValidated(event, Query)
  await requireRegionScope(event, query.region)

  const searchClause = query.q
    ? sql`AND (t.display_name ILIKE ${`%${escapeLikeLiteral(query.q)}%`} ESCAPE ${LIKE_ESCAPE} OR t.email ILIKE ${`%${escapeLikeLiteral(query.q)}%`} ESCAPE ${LIKE_ESCAPE})`
    : sql``
  const roleClause = query.role ? sql`AND t.role = ${query.role}` : sql``

  // Rows + COUNT + admin count in ONE RLS transaction (API-13, per the
  // admin/audit house pattern "R2 F1") — three separate withRequestRls
  // calls could disagree mid-flight if a teammate row changes between
  // them, and each pays its own GUC-setup overhead.
  const { rows, total, adminCount } = await withRequestRls(event, async (tx) => {
    const dataRows = await tx.execute<Row>(sql`
      SELECT t.id::text AS id,
             t.email,
             t.display_name,
             t.role,
             t.region_id::text AS region_id,
             ou.path::text AS org_unit_path,
             -- The NAME, because the path is an implementation detail. Admin
             -- rendered the raw ltree (apac.apac_cto) in a column headed
             -- "Org unit" — unreadable outside this codebase, and one the
             -- page's own optimistic update already replaced with the display
             -- name after a move, so the column disagreed with itself.
             -- (No backticks in this literal: one inside a SQL comment CLOSES
             -- the sql template and the parse error points at the wrong line.)
             ou.display_name AS org_unit_name,
             -- The ID, because a <select> must be keyed on identity. Matching
             -- options by display_name cannot distinguish two BUs that share a
             -- name, and several regions have a "CTO Office".
             ou.id::text AS org_unit_id,
             t.is_active,
             t.joined_at,
             t.last_sync_at
      FROM teammate t
      JOIN org_unit ou ON ou.id = t.org_unit_id
      WHERE t.region_id = ${query.region}::uuid
        ${searchClause}
        ${roleClause}
      ORDER BY t.display_name NULLS LAST, t.email
      LIMIT ${query.limit} OFFSET ${query.offset}
    `)

    const totalRows = await tx.execute<{ total: string }>(sql`
      SELECT COUNT(*)::text AS total
      FROM teammate t
      WHERE t.region_id = ${query.region}::uuid
        ${searchClause}
        ${roleClause}
    `)

    // Admin count surfaces the "last admin" indicator on the page.
    // Region-scoped on purpose: the last-admin protection in the PATCH
    // handler ALSO uses a region-scoped count, so the UI signal matches
    // server-side enforcement. (A global-finops viewer sees the same
    // per-region badge; cross-region demotion isn't an MVP scenario.)
    const adminCountRows = await tx.execute<{ admin_count: string }>(sql`
      SELECT COUNT(*)::text AS admin_count
      FROM teammate
      WHERE region_id = ${query.region}::uuid AND role = 'admin' AND is_active = TRUE
    `)

    return {
      rows: [...dataRows],
      total: Number([...totalRows][0]?.total ?? 0),
      adminCount: Number([...adminCountRows][0]?.admin_count ?? 0),
    }
  })

  return {
    users: [...rows].map((r) => ({
      id: r.id,
      email: r.email,
      displayName: r.display_name,
      role: r.role,
      regionId: r.region_id,
      orgUnitPath: r.org_unit_path,
      orgUnitName: r.org_unit_name,
      orgUnitId: r.org_unit_id,
      isActive: r.is_active,
      joinedAt: r.joined_at,
      lastSyncAt: r.last_sync_at,
    })),
    total,
    adminCount,
    limit: query.limit,
    offset: query.offset,
  }
})
