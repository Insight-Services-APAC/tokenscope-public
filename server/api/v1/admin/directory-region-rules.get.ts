/*
 * GET /api/v1/admin/directory-region-rules[?region={regionId}] — the curated
 * directory placement rules (mig 0089 + the mig 0112 unit target), joined to
 * their region and, for a unit rule, to the cost centre they place into.
 *
 * TWO MODES, because the two rule kinds have two audiences:
 *
 *   no `region`    every rule, region and unit alike. GLOBAL roles only — the
 *                  region rules in it are cross-region placement config, and this
 *                  is the list /admin/department-map renders.
 *   `?region=…`    ONLY the UNIT rules that place into that region, for the
 *                  region admin who created them from the placement worklist.
 *                  `admin` + requireRegionScope, the same gate as every other
 *                  region-scoped surface.
 *
 * The scoped mode deliberately does NOT include region rules that happen to name
 * this region: those are org-wide config a region admin cannot edit, and listing
 * a row beside a Remove button that will 403 teaches the admin the page is broken.
 */
import { defineEventHandler } from 'h3'
import { getValidated } from '../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'

const Query = z.object({
  region: z.string().uuid().optional(),
})

export default defineEventHandler(async (event) => {
  const query = await getValidated(event, Query)
  if (query.region) {
    await requireRole(event, 'admin', 'global-finops')
    await requireRegionScope(event, query.region)
  } else {
    await requireRole(event, 'global-finops', 'platform-admin')
  }

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
      org_unit_id: string | null
      org_unit_code: string | null
      org_unit_display_name: string | null
      org_unit_retired: boolean | null
      org_unit_cost_owning: boolean | null
    }>(sql`
      SELECT d.id::text AS id,
             d.attribute,
             d.match_mode,
             d.match_value,
             d.match_value_raw,
             d.region_id::text AS region_id,
             r.code AS region_code,
             r.display_name AS region_display_name,
             d.org_unit_id::text AS org_unit_id,
             ou.code AS org_unit_code,
             ou.display_name AS org_unit_display_name,
             (ou.retired_at IS NOT NULL) AS org_unit_retired,
             ou.is_cost_owning_unit AS org_unit_cost_owning
      FROM directory_region_rule d
      JOIN region r ON r.id = d.region_id
      LEFT JOIN org_unit ou ON ou.id = d.org_unit_id
      ${query.region ? sql`WHERE d.org_unit_id IS NOT NULL AND d.region_id = ${query.region}::uuid` : sql``}
      ORDER BY d.attribute ASC, d.match_value ASC
    `)

    return {
      scope: query.region ? 'region' : 'all',
      rules: [...rows].map((r) => ({
        id: r.id,
        attribute: r.attribute,
        match_mode: r.match_mode,
        match_value: r.match_value,
        match_value_raw: r.match_value_raw,
        region_id: r.region_id,
        region_code: r.region_code,
        region_display_name: r.region_display_name,
        org_unit_id: r.org_unit_id,
        org_unit_code: r.org_unit_code,
        org_unit_display_name: r.org_unit_display_name,
        /*
         * A unit rule whose target has been retired or un-flagged places NOBODY
         * — the rule loader DROPS it (placement-store.ts) rather than degrading
         * it to a region rule, which would hand its region-admin author org-wide
         * placement configuration they could not have written. Surfaced so the
         * row can say so instead of looking like a rule that works.
         */
        target_placeable: r.org_unit_id ? r.org_unit_retired === false && r.org_unit_cost_owning === true : null,
      })),
    }
  })
})
