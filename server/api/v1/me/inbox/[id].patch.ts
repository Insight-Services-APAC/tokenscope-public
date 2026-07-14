/*
 * PATCH /api/v1/me/inbox/{id} — change ack state on one's own inbox item.
 *
 * Allowed transitions are open → any of {read, acknowledged, dismissed,
 * resolved}; resolved/dismissed → reopen by setting unread (admin escape
 * hatch, but for now we accept any transition; data-model.md doesn't
 * enforce a state machine).
 *
 * Only the recipient can ack their own item (RLS + explicit check).
 */
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { sql } from 'drizzle-orm'
import { assertSameOrigin } from '../../../../auth/csrf'
import { requireAuth } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { InboxPatchBody } from '../../../../../shared/schemas/inbox'
import { getDb } from '../../../../db'
import { recordAuditEvent } from '../../../../db/audit'
import { requireUuidParam } from '../../../../utils/require-uuid-param'

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const session = await requireAuth(event)
  const id = requireUuidParam(event, 'id', 'inbox item id')
  const body = await readValidatedBody(event, (data) => InboxPatchBody.parse(data))

  const updated = await withRequestRls(event, async (tx) =>
    tx.execute<{ id: string }>(sql`
      UPDATE inbox_item
      SET ack_state = ${body.ack_state},
          ack_at = NOW(),
          ack_by = ${session.teammateId}::uuid
      WHERE id = ${id}::uuid
        AND recipient_teammate_id = ${session.teammateId}::uuid
      RETURNING id::text AS id
    `),
  )

  if (updated.length === 0) {
    throw createError({ statusCode: 404, statusMessage: 'Inbox item not found' })
  }

  await recordAuditEvent(getDb(), {
    eventType: 'inbox-acked',
    actorTeammateId: session.teammateId,
    actorSystem: 'inbox',
    subjectKind: 'inbox_item',
    subjectId: id,
    payload: { ack_state: body.ack_state },
  })

  return { id, ack_state: body.ack_state }
})
