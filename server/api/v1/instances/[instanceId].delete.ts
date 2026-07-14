/*
 * DELETE /api/v1/instances/{instanceId} — admin-only force-end.
 *
 * Per api-and-connector-interfaces.md §1.4. Auth via the dashboard
 * session cookie + admin role. Same DB effect as /end but tagged
 * session-admin-deleted in audit_event.
 */
import { createError, defineEventHandler, getRouterParam, setResponseStatus } from 'h3'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { assertSameOrigin } from '../../../auth/csrf'
import { requireRole, requireRegionScope } from '../../../auth/rbac'
import { getDb, schema } from '../../../db'
import { recordAuditEvent } from '../../../db/audit'

const SidSchema = z.string().uuid()

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  // admin (region-scoped) + global-finops (org-wide) — both can revoke an
  // instance from the admin instances view; requireRegionScope below bounds admin.
  const session = await requireRole(event, 'admin', 'global-finops')
  // safeParse → 400 (AUTH-7): a bare .parse throws a raw ZodError → 500.
  const parsed = SidSchema.safeParse(getRouterParam(event, 'instanceId'))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid instance id' })
  }
  const sid = parsed.data

  const db = getDb()
  const [row] = await db
    .select({
      instanceId: schema.instanceAttestation.instanceId,
      tsActualEnd: schema.instanceAttestation.tsActualEnd,
      regionId: schema.instanceAttestation.regionId,
    })
    .from(schema.instanceAttestation)
    .where(eq(schema.instanceAttestation.instanceId, sid))
    .limit(1)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Session not found' })

  // Region-bound the admin to the session's region. RLS's region policy
  // is inert at runtime (owner DB connection), so without this any admin
  // could force-end a session in any region by id.
  await requireRegionScope(event, row.regionId)

  if (!row.tsActualEnd) {
    await db
      .update(schema.instanceAttestation)
      .set({ tsActualEnd: new Date() })
      .where(eq(schema.instanceAttestation.instanceId, sid))
  }

  await recordAuditEvent(db, {
    eventType: 'session-admin-deleted',
    actorTeammateId: session.teammateId,
    actorSystem: 'admin',
    subjectKind: 'session',
    subjectId: sid,
    payload: { adminEmail: session.email },
  })

  setResponseStatus(event, 204)
  return null
})
