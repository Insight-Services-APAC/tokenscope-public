/*
 * GET /api/v1/admin/department-map — list the department → region map
 * (region derivation, mig 0068). admin / global-finops.
 *
 * This is the PRIMARY region-derivation signal: an unplaced user's Entra
 * `department` is looked up (case-insensitively, keyed on department_lower)
 * to home them in their real region. The map is org-wide curated config, so
 * this list is not region-scoped — every admin sees the whole table (it
 * informs cross-region placement). Each row is joined to its region for
 * display (code + display_name).
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'

export default defineEventHandler(async (event) => {
  // Org-wide cross-region placement config → GLOBAL roles only (per design).
  await requireRole(event, 'global-finops', 'platform-admin')

  return await withRequestRls(event, async (tx) => {
    const rows = await tx.execute<{
      department: string
      department_lower: string
      region_id: string
      region_code: string
      region_display_name: string
    }>(sql`
      SELECT d.department,
             d.department_lower,
             d.region_id::text AS region_id,
             r.code AS region_code,
             r.display_name AS region_display_name
      FROM department_to_region d
      JOIN region r ON r.id = d.region_id
      ORDER BY d.department_lower ASC
    `)

    return {
      mappings: [...rows].map((r) => ({
        department: r.department,
        department_lower: r.department_lower,
        region_id: r.region_id,
        region_code: r.region_code,
        region_display_name: r.region_display_name,
      })),
    }
  })
})
