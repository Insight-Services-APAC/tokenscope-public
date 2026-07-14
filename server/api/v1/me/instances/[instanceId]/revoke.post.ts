/*
 * POST /api/v1/me/instances/{instanceId}/revoke — owner-scoped
 * self-service revoke (ADR-0005 decision 3: "dev kills their own
 * instance"). Sets ts_actual_end → /bearer 401s → emission stops → the
 * joiner skips the instance.
 *
 * Owner-scoping is by DASHBOARD SESSION, not token-possession (ADR-0005
 * STRIDE fixes): load the row, and 404 if it's missing OR belongs to a
 * peer (teammate_id !== session.teammateId). We return 404 — NOT 403 —
 * on a peer's instance so we don't leak the existence of a device the
 * caller doesn't own. RLS is inert under the owner connection, so this
 * predicate is the live gate.
 *
 * Idempotency: already-ended → 409 (an explicit user action, unlike the
 * client /end which is silently idempotent). 200 on a fresh revoke.
 */
import { createError, defineEventHandler } from 'h3'
import { eq } from 'drizzle-orm'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { requireAuth } from '../../../../../auth/rbac'
import { getDb, schema } from '../../../../../db'
import { recordAuditEvent } from '../../../../../db/audit'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const session = await requireAuth(event)
  const sid = requireUuidParam(event, 'instanceId', 'instance id')

  const db = getDb()
  const [row] = await db
    .select({
      instanceId: schema.instanceAttestation.instanceId,
      teammateId: schema.instanceAttestation.teammateId,
      tsActualEnd: schema.instanceAttestation.tsActualEnd,
    })
    .from(schema.instanceAttestation)
    .where(eq(schema.instanceAttestation.instanceId, sid))
    .limit(1)

  // Not found OR not the caller's → 404. Do NOT leak a peer's instance
  // existence with a 403.
  if (!row || row.teammateId !== session.teammateId) {
    throw createError({ statusCode: 404, statusMessage: 'Instance not found' })
  }

  if (row.tsActualEnd) {
    throw createError({ statusCode: 409, statusMessage: 'Instance already revoked' })
  }

  await db
    .update(schema.instanceAttestation)
    .set({ tsActualEnd: new Date() })
    .where(eq(schema.instanceAttestation.instanceId, sid))

  await recordAuditEvent(db, {
    eventType: 'instance-revoked',
    actorTeammateId: session.teammateId,
    actorSystem: 'me',
    subjectKind: 'instance',
    subjectId: sid,
    payload: { byUser: true, actorEmail: session.email },
  })

  return { id: sid, revoked: true }
})
