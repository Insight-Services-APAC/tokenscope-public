/*
 * GET /api/v1/admin/grants?teammate_id=<uuid> — a single teammate's authorized
 * connections, for the admin grants surface. Design doc §Grant lifecycle (F3.3).
 *
 * Two-layer RBAC:
 *   - requireRole(admin, global-finops) at the edge.
 *   - Region scope (F3.3): `oauth_token` has NO region of its own, so we resolve
 *     the TARGET teammate's region_id (oauth_token → teammate) and run
 *     requireRegionScope(event, teammate.region_id). A region admin querying a
 *     peer-region teammate's grants gets the requireRegionScope 403
 *     (platform-admin / global-finops are region-unbounded). RLS is inert under
 *     the owner connection, so this explicit check is the live gate.
 *
 * Returns the same per-grant projection as /me/grants (derived state, scopes,
 * plain-language labels, is_emit) PLUS the owning teammate's identity. An unknown
 * teammate_id 404s (no row → nothing to scope; we don't leak by returning []).
 */
import { createError, defineEventHandler } from 'h3'
import { getValidated } from '../../../../utils/validated-body'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { requireRole, requireRegionScope } from '../../../../auth/rbac'
import { getDb, schema } from '../../../../db'
import { getGrantsForTeammate } from '../../../../utils/me-queries'

const Query = z.object({
  teammate_id: z.string().uuid(),
})

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')
  const { teammate_id } = await getValidated(event, Query)

  const db = getDb()
  // Resolve the target teammate's region — the scope axis for oauth_token, which
  // has none of its own. Unknown teammate → 404 (don't leak via an empty list).
  const [tm] = await db
    .select({ regionId: schema.teammate.regionId })
    .from(schema.teammate)
    .where(eq(schema.teammate.id, teammate_id))
    .limit(1)
  if (!tm) {
    throw createError({ statusCode: 404, statusMessage: 'Teammate not found' })
  }

  // Region-bound the admin to the teammate's region (platform-admin / global-finops
  // pass through).
  await requireRegionScope(event, tm.regionId)

  const grants = await getGrantsForTeammate(
    db as unknown as PostgresJsDatabase<Record<string, unknown>>,
    teammate_id,
  )
  return { teammate_id, grants }
})
