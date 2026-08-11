/*
 * GET /api/v1/admin/report-access/teammate-search?q=&limit= — a minimal
 * teammate typeahead for the report-access grant picker (A7). The existing
 * admin/users list needs a region param this UI cannot serve (picking a
 * report-access target is org-wide, not region-scoped), so this mirrors
 * server/api/v1/admin/reconciliation/github/teammate-search.get.ts's
 * query/response conventions rather than reusing that endpoint's shape.
 *
 * ORG-WIDE ONLY (A4): requireRole(event, 'global-finops'). Returns only
 * ACTIVE, NON-PROVISIONAL teammates — report-access grants require the same
 * (see index.post.ts) — with id + email + display name + role + region. No
 * secrets, capped result set.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { getValidated } from '../../../../utils/validated-body'
import { LIKE_ESCAPE, escapeLikeLiteral } from '../../../../utils/sql-like'

const Query = z.object({
  q: z.string().trim().min(2),
  limit: z.coerce.number().int().positive().max(25).default(10),
})

interface Row extends Record<string, unknown> {
  id: string
  display_name: string | null
  email: string
  role: string
  region_id: string
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'global-finops')
  // getValidated (not h3's getValidatedQuery): the 400 names the failing
  // field and rule per the repo's RFC-9457 convention.
  const query = await getValidated(event, Query)

  return await withRequestRls(event, async (tx) => {
    const like = `%${escapeLikeLiteral(query.q)}%`
    const rows = await tx.execute<Row>(sql`
      SELECT id::text AS id, display_name, email, role, region_id::text AS region_id
      FROM teammate
      WHERE is_active = TRUE AND provisional IS NOT TRUE
        AND (display_name ILIKE ${like} ESCAPE ${LIKE_ESCAPE} OR email ILIKE ${like} ESCAPE ${LIKE_ESCAPE})
      ORDER BY display_name NULLS LAST, email
      LIMIT ${query.limit}
    `)

    return {
      results: [...rows].map((r) => ({
        id: r.id,
        display_name: r.display_name,
        email: r.email,
        role: r.role,
        region_id: r.region_id,
      })),
    }
  })
})
