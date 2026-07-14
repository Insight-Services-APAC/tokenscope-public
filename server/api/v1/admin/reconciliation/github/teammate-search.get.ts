/*
 * GET /api/v1/admin/reconciliation/github/teammate-search?q=<name-or-email> — a minimal,
 * GLOBAL (non-region-scoped) teammate typeahead for the "Unresolved Copilot users" map picker.
 *
 * The admin/teammates list is region-scoped (requireRegionScope), but mapping a Copilot login
 * is a global-finops/admin action across the whole estate — the admin does not know the
 * teammate's region a priori. This is the "minimal search-by-email/name backed by an existing
 * teammates table" the map surface needs: it returns only ACTIVE, NON-PROVISIONAL teammates
 * (the only valid attribution targets — the map POST rejects a provisional shadow) with id +
 * email + display name. No secrets, capped result set.
 *
 * RBAC: requireRole(admin, global-finops) — same guard as the sibling reconciliation routes.
 * teammate has no RLS policy relevant here → getDb(). GET (read-only) → no assertSameOrigin.
 */
import { defineEventHandler, getValidatedQuery, createError } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../../auth/rbac'
import { getDb } from '../../../../../db'

const Query = z.object({
  q: z.string().trim().min(1).max(120),
  limit: z.coerce.number().int().positive().max(25).default(10),
})

interface Row extends Record<string, unknown> {
  id: string
  email: string
  display_name: string | null
  region_code: string | null
  org_unit_code: string | null
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')
  const query = await getValidatedQuery(event, (data) => {
    const parsed = Query.safeParse(data)
    if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'invalid query parameter' })
    return parsed.data
  })
  const db = getDb()

  const like = `%${query.q}%`
  const rows = await db.execute<Row>(sql`
    SELECT t.id::text AS id,
           t.email,
           t.display_name,
           rg.code AS region_code,
           ou.code AS org_unit_code
    FROM teammate t
    LEFT JOIN region rg ON rg.id = t.region_id
    LEFT JOIN org_unit ou ON ou.id = t.org_unit_id
    WHERE t.is_active = TRUE
      AND NOT t.provisional
      AND (t.display_name ILIKE ${like} OR t.email ILIKE ${like})
    ORDER BY t.display_name NULLS LAST, t.email
    LIMIT ${query.limit}
  `)

  return {
    teammates: [...rows].map((r) => ({
      id: r.id,
      email: r.email,
      displayName: r.display_name,
      regionCode: r.region_code,
      orgUnitCode: r.org_unit_code,
    })),
  }
})
