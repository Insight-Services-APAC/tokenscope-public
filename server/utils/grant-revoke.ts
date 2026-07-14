/*
 * Shared grant-revoke primitive — used by BOTH the user self-service revoke
 * (POST /api/v1/me/grants/{id}/revoke) and the admin revoke
 * (POST /api/v1/admin/grants/{id}/revoke). One implementation so the
 * revoke↔instance cascade (design doc F3.4) can't drift between the two paths.
 *
 * What it does, given a loaded oauth_token row the caller has ALREADY
 * authorised (owner-scoped for the user path, region-scoped for the admin path —
 * the gate lives in the endpoint, NOT here):
 *
 *   1. Sets `revoked_at = now()` on the grant (idempotent — only flips a live
 *      row; an already-revoked row is left untouched and reported back).
 *   2. Revoke↔emission wiring (F3.4): when the grant carries `tokenscope.emit`,
 *      ALSO ends the grant-OWNER's live instance_attestation rows
 *      (`ts_actual_end = now()` where `ts_actual_end IS NULL`). This makes the
 *      went-silent detector (`instanceLifecycleSilent`) see EXPECTED silence
 *      rather than the went-silent disaster. Attribution already recorded is NOT
 *      stranded — the attribution join is on instance_attestation, not the
 *      token — so recorded spend persists; only FUTURE emission stops.
 *
 * The cascade ends the GRANT's instance, never the actor's — so an admin revoking
 * a developer's emit grant ends the DEVELOPER's device, which is the intent.
 *
 * SCOPING (the multi-device invariant): an emit credential is bound 1:1 to its
 * instance via `oauth_token.instance_id` (mig 0031, set by provision_emit). The
 * cascade ends ONLY that instance — a developer with laptop-A/B/C has a separate
 * emit grant + instance per device, so revoking laptop-A must NOT silence B/C.
 * LEGACY emit grants (setup-token-minted, pre-0031) carry `instance_id = NULL`;
 * for those we fall back to ending the teammate's live instances (the old
 * behaviour) since there's no per-device link to scope by.
 */
import { and, eq, isNull } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { schema } from '../db'

type Db = PostgresJsDatabase<Record<string, unknown>>

export interface RevokableGrant {
  id: string
  teammateId: string
  scope: string
  revokedAt: Date | null
  /** The emit credential's 1:1 instance (mig 0031). NULL = read/tag grant or a legacy emit grant. */
  instanceId: string | null
}

export interface GrantRevokeResult {
  /** True if THIS call flipped revoked_at (false when it was already revoked). */
  revoked: boolean
  /** True if the grant carried tokenscope.emit (cascade applied). */
  isEmit: boolean
  /** instance_attestation rows ended by the emit cascade (this call). */
  instancesEnded: number
}

export function grantIsEmit(scope: string): boolean {
  return scope.split(' ').filter(Boolean).includes('tokenscope.emit')
}

/**
 * Revoke a grant + cascade to its emitting instances. Idempotent: an
 * already-revoked grant is a no-op for the token UPDATE, but the emit cascade
 * still runs (defensively — if a prior revoke flipped the token but the instance
 * end didn't land, this reconverges; ending an already-ended instance is itself
 * a no-op via the `ts_actual_end IS NULL` predicate).
 */
export async function revokeGrant(db: Db, grant: RevokableGrant): Promise<GrantRevokeResult> {
  const now = new Date()
  const isEmit = grantIsEmit(grant.scope)

  // 1. Revoke the token row — only flip a still-live row.
  const alreadyRevoked = grant.revokedAt !== null
  if (!alreadyRevoked) {
    await db
      .update(schema.oauthToken)
      .set({ revokedAt: now })
      .where(and(eq(schema.oauthToken.id, grant.id), isNull(schema.oauthToken.revokedAt)))
  }

  // 2. Revoke↔emission wiring (F3.4) — end the emit grant's instance only.
  // Re-running the cascade on an ALREADY-revoked grant is safe ONLY when it's
  // instance-scoped (it re-ends just its own device). For a legacy NULL-instance
  // grant the cascade is teammate-wide, so re-revoking an already-revoked one
  // would end a SINCE-re-provisioned device — gate that out (R2 F2).
  let instancesEnded = 0
  if (isEmit && (!alreadyRevoked || grant.instanceId)) {
    // 1:1 scope: end ONLY this grant's device (oauth_token.instance_id). Legacy
    // emit grants (instance_id NULL, pre-0031) fall back to the teammate's live
    // instances — there's no per-device link to scope by.
    const target = grant.instanceId
      ? eq(schema.instanceAttestation.instanceId, grant.instanceId)
      : eq(schema.instanceAttestation.teammateId, grant.teammateId)
    const ended = await db
      .update(schema.instanceAttestation)
      .set({ tsActualEnd: now })
      .where(and(target, isNull(schema.instanceAttestation.tsActualEnd)))
      .returning({ instanceId: schema.instanceAttestation.instanceId })
    instancesEnded = ended.length
  }

  return { revoked: !alreadyRevoked, isEmit, instancesEnded }
}
