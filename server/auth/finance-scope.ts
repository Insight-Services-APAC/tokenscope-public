/*
 * finance-scope — region clamp for the finance rollup list queries.
 *
 * Finance rollups are gated to admin + global-finops. global-finops is
 * org-wide by design and honours the UI region filter; a region `admin`
 * must be hard-bound to their OWN region (the same contract as
 * requireRegionScope, which every admin/* endpoint applies). The
 * finance.get docstring already states "Region-scoped per
 * requireRegionScope" — this is the wiring that was missing.
 *
 * This is the LIVE gate: RLS is bypassed at runtime (owner DB
 * connection, no FORCE ROW LEVEL SECURITY) until Epic 10's non-owner
 * role lands, so the region bound must live in the query. See
 * server/auth/allocation-scope.ts for the same rationale.
 */
import { createError } from 'h3'
import { sql, type SQL } from 'drizzle-orm'
import type { Session } from '../utils/auth'
import { isPlatformAdmin } from '../../shared/auth/roles'

/**
 * Returns an `AND …` SQL fragment clamping a finance rollup query to the
 * caller's region. `regionAlias` is the calling query's alias for the
 * `region` table (a code constant, never user input).
 *
 *   - admin                          → hard-bound to session.regionId
 *                                      (requested param ignored)
 *   - global-finops / platform-admin → honours the requested region code
 *                                      ('all' = unbounded)
 *   - anything else                  → 403 (CORE-3 fail-closed default; this
 *                                      helper must not depend on every caller
 *                                      remembering requireRole)
 */
export function financeRegionFilter(
  session: Session,
  requestedRegionCode: string,
  regionAlias = 'r',
): SQL {
  const r = sql.raw(regionAlias)
  if (session.role === 'admin') {
    return sql`AND ${r}.id = ${session.regionId}::uuid`
  }
  if (session.role === 'global-finops' || isPlatformAdmin(session.role)) {
    return requestedRegionCode === 'all' ? sql`` : sql`AND ${r}.code = ${requestedRegionCode}`
  }
  // Default DENY: unlisted roles get no finance rollup scope at all.
  throw createError({
    statusCode: 403,
    statusMessage: 'Forbidden',
    data: {
      type: 'https://tokenscope.example.com/errors/forbidden',
      title: 'Forbidden',
      status: 403,
      detail: `Role '${session.role}' is not permitted to read finance rollups.`,
    },
  })
}
