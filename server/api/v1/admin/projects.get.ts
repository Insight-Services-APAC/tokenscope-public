/*
 * GET /api/v1/admin/projects?region={regionId} — region-scoped
 * projects list for the admin Projects tab (design-notes §Screen 5).
 *
 * Server search and filters (#582): `q` matches code or display name,
 * `status` keeps active or ended projects, `budget=none` keeps projects with no
 * budget. Every filter is applied to the rows AND the COUNT, inside the same
 * region predicate, so the footer's "1 to 50 of N" counts what the filters
 * match in this region and nothing else.
 */
import { defineEventHandler } from 'h3'
import { getValidated } from '../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'
import { activeProjectPredicate, endedProjectExpr } from '../../../db/project-predicates'
import { LIKE_ESCAPE, escapeLikeLiteral } from '../../../utils/sql-like'
import { ADMIN_LIST_SEARCH_MAX } from '../../../../shared/schemas/admin-list-search'

const Query = z.object({
  region: z.string().uuid(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
  q: z.string().trim().max(ADMIN_LIST_SEARCH_MAX).optional(),
  status: z.enum(['active', 'ended']).optional(),
  budget: z.enum(['none']).optional(),
})

interface Row extends Record<string, unknown> {
  id: string
  code: string
  display_name: string
  type: string
  wbs_code: string | null
  cou_display_name: string
  is_onboarded: boolean
  repo_count: string
  end_date: string | null
  ended: boolean
  deletable: boolean
  has_spend: boolean
  member_count: string
  has_budget: boolean
  /** The project's current shared-pool baseline allocation id, for the Budget deep-link. Null = no baseline. */
  allocation_id: string | null
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin')
  const query = await getValidated(event, Query)
  await requireRegionScope(event, query.region)

  // The filters, ANDed onto the region predicate (never instead of it).
  const like = query.q ? `%${escapeLikeLiteral(query.q)}%` : null
  const filters = sql.join(
    [
      like
        ? sql`AND (p.code ILIKE ${like} ESCAPE ${LIKE_ESCAPE} OR p.display_name ILIKE ${like} ESCAPE ${LIKE_ESCAPE})`
        : sql``,
      query.status === 'active' ? sql`AND ${activeProjectPredicate('p')}` : sql``,
      query.status === 'ended' ? sql`AND ${endedProjectExpr('p')}` : sql``,
      query.budget === 'none'
        ? sql`AND NOT EXISTS (SELECT 1 FROM allocation WHERE scope_type = 'project' AND scope_id = p.id)`
        : sql``,
    ],
    sql` `,
  )

  // Rows + COUNT in ONE RLS transaction (API-13, per the admin/audit
  // house pattern "R2 F1") so the page and its total cannot disagree.
  const { rows, total } = await withRequestRls(event, async (tx) => {
    const dataRows = await tx.execute<Row>(sql`
      SELECT p.id::text AS id,
             p.code,
             p.display_name,
             p.type,
             p.wbs_code,
             ou.display_name AS cou_display_name,
             p.is_onboarded,
             p.end_date::text AS end_date,
             ${endedProjectExpr('p')} AS ended,
             COALESCE((SELECT COUNT(*) FROM repo_project_map WHERE project_id = p.id), 0)::text AS repo_count,
             -- deletable = $0 SPEND and no tagged repos (D4 revised). The budget
             -- + members cascade on delete, so they don't block. When NOT
             -- deletable, has_spend / repo_count tell the UI why.
             (NOT EXISTS (SELECT 1 FROM attribution_record WHERE project_id = p.id)
              AND NOT EXISTS (SELECT 1 FROM repo_project_map WHERE project_id = p.id)) AS deletable,
             EXISTS (SELECT 1 FROM attribution_record WHERE project_id = p.id) AS has_spend,
             (SELECT COUNT(*) FROM project_assignment WHERE project_id = p.id)::text AS member_count,
             EXISTS (SELECT 1 FROM allocation WHERE scope_type = 'project' AND scope_id = p.id) AS has_budget,
             -- The current SHARED-POOL baseline allocation id, for the Budget deep-link
             -- (Admin → Projects → the allocation editor's top-up control). teammate_id
             -- IS NULL is the real discriminator: per-developer caps are ALSO
             -- allocation_kind='baseline' rows (only teammate_id distinguishes them) and
             -- share the pool's effective window, so without this guard the newest-by-
             -- lower(effective) pick is non-deterministic and could land on a dev cap.
             (SELECT al.id::text FROM allocation al
               WHERE al.scope_type = 'project' AND al.scope_id = p.id
                 AND al.allocation_kind = 'baseline' AND al.teammate_id IS NULL
               ORDER BY lower(al.effective) DESC LIMIT 1) AS allocation_id
      FROM project p
      JOIN org_unit ou ON ou.id = p.cost_owning_unit_id
      WHERE p.region_id = ${query.region}::uuid
        ${filters}
      ORDER BY p.code
      LIMIT ${query.limit} OFFSET ${query.offset}
    `)
    const totalRows = await tx.execute<{ total: string }>(sql`
      SELECT COUNT(*)::text AS total
      FROM project p
      WHERE p.region_id = ${query.region}::uuid
        ${filters}
    `)
    return { rows: [...dataRows], total: Number([...totalRows][0]?.total ?? 0) }
  })

  return {
    projects: rows.map((r) => ({
      ...r,
      repo_count: Number(r.repo_count),
      member_count: Number(r.member_count),
    })),
    total,
    limit: query.limit,
    offset: query.offset,
  }
})
