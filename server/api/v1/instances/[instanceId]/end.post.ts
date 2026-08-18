/*
 * POST /api/v1/instances/{instanceId}/end — close a session.
 *
 * Per api-and-connector-interfaces.md §1.3. Auth via an OAuth `tokenscope.emit`
 * Bearer (same scheme as /bearer, OAuth-only). The bound teammate must OWN the
 * instance. Sets ts_actual_end; further /bearer refreshes 401.
 *
 * LANE: machine (docs/design/rls-enforcement.md §2). No cookie session, so
 * `withRequestRls` cannot serve it; the emit credential resolves the identity
 * and `withMachineRls` carries it. The audit INSERT in particular has to run
 * under a context — it is §4's class, and under FORCE a context-less one errors
 * AFTER the instance has already been ended.
 */
import { createError, defineEventHandler, getRouterParam, setResponseStatus } from 'h3'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb, schema } from '../../../../db'
import { withMachineRls } from '../../../../db/machine-rls'
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

  // OAuth-only re-auth FIRST (AUTH-7 — no unauthenticated existence oracle): an
  // unauthenticated caller gets 401 for existing and non-existing ids alike.
  // Instance-bound (sid) so a DIFFERENT instance's emit credential 401s here
  // instead of degrading to a per-teammate check. This is the BOOTSTRAP read,
  // on `oauth_token` — in server/db/rls-bootstrap.ts::RLS_BOOTSTRAP_TABLES and DISABLEd at cutover. Not "kept out of FORCE":
  // ENABLE alone filters a non-owner, so omission would protect nothing.
  const teammate = await requireOAuthBearer(event, 'tokenscope.emit', getDb() as never, sid)

  // ONE machine-lane transaction: read → own-or-404 → end → audit.
  await withMachineRls(teammate, async (tx) => {
    const [row] = await tx
      .select({
        instanceId: schema.instanceAttestation.instanceId,
        teammateId: schema.instanceAttestation.teammateId,
        tsActualEnd: schema.instanceAttestation.tsActualEnd,
      })
      .from(schema.instanceAttestation)
      .where(eq(schema.instanceAttestation.instanceId, sid))
      .limit(1)

    // Not-found AND not-owned collapse to the SAME 404 (mirrors /bearer, /health,
    // and me/instances/[instanceId]/revoke.post.ts).
    if (!row || !row.teammateId || row.teammateId !== teammate.teammateId) {
      throw createError({ statusCode: 404, statusMessage: 'Instance not found' })
    }

    // Idempotent — already ended, nothing to write.
    if (row.tsActualEnd) return

    await tx
      .update(schema.instanceAttestation)
      .set({ tsActualEnd: new Date() })
      .where(eq(schema.instanceAttestation.instanceId, sid))

    await recordAuditEvent(tx, {
      eventType: 'session-ended',
      actorTeammateId: row.teammateId,
      actorSystem: 'attestation-api',
      subjectKind: 'session',
      subjectId: sid,
      payload: { reason: 'client-end' },
    })
  })

  setResponseStatus(event, 204)
  return null
})
