/*
 * GET /api/v1/admin/repos?region={regionId} — region-scoped repo
 * mappings for the admin Repos tab (design-notes §Screen 5).
 *
 * Joins repo_project_map → project to keep the rows scoped to the
 * requested region. Empty in MVP-Lite (no repos seeded); the tab
 * still renders, with an UiEmptyState in the table.
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
})

interface Row extends Record<string, unknown> {
  id: string
  repo_full_name: string
  repo_provider: string
  project_code: string
  project_display_name: string
  source: string
  last_sync_at: string | null
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')
  const query = await getValidated(event, Query)
  await requireRegionScope(event, query.region)

  // Rows + a real COUNT(*) in ONE RLS transaction (API-8 — `total` was the
  // PAGE size, so with >limit mappings the UI saw total=limit and never
  // paged; API-13 house pattern for the single tx).
  const { rows, total } = await withRequestRls(event, async (tx) => {
    const dataRows = await tx.execute<Row>(sql`
      SELECT rpm.id::text AS id,
             rpm.repo_full_name,
             rpm.repo_provider,
             p.code AS project_code,
             p.display_name AS project_display_name,
             rpm.source,
             rpm.last_sync_at::text AS last_sync_at
      FROM repo_project_map rpm
      JOIN project p ON p.id = rpm.project_id
      WHERE p.region_id = ${query.region}::uuid
      ORDER BY rpm.repo_full_name
      LIMIT ${query.limit} OFFSET ${query.offset}
    `)
    const totalRows = await tx.execute<{ total: string }>(sql`
      SELECT COUNT(*)::text AS total
      FROM repo_project_map rpm
      JOIN project p ON p.id = rpm.project_id
      WHERE p.region_id = ${query.region}::uuid
    `)
    return { rows: [...dataRows], total: Number([...totalRows][0]?.total ?? 0) }
  })

  return {
    repos: rows,
    total,
    limit: query.limit,
    offset: query.offset,
  }
})
