/*
 * withRequestRls — bind the current request's session to a transaction
 * with the four RLS GUCs set, then run a body inside it.
 *
 * Pattern: every API handler that hits user-scoped data wraps the DB
 * call in withRequestRls(event, async (tx) => ...). The transaction
 * uses SET LOCAL so the GUCs are gone the moment the body returns.
 *
 * For pre-Epic-4 endpoints that don't yet have a real Nitro event (e.g.
 * tests, workers), use server/db/rls.ts::withRlsContext directly.
 */
import type { H3Event } from 'h3'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { getDb } from './index'
import { requireAuth } from '../utils/auth'
import { withRlsContext } from './rls'

export async function withRequestRls<T>(
  event: H3Event,
  fn: (tx: PostgresJsDatabase<Record<string, unknown>>) => Promise<T>,
): Promise<T> {
  const session = await requireAuth(event)
  return withRlsContext(
    getDb() as unknown as PostgresJsDatabase<Record<string, unknown>>,
    {
      userRegionId: session.regionId,
      userOrgPath: session.orgPath,
      // platform-admin (cross-region super-admin) maps to the unbounded scope
      // at the RLS layer — every IN ('admin','global-finops') clause + policy
      // already treats global-finops as org-wide, so reuse it rather than
      // touching each clause. (App-level requireRole already lets it through.)
      userRole: session.role === 'platform-admin' ? 'global-finops' : session.role,
      userTeammateId: session.teammateId,
    },
    fn,
  )
}
