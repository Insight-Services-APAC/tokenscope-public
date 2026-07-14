/*
 * POST /api/v1/instances/{instanceId}/end — close a session.
 *
 * Per api-and-connector-interfaces.md §1.3. Auth via an OAuth `tokenscope.emit`
 * Bearer (same scheme as /bearer, OAuth-only). The bound teammate must OWN the
 * instance. Sets ts_actual_end; further /bearer refreshes 401.
 */
import { createError, defineEventHandler, getRouterParam, setResponseStatus } from 'h3'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb, schema } from '../../../../db'
import { requireOAuthBearer } from '../../../../auth/oauth-bearer'
import { recordAuditEvent } from '../../../../db/audit'

const SidSchema = z.string().uuid()

export default defineEventHandler(async (event) => {
  // safeParse → 400 (AUTH-7): a bare .parse throws a raw ZodError → 500.
  const parsed = SidSchema.safeParse(getRouterParam(event, 'instanceId'))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid instance id' })
  }
  const sid = parsed.data

  const db = getDb()

  // OAuth-only re-auth FIRST (AUTH-7 — no unauthenticated existence oracle): an
  // unauthenticated caller gets 401 for existing and non-existing ids alike.
  const teammate = await requireOAuthBearer(event, 'tokenscope.emit', db as never)

  const [row] = await db
    .select({
      instanceId: schema.instanceAttestation.instanceId,
      teammateId: schema.instanceAttestation.teammateId,
      tsActualEnd: schema.instanceAttestation.tsActualEnd,
    })
    .from(schema.instanceAttestation)
    .where(eq(schema.instanceAttestation.instanceId, sid))
    .limit(1)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Session not found' })

  // The emit-scoped Bearer's teammate must own this instance.
  if (!row.teammateId || row.teammateId !== teammate.teammateId) {
    throw createError({
      statusCode: 403,
      statusMessage: 'This credential does not own the requested instance',
    })
  }

  if (row.tsActualEnd) {
    // Idempotent — already ended.
    setResponseStatus(event, 204)
    return null
  }

  await db
    .update(schema.instanceAttestation)
    .set({ tsActualEnd: new Date() })
    .where(eq(schema.instanceAttestation.instanceId, sid))

  await recordAuditEvent(db, {
    eventType: 'session-ended',
    actorTeammateId: row.teammateId,
    actorSystem: 'attestation-api',
    subjectKind: 'session',
    subjectId: sid,
    payload: { reason: 'client-end' },
  })

  setResponseStatus(event, 204)
  return null
})
