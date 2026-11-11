/*
 * PATCH /api/v1/me/instances/{instanceId}: name (or un-name) one of YOUR
 * devices (#576). Body `{ name: string | null }`; the name is trimmed, at most
 * 40 characters, and an empty name or null clears it.
 *
 * Owner-scoped exactly as the self-revoke beside it (revoke.post.ts): load the
 * row, and answer 404 if it is missing OR belongs to another teammate, so the
 * route never confirms that someone else's device exists. RLS is inert under
 * the owner connection, so this predicate is the live gate.
 *
 * A purged device (12-month retention) refuses with 409: the purge cleared its
 * personal fields, and naming it would put one back.
 *
 * The name is DISPLAY ONLY (drizzle/migrations/0171): nothing matches or
 * attributes on it. The audit event records that a name was set or cleared and
 * never the name itself, because audit rows are immutable and would otherwise
 * keep a personal field past its purge.
 */
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { and, eq, isNull } from 'drizzle-orm'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { requireAuth } from '../../../../../auth/rbac'
import { schema } from '../../../../../db'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'
import { DeviceRenameBody } from '../../../../../../shared/schemas/device-name'

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const session = await requireAuth(event)
  const sid = requireUuidParam(event, 'instanceId', 'instance id')
  const parsed = await readValidatedBody(event, (b) => DeviceRenameBody.safeParse(b))
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      statusMessage: parsed.error.issues[0]?.message ?? 'Invalid device name',
    })
  }
  const name = parsed.data.name

  await withRequestRls(event, async (tx) => {
    /*
     * ONE STATEMENT decides and writes: only an owned, unpurged row is updated.
     * A read-then-write would let a purge commit in between and the write would
     * put the name back on a purged row, which the purge never revisits.
     */
    const updated = await tx
      .update(schema.instanceAttestation)
      .set({ displayName: name })
      .where(
        and(
          eq(schema.instanceAttestation.instanceId, sid),
          eq(schema.instanceAttestation.teammateId, session.teammateId),
          isNull(schema.instanceAttestation.tsPurged),
        ),
      )
      .returning({ instanceId: schema.instanceAttestation.instanceId })

    if (!updated.length) {
      // Why nothing changed: missing or someone else's (404, no existence leak), or purged (409).
      const [row] = await tx
        .select({ teammateId: schema.instanceAttestation.teammateId })
        .from(schema.instanceAttestation)
        .where(eq(schema.instanceAttestation.instanceId, sid))
        .limit(1)
      if (!row || row.teammateId !== session.teammateId) {
        throw createError({ statusCode: 404, statusMessage: 'Instance not found' })
      }
      throw createError({ statusCode: 409, statusMessage: 'This device is past its retention period and cannot be named' })
    }

    await recordAuditEvent(tx, {
      eventType: 'instance-renamed',
      actorTeammateId: session.teammateId,
      actorSystem: 'me',
      subjectKind: 'instance',
      subjectId: sid,
      // Never the name: see the header.
      payload: { byUser: true, cleared: name === null },
    })
  })

  return { id: sid, display_name: name }
})
