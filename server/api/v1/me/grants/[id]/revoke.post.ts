/*
 * POST /api/v1/me/grants/{id}/revoke — owner-scoped self-service grant revoke.
 * Design doc §Grant lifecycle & consent management (F3b.1, F3.4).
 *
 * This is the USER path to "log a client out / stop this device emitting". It is
 * NOT the RFC-7009 /oauth/revoke endpoint — that one needs client creds + the
 * raw token (the wrong shape for a logged-in user clicking Revoke in the
 * browser). Here the cookie session IS the auth.
 *
 * Security:
 *   - assertSameOrigin — this is the cookie-bearing browser path, so it MUST
 *     carry the CSRF Origin check (same as me/instances/{id}/revoke).
 *   - Owner-scoping by DASHBOARD SESSION, not token possession: load the row,
 *     and 404 (NOT 403) if it's missing OR belongs to a peer
 *     (teammate_id !== session.teammateId). 404 so we don't leak the existence
 *     of a grant the caller doesn't own (no existence oracle). RLS is inert
 *     under the owner connection, so this predicate is the live gate.
 *
 * Effect (revokeGrant, shared with the admin path):
 *   - Sets revoked_at = now() on the grant.
 *   - Revoke↔emission wiring (F3.4): an EMIT-scoped grant ALSO ends the
 *     teammate's live instance_attestation rows (ts_actual_end = now()), so the
 *     went-silent detector sees EXPECTED silence. Recorded attribution is not
 *     stranded (the join is on the instance, not the token).
 *
 * Idempotency: re-revoking an already-revoked own grant returns 200 with
 * revoked:false (a benign no-op — unlike the instance revoke's 409, a user
 * clicking Revoke twice on a stale list shouldn't error).
 */
import { createError, defineEventHandler } from 'h3'
import { eq } from 'drizzle-orm'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { requireAuth } from '../../../../../auth/rbac'
import { getDb, schema } from '../../../../../db'
import { recordAuditEvent } from '../../../../../db/audit'
import { revokeGrant } from '../../../../../utils/grant-revoke'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const session = await requireAuth(event)
  const id = requireUuidParam(event, 'id', 'grant id')

  const db = getDb()
  const [row] = await db
    .select({
      id: schema.oauthToken.id,
      teammateId: schema.oauthToken.teammateId,
      scope: schema.oauthToken.scope,
      revokedAt: schema.oauthToken.revokedAt,
      instanceId: schema.oauthToken.instanceId,
    })
    .from(schema.oauthToken)
    .where(eq(schema.oauthToken.id, id))
    .limit(1)

  // Not found OR not the caller's → 404. Do NOT leak a peer's grant existence
  // with a 403.
  if (!row || row.teammateId !== session.teammateId) {
    throw createError({ statusCode: 404, statusMessage: 'Grant not found' })
  }

  const result = await revokeGrant(db, row)

  await recordAuditEvent(db, {
    eventType: 'grant-revoked',
    actorTeammateId: session.teammateId,
    actorSystem: 'me',
    subjectKind: 'grant',
    subjectId: id,
    payload: {
      byUser: true,
      actorEmail: session.email,
      isEmit: result.isEmit,
      instancesEnded: result.instancesEnded,
      alreadyRevoked: !result.revoked,
    },
  })

  return { id, revoked: result.revoked, is_emit: result.isEmit, instances_ended: result.instancesEnded }
})
