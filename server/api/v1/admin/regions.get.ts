/*
 * GET /api/v1/admin/regions — the region list for admin pickers (e.g. the
 * region-reassignment control). Region names aren't sensitive, so any admin /
 * global-finops (and platform-admin via the requireRole bypass) may read the
 * full list; the reassignment action itself is separately gated to org-wide
 * roles in users/[id]/region.patch.ts.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../auth/rbac'
import { getDb } from '../../../db'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')
  const db = getDb()
  const rows = await db.execute<{ id: string; code: string; display_name: string }>(sql`
    SELECT id::text AS id, code, display_name FROM region ORDER BY display_name
  `)
  return { regions: [...rows] }
})
