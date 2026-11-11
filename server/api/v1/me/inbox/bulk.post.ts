/*
 * POST /api/v1/me/inbox/bulk — change the state of several of one's own inbox
 * items at once (#574).
 *
 * Two shapes (shared/schemas/inbox.ts InboxBulkBody):
 *   - `{ ids, ack_state }`: the rows ticked on /inbox, with Mark read, Resolve
 *     or Dismiss. Only the caller's own items are changed; any other id (another
 *     teammate's, or one that does not exist) comes back in `not_changed`, as
 *     does an item already in that state. Mark read changes only UNREAD items:
 *     it must never reopen a resolved or dismissed one.
 *   - `{ all_unread: { category?, group?, severity? }, ack_state: 'read' }`:
 *     "Mark all read" — every unread item of the caller's matching the page's
 *     filters (server/inbox/filters.ts, the list route's own SQL), including the
 *     ones past the pages loaded so far.
 *
 * One transaction: the UPDATE and one `inbox-acked` audit row per changed item,
 * the same event the single-item PATCH writes, inside withRequestRls (the RLS
 * rule in server/db/audit.ts). Resolve behaves as the single Resolve does: it
 * sets the state, nothing else (an over-budget item is not re-raised for the
 * month either way, budget-alert.ts).
 */
import { defineEventHandler, readBody } from 'h3'
import { sql } from 'drizzle-orm'
import { assertSameOrigin } from '../../../../auth/csrf'
import { requireAuth } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvents } from '../../../../db/audit'
import {
  InboxBulkAllUnreadBody,
  InboxBulkIdsBody,
  type InboxBulkBody,
} from '../../../../../shared/schemas/inbox'
import { failValidation } from '../../../../utils/validated-body'
import { kindFiltersSql } from '../../../../inbox/filters'

export interface InboxBulkResult {
  ack_state: string
  changed: number
  /** Ids mode only: the requested ids that were not changed (not yours, missing, or already in that state). */
  not_changed: string[]
}

export default defineEventHandler(async (event): Promise<InboxBulkResult> => {
  assertSameOrigin(event)
  const session = await requireAuth(event)
  // Validate against the shape the body names (`all_unread` or not), so a 400
  // says which field and rule failed rather than a union's "Invalid input".
  const raw = await readBody(event)
  const schema =
    raw && typeof raw === 'object' && 'all_unread' in (raw as object) ? InboxBulkAllUnreadBody : InboxBulkIdsBody
  const parsed = schema.safeParse(raw)
  if (!parsed.success) failValidation(parsed.error)
  const body = parsed.data as InboxBulkBody
  const me = session.teammateId

  return withRequestRls(event, async (tx) => {
    let changedIds: string[]
    let notChanged: string[] = []

    if ('ids' in body) {
      const ids = [...new Set(body.ids)]
      // Mark read only moves unread items; Resolve and Dismiss move anything
      // not already in that state.
      const stateGuard =
        body.ack_state === 'read' ? sql`ack_state = 'unread'` : sql`ack_state <> ${body.ack_state}`
      const rows = await tx.execute<{ id: string }>(sql`
        UPDATE inbox_item
           SET ack_state = ${body.ack_state}, ack_at = NOW(), ack_by = ${me}::uuid
         WHERE id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
           AND recipient_teammate_id = ${me}::uuid
           AND ${stateGuard}
        RETURNING id::text AS id
      `)
      changedIds = rows.map((r) => r.id)
      const changed = new Set(changedIds)
      notChanged = ids.filter((id) => !changed.has(id))
    } else {
      const rows = await tx.execute<{ id: string }>(sql`
        UPDATE inbox_item i
           SET ack_state = 'read', ack_at = NOW(), ack_by = ${me}::uuid
         WHERE i.recipient_teammate_id = ${me}::uuid
           AND i.ack_state = 'unread'
           ${kindFiltersSql(body.all_unread)}
        RETURNING i.id::text AS id
      `)
      changedIds = rows.map((r) => r.id)
    }

    await recordAuditEvents(
      tx,
      changedIds.map((id) => ({
        eventType: 'inbox-acked',
        actorTeammateId: me,
        actorSystem: 'inbox',
        subjectKind: 'inbox_item',
        subjectId: id,
        payload: { ack_state: body.ack_state, bulk: 'ids' in body ? 'selected' : 'all-unread' },
      })),
    )

    return { ack_state: body.ack_state, changed: changedIds.length, not_changed: notChanged }
  })
})
