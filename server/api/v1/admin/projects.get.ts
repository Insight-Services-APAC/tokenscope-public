/*
 * GET /api/v1/admin/projects?region={regionId} — region-scoped
 * projects list for the admin Projects tab (design-notes §Screen 5).
 */
import { defineEventHandler } from 'h3'
import { getValidated } from '../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'
import { endedProjectExpr } from '../../../db/project-predicates'

const Query = z.object({
  region: z.string().uuid(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
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
  await requireRole(event, 'admin', 'global-finops')
  const query = await getValidated(event, Query)
  await requireRegionScope(event, query.region)

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
      ORDER BY p.code
      LIMIT ${query.limit} OFFSET ${query.offset}
    `)
    const totalRows = await tx.execute<{ total: string }>(sql`
      SELECT COUNT(*)::text AS total FROM project WHERE region_id = ${query.region}::uuid
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
