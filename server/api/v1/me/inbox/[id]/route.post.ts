/*
 * POST /api/v1/me/inbox/{id}/route — forward an inbox item to another
 * recipient.
 *
 * Inserts a new inbox_item row addressed to the target recipient with
 * the same category + severity + body; marks the source item
 * `ack_state = 'resolved'` with the audit trail noting the forward.
 *
 * Common use: an over-budget alert routed to the wrong manager gets
 * forwarded to the correct one; admin re-routes a sync-conflict to the
 * right SRE.
 */
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { eq, sql } from 'drizzle-orm'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { requireRole, requireRegionScope } from '../../../../../auth/rbac'
import { withRequestRls } from '../../../../../db/request-rls'
import { InboxRouteBody } from '../../../../../../shared/schemas/inbox'
import { getDb, schema } from '../../../../../db'
import { recordAuditEvent } from '../../../../../db/audit'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'

interface SourceRow extends Record<string, unknown> {
  id: string
  category: string
  severity: string
  subject: string
  body: unknown
  related_entity_kind: string | null
  related_entity_id: string | null
  region_id: string
}

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  // Admin-only. NOTE: RLS is inert in every deployed environment (no FORCE
  // ROW LEVEL SECURITY; the app connects as the table owner), so the
  // inbox_item `FOR ALL` policy never actually executes — this requireRole,
  // plus the explicit requireRegionScope calls below on BOTH the source
  // item's recipient and the forward target, are the live gates, not RLS.
  const session = await requireRole(event, 'admin', 'global-finops')
  const sourceId = requireUuidParam(event, 'id', 'inbox item id')
  const body = await readValidatedBody(event, (data) => InboxRouteBody.parse(data))

  // Read the source inside the RLS context — admins bypass via role.
  const sources = await withRequestRls(event, async (tx) =>
    tx.execute<SourceRow>(sql`
      SELECT ii.id::text AS id, ii.category, ii.severity, ii.subject, ii.body,
             ii.related_entity_kind, ii.related_entity_id::text AS related_entity_id,
             t.region_id::text AS region_id
      FROM inbox_item ii
      JOIN teammate t ON t.id = ii.recipient_teammate_id
      WHERE ii.id = ${sourceId}::uuid
      LIMIT 1
    `),
  )
  const source = sources[0]
  if (!source) {
    throw createError({ statusCode: 404, statusMessage: 'Inbox item not found' })
  }
  // Region-scope the SOURCE: a region admin may only read (and therefore
  // forward) an item addressed to a recipient in their own region. Applied
  // only after the 404 above, so an unresolvable id still 404s and this
  // endpoint never becomes an existence oracle for other regions' item ids.
  await requireRegionScope(event, source.region_id)

  // Validate the target teammate is active. Forwarding to a deactivated
  // teammate creates an item that nobody can resolve (and may leak to
  // their RBAC replacement).
  const db = getDb()
  const [target] = await db
    .select({
      id: schema.teammate.id,
      isActive: schema.teammate.isActive,
      regionId: schema.teammate.regionId,
    })
    .from(schema.teammate)
    .where(eq(schema.teammate.id, body.recipient_teammate_id))
    .limit(1)
  if (!target) {
    throw createError({ statusCode: 404, statusMessage: 'Target teammate not found' })
  }
  // Region-scope the TARGET: stops the mirror-image leak — a region-A admin
  // injecting a forwarded item into region B. Same 404-before-403 ordering.
  await requireRegionScope(event, target.regionId)
  if (!target.isActive) {
    throw createError({
      statusCode: 422,
      statusMessage: 'Target teammate is inactive',
      data: {
        type: 'https://tokenscope.example.com/errors/inactive-teammate',
        title: 'Cannot forward inbox item to inactive teammate',
        status: 422,
        detail:
          `Teammate ${body.recipient_teammate_id} is is_active=false. ` +
          'Pick an active teammate or reactivate the target first.',
      },
    })
  }

  // Insert outside RLS — the new recipient isn't this session's user.
  // ONE transaction for the forward + resolve + audit (API-2): a partial
  // failure would otherwise leave a forwarded copy with the source still
  // open (double-forwarding) or an unaudited cross-recipient insert.
  const forwardedId = await db.transaction(async (tx) => {
    const [forwarded] = await tx
      .insert(schema.inboxItem)
      .values({
        recipientTeammateId: body.recipient_teammate_id,
        category: source.category,
        severity: source.severity,
        subject: `[Forwarded] ${source.subject}`,
        body: {
          forwarded_from_teammate_id: session.teammateId,
          forwarded_from_inbox_item_id: source.id,
          reason: body.reason ?? null,
          original_body: source.body,
        },
        relatedEntityKind: source.related_entity_kind,
        relatedEntityId: source.related_entity_id,
      })
      .returning({ id: schema.inboxItem.id })

    // Mark source resolved.
    await tx.execute(sql`
      UPDATE inbox_item
      SET ack_state = 'resolved', ack_at = NOW(), ack_by = ${session.teammateId}::uuid
      WHERE id = ${sourceId}::uuid
    `)

    await recordAuditEvent(tx as never, {
      eventType: 'inbox-routed',
      actorTeammateId: session.teammateId,
      actorSystem: 'inbox',
      subjectKind: 'inbox_item',
      subjectId: sourceId,
      payload: {
        forwarded_to_teammate_id: body.recipient_teammate_id,
        new_inbox_item_id: forwarded?.id ?? null,
        reason: body.reason ?? null,
      },
    })

    return forwarded?.id ?? null
  })

  return { source_id: sourceId, forwarded_id: forwardedId }
})
