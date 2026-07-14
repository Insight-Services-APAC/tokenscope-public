/*
 * GET /api/v1/admin/teammates?region={regionId}&limit=N&offset=M
 * — region-scoped teammates list for the admin Teammates tab
 * (design-notes §Screen 5).
 *
 * Surfaces email, display name, role (best-effort: persona OID
 * pattern → mapped role), org-unit path, source (SCIM / manual /
 * CSV). Pagination via limit + offset.
 */
import { defineEventHandler } from 'h3'
import { getValidated } from '../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'

const Query = z.object({
  region: z.string().uuid(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
  q: z.string().max(120).optional(),
})

interface Row extends Record<string, unknown> {
  id: string
  email: string
  display_name: string | null
  org_unit_code: string
  org_unit_display_name: string
  source: string
  is_active: boolean
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')
  const query = await getValidated(event, Query)
  await requireRegionScope(event, query.region)

  const filterClause = query.q
    ? sql`AND (t.display_name ILIKE ${`%${query.q}%`} OR t.email ILIKE ${`%${query.q}%`})`
    : sql``

  // Rows + COUNT in ONE RLS transaction (API-13, per the admin/audit
  // house pattern "R2 F1") so the page and its total cannot disagree.
  const { rows, total } = await withRequestRls(event, async (tx) => {
    const dataRows = await tx.execute<Row>(sql`
      SELECT t.id::text AS id,
             t.email,
             t.display_name,
             ou.code AS org_unit_code,
             ou.display_name AS org_unit_display_name,
             t.source,
             t.is_active
      FROM teammate t
      JOIN org_unit ou ON ou.id = t.org_unit_id
      WHERE t.region_id = ${query.region}::uuid
        AND t.is_active = TRUE
        ${filterClause}
      ORDER BY t.display_name NULLS LAST, t.email
      LIMIT ${query.limit} OFFSET ${query.offset}
    `)
    const totalRows = await tx.execute<{ total: string }>(sql`
      SELECT COUNT(*)::text AS total
      FROM teammate t
      WHERE t.region_id = ${query.region}::uuid
        AND t.is_active = TRUE
        ${filterClause}
    `)
    return { rows: [...dataRows], total: Number([...totalRows][0]?.total ?? 0) }
  })

  return {
    teammates: rows,
    total,
    limit: query.limit,
    offset: query.offset,
  }
})
