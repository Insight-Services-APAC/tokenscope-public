/*
 * RLS context helper — sets the four session GUCs that the RLS policies
 * read at every query.
 *
 * Per data-model.md §RLS, app code MUST set these on every connection
 * checkout. Calling `withRlsContext` wraps a callback in a transaction
 * where the GUCs are scoped (SET LOCAL); after the callback returns the
 * settings are gone, so the next checkout doesn't inherit them.
 *
 * Epic 3 wires this into the Nitro request lifecycle. Tests use this
 * directly to exercise the policies.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'

export interface RlsContext {
  userRegionId: string
  userOrgPath: string
  userRole: 'developer' | 'manager' | 'admin' | 'finance' | 'global-finops'
  userTeammateId: string
}

export async function withRlsContext<TSchema extends Record<string, unknown>, T>(
  db: PostgresJsDatabase<TSchema>,
  ctx: RlsContext,
  fn: (tx: PostgresJsDatabase<TSchema>) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_region_id', ${ctx.userRegionId}, true)`)
    await tx.execute(sql`SELECT set_config('app.user_org_path', ${ctx.userOrgPath}, true)`)
    await tx.execute(sql`SELECT set_config('app.user_role', ${ctx.userRole}, true)`)
    await tx.execute(sql`SELECT set_config('app.user_teammate_id', ${ctx.userTeammateId}, true)`)
    return fn(tx as unknown as PostgresJsDatabase<TSchema>)
  })
}
