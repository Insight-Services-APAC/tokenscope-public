/*
 * GET /api/v1/admin/directory-region-rules — list every directory→region rule
 * (mig 0089), joined to its region for display. GLOBAL roles only (cross-region
 * placement config). Supersedes the department-only /admin/department-map list.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'global-finops', 'platform-admin')

  return await withRequestRls(event, async (tx) => {
    const rows = await tx.execute<{
      id: string
      attribute: string
      match_mode: string
      match_value: string
      match_value_raw: string
      region_id: string
      region_code: string
      region_display_name: string
    }>(sql`
      SELECT d.id::text AS id,
             d.attribute,
             d.match_mode,
             d.match_value,
             d.match_value_raw,
             d.region_id::text AS region_id,
             r.code AS region_code,
             r.display_name AS region_display_name
      FROM directory_region_rule d
      JOIN region r ON r.id = d.region_id
      ORDER BY d.attribute ASC, d.match_value ASC
    `)

    return {
      rules: [...rows].map((r) => ({
        id: r.id,
        attribute: r.attribute,
        match_mode: r.match_mode,
        match_value: r.match_value,
        match_value_raw: r.match_value_raw,
        region_id: r.region_id,
        region_code: r.region_code,
        region_display_name: r.region_display_name,
      })),
    }
  })
})
