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
import { createError } from 'h3'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { schema } from '../db'
import { lockLiveDevicesOf } from './device-lifecycle'

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
 * Revoke a grant + cascade to its emitting instances. Idempotent: a grant that
 * is already revoked, when this call reads it under lock, is a complete no-op.
 *
 * `grant` is the caller's pre-lock snapshot and is used only to find the rows.
 * Whether to act is decided on the grant row as it is AFTER the locks: a
 * re-provision can rotate this grant out while we wait for its device, and a
 * decision from the snapshot would then end the reused device and (mig 0141)
 * revoke its replacement credential.
 */
export async function revokeGrant(db: Db, grant: RevokableGrant): Promise<GrantRevokeResult> {
  const now = new Date()
  const isEmit = grantIsEmit(grant.scope)

  // 1. Locks, in the order every path takes them: device, then emit_handoff,
  // then oauth_token (see consumeEmitHandoff). Token-then-device deadlocks
  // against a concurrent redeem, re-provision or admin end of the device.
  // Legacy emit grants (instance_id NULL, pre-0031) have no per-device link and
  // cover the teammate's live devices, locked in the shared multi-device order
  // (server/utils/device-lifecycle.ts).
  if (isEmit && grant.instanceId) {
    await db.execute(sql`
      SELECT 1 FROM instance_attestation
       WHERE instance_id = ${grant.instanceId}::uuid AND ts_actual_end IS NULL
         FOR UPDATE
    `)
  } else if (isEmit) {
    await lockLiveDevicesOf(db as never, grant.teammateId)
  }
  const current = await db.execute<{ revoked: boolean; teammate_id: string; instance_id: string | null }>(sql`
    SELECT revoked_at IS NOT NULL AS revoked, teammate_id::text AS teammate_id, instance_id::text AS instance_id
      FROM oauth_token WHERE id = ${grant.id}::uuid FOR UPDATE
  `)
  const row = [...current][0]
  if (!row || row.revoked) return { revoked: false, isEmit, instancesEnded: 0 }
  // The snapshot chose which devices to lock and end. If the grant was re-pointed
  // meanwhile (confirm-instance moves a provisional grant to its real teammate),
  // those are the wrong devices and the caller authorised a different grant.
  if (row.teammate_id !== grant.teammateId || row.instance_id !== grant.instanceId) {
    throw createError({ statusCode: 409, statusMessage: 'The grant changed while it was being revoked; reload and retry.' })
  }

  // 2. Revoke↔emission wiring (F3.4): end the emit grant's device only (1:1 via
  // oauth_token.instance_id), or a legacy grant's teammate's live devices.
  let instancesEnded = 0
  if (isEmit) {
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

  // 3. Revoke the token row. A device-bound grant was already revoked by its
  // device ending (mig 0141); this covers unbound ones.
  await db
    .update(schema.oauthToken)
    .set({ revokedAt: now })
    .where(and(eq(schema.oauthToken.id, grant.id), isNull(schema.oauthToken.revokedAt)))

  return { revoked: true, isEmit, instancesEnded }
}
