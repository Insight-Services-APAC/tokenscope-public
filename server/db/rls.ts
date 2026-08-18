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
 *
 * Three lanes carry an identity onto a connection (docs/design/rls-enforcement.md
 * §2), and all three land here:
 *   - request  → server/db/request-rls.ts::withRequestRls (the cookie session)
 *   - machine  → server/db/machine-rls.ts::withMachineRls (a presented credential)
 *   - worker   → a dedicated pool carrying a connection-level GUC (not this file)
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { consola } from 'consola'

export interface RlsContext {
  userRegionId: string
  userOrgPath: string
  userRole: 'developer' | 'manager' | 'admin' | 'finance' | 'global-finops'
  userTeammateId: string
}

const RLS_ROLES: ReadonlySet<string> = new Set([
  'developer',
  'manager',
  'admin',
  'finance',
  'global-finops',
])

/**
 * Map an application role onto the value the RLS policies compare against
 * `app.user_role`.
 *
 * `platform-admin` (the cross-region super-admin) has no policy of its own:
 * every `IN ('admin','global-finops')` clause in 0098_rls_policy_convergence.sql
 * already treats `global-finops` as org-wide, so it maps onto that rather than
 * each clause growing a sixth arm. (App-level `requireRole` already lets it
 * through, so this is not a privilege grant — it is the same privilege spelled
 * the way the policies read it.)
 *
 * An unrecognised role FAILS CLOSED to `developer` rather than throwing.
 * `teammate.role` is a free-text column (mig 0001) whose value reaches this
 * function on the EMIT path via `requireOAuthBearer`; a throw there would turn
 * one malformed row into a fleet-wide emission stop, which is a far worse
 * outcome than the narrowest possible scope plus a loud log line.
 */
export function rlsRoleFor(role: string): RlsContext['userRole'] {
  if (role === 'platform-admin') return 'global-finops'
  if (RLS_ROLES.has(role)) return role as RlsContext['userRole']
  consola.warn(
    `[rls] unrecognised role ${JSON.stringify(role)} — falling back to 'developer' (least privilege)`,
  )
  return 'developer'
}

/**
 * Set the four GUCs on an ALREADY-OPEN transaction (`SET LOCAL`, so they are
 * gone when it ends).
 *
 * Exists as its own primitive for the one lane that cannot know its identity
 * before it opens the transaction: `setup/redeem.post.ts` discovers the
 * teammate by CONSUMING a one-time handoff code, and that consume has to be in
 * the same transaction as everything after it (a mid-sequence failure must roll
 * back to a still-redeemable code). Such a caller opens its transaction, learns
 * who it is, then adopts the context here.
 *
 * Prefer `withRlsContext` / `withRequestRls` / `withMachineRls` everywhere else.
 */
export async function applyRlsContext<TSchema extends Record<string, unknown>>(
  tx: PostgresJsDatabase<TSchema>,
  ctx: RlsContext,
): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.user_region_id', ${ctx.userRegionId}, true)`)
  await tx.execute(sql`SELECT set_config('app.user_org_path', ${ctx.userOrgPath}, true)`)
  await tx.execute(sql`SELECT set_config('app.user_role', ${ctx.userRole}, true)`)
  await tx.execute(sql`SELECT set_config('app.user_teammate_id', ${ctx.userTeammateId}, true)`)
}

export async function withRlsContext<TSchema extends Record<string, unknown>, T>(
  db: PostgresJsDatabase<TSchema>,
  ctx: RlsContext,
  fn: (tx: PostgresJsDatabase<TSchema>) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await applyRlsContext(tx as unknown as PostgresJsDatabase<TSchema>, ctx)
    return fn(tx as unknown as PostgresJsDatabase<TSchema>)
  })
}
