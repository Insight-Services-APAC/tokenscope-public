/*
 * withMachineRls — the MACHINE lane of docs/design/rls-enforcement.md §2.
 *
 * `withRequestRls` calls `requireAuth(event)`, so it can only serve handlers
 * that carry a browser session. The four /api/v1/instances/{instanceId}/*
 * routes carry no session at all: they authenticate a DEVICE with an OAuth
 * `tokenscope.emit` bearer. That credential still resolves a real, unspoofable
 * identity — `requireOAuthBearer` returns the bound teammate, and (since the
 * same join now also reaches org_unit) their region, role and org path. So the
 * lane has an identity; it just is not a session.
 *
 * ZERO extra queries: every field comes off the token→teammate→org_unit join
 * `requireOAuthBearer` already runs. Pass it the value it returned.
 *
 * WHAT THIS DOES NOT COVER: `requireOAuthBearer`'s own lookup necessarily runs
 * BEFORE any identity exists — on `oauth_token`, joined to `teammate` and
 * `org_unit` to resolve the identity it is about to set. All three are
 * RLS-ENABLED, and a non-owner is filtered by ENABLE alone regardless of any
 * FORCE phase, so that read is viable only because all three are IN server/db/rls-bootstrap.ts::RLS_BOOTSTRAP_TABLES and are
 * explicitly DISABLEd before the role switch. Nothing here changes that — this
 * helper covers the handler's OWN work, after the credential has been resolved.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { getDb } from './index'
import { withRlsContext, applyRlsContext, rlsRoleFor, type RlsContext } from './rls'

type Tx = PostgresJsDatabase<typeof schema>

/**
 * The identity a machine credential resolves to. Structurally a subset of
 * `BearerTeammate` (server/auth/oauth-bearer.ts) so a caller can pass that
 * value straight through, but declared independently so a future
 * non-OAuth machine credential can satisfy it too.
 */
export interface MachineIdentity {
  teammateId: string
  regionId: string
  orgPath: string
  role: string
}

function contextFor(identity: MachineIdentity): RlsContext {
  // Fail CLOSED on an empty org path (CORE-2, same guard as server/utils/mcp.ts's
  // rlsContextFor): '' is the universal ltree ancestor, so `cou.path <@ ''::ltree`
  // is TRUE for every row and every manager-scope predicate becomes unbounded.
  // An absent path must deny, never widen.
  if (!identity.orgPath) {
    throw new Error(
      `Teammate ${identity.teammateId} has no org_unit path — refusing to build an RLS context`,
    )
  }
  return {
    userRegionId: identity.regionId,
    userOrgPath: identity.orgPath,
    userRole: rlsRoleFor(identity.role),
    userTeammateId: identity.teammateId,
  }
}

export async function withMachineRls<T>(
  identity: MachineIdentity,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withRlsContext(getDb(), contextFor(identity), fn)
}

/**
 * The same lane, for the caller that cannot know its identity until the
 * transaction is already open.
 *
 * `setup/redeem.post.ts` DISCOVERS the teammate by consuming a one-time handoff
 * code, and that consume must be the first statement of the same transaction as
 * the credential mint and the audit write — a mid-sequence failure has to roll
 * back to a still-redeemable code rather than brick the device. So it cannot
 * pass an identity in up front. It opens the transaction here, learns who it is,
 * and calls `adopt` before the first statement that touches a policy-bearing
 * table.
 *
 * `adopt` is `SET LOCAL`, so it lasts exactly as long as this transaction.
 * Calling it twice narrows to the last value; never calling it leaves the body
 * running with NO context, which is the same failure an unconverted handler has
 * — so a caller that adopts conditionally must mean it.
 */
export async function withDeferredMachineRls<T>(
  fn: (tx: Tx, adopt: (identity: MachineIdentity) => Promise<void>) => Promise<T>,
): Promise<T> {
  return getDb().transaction(async (tx) => {
    const handle = tx as unknown as Tx
    return fn(handle, (identity) => applyRlsContext(handle, contextFor(identity)))
  })
}
