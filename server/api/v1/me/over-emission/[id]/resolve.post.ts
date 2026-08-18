/*
 * POST /api/v1/me/over-emission/{id}/resolve  { action, conversation_id? } — the developer
 * makes the call on an uncorroborated over-emission (OTel > provider API truth):
 *   - action 'quarantine' (+ conversation_id): "this session is the forgery" → write it to
 *     session_quarantine (reason='api-uncorroborated'), which EXCLUDES it from the dev's
 *     usage; the next detector run recomputes the over down. The dev picks the session
 *     (the API has no session ids — the system never auto-picks).
 *   - action 'accept': "this OTel is real despite the bill lag" → acknowledge, keep counting.
 *   - action 'escalate': hand it to the region admin (audit + state) for investigation.
 *
 * docs/design/provider-billing-attribution-model.md §A + ADR-0010 rule 2 / ADR-0008.
 */
import { createError, defineEventHandler, readValidatedBody, getRouterParam } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { OVER_EMISSION_REASON_API_UNCORROBORATED } from '../../../../../usage/over-emission-detection'

const Body = z
  .object({
    action: z.enum(['quarantine', 'accept', 'escalate']),
    conversation_id: z.string().min(1).max(256).optional(),
  })
  .refine((b) => b.action !== 'quarantine' || !!b.conversation_id, {
    message: 'quarantine requires conversation_id (the suspect session you are flagging).',
  })

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const session = await requireAuth(event)
  const idParsed = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!idParsed.success) throw createError({ statusCode: 400, statusMessage: 'Invalid flag id' })
  const id = idParsed.data
  const body = await readValidatedBody(event, (d) => Body.parse(d))

  // withRequestRls IS the transaction — the ownership FOR UPDATE, the quarantine
  // write, the flag UPDATE and the audit stay atomic, and now every statement in
  // them carries the caller's RLS identity (over_emission is a phase-1 FORCE
  // table; see docs/design/rls-enforcement.md §Rollout).
  return await withRequestRls(event, async (tx) => {
    // Ownership + open-state (explicit teammate filter). over_usd is the watermark we stamp
    // so a later, materially-larger forgery re-opens the flag (the detector compares).
    //
    // The lane filter is part of ownership, not a nicety: a 'no-bill-to-corroborate'
    // row (mig 0132) is never listed to the developer, so it has no id they were
    // given — but ids are guessable-shaped and this route takes one from the URL.
    // Resolving one would let a lane with no review semantics acquire a resolution,
    // a watermark and an audit trail claiming the developer answered for it. Not
    // listed, not resolvable: it 404s exactly like someone else's flag.
    const flagRows = await tx.execute<{ state: string; over_usd: string }>(sql`
      SELECT state, over_usd::text AS over_usd FROM over_emission
      WHERE id = ${id}::uuid AND teammate_id = ${session.teammateId}::uuid
        AND reason = ${OVER_EMISSION_REASON_API_UNCORROBORATED}
      FOR UPDATE
    `)
    const flag = [...flagRows][0]
    if (!flag) throw createError({ statusCode: 404, statusMessage: 'Flag not found or not yours' })
    if (flag.state !== 'open') throw createError({ statusCode: 409, statusMessage: 'Flag already resolved' })
    const watermark = flag.over_usd

    if (body.action === 'quarantine') {
      // Derive the conversation's context from the dev's own ledger (unspoofable join).
      const convRows = await tx.execute<{
        instance_id: string; region_id: string; org_unit_id: string
        ts_start: string; ts_end: string; cost_usd: string; tokens: string
      }>(sql`
        SELECT MAX(ar.instance_id::text) AS instance_id, MAX(ar.region_id::text) AS region_id,
               MAX(ar.org_unit_id::text) AS org_unit_id,
               MIN(ar.ts_event)::text AS ts_start, MAX(ar.ts_event)::text AS ts_end,
               SUM(ar.cost_usd)::text AS cost_usd, SUM(ar.tokens)::text AS tokens
        FROM attribution_record ar
        WHERE ar.teammate_id = ${session.teammateId}::uuid
          AND COALESCE(ar.claude_session_id, ar.instance_id::text) = ${body.conversation_id}
      `)
      const conv = [...convRows][0]
      if (!conv || !conv.instance_id) {
        throw createError({ statusCode: 404, statusMessage: 'That conversation is not in your usage' })
      }
      // Quarantine the suspect session (reason='api-uncorroborated' → excluded from usage).
      await tx.execute(sql`
        INSERT INTO session_quarantine
          (conversation_id, instance_id, teammate_id, region_id, org_unit_id,
           session_ts_start, session_ts_end, instance_ts_start, cost_usd, tokens, reason)
        SELECT ${body.conversation_id}, ${conv.instance_id}::uuid, ${session.teammateId}::uuid,
               ${conv.region_id}::uuid, ${conv.org_unit_id}::uuid,
               ${conv.ts_start}::timestamptz, ${conv.ts_end}::timestamptz,
               COALESCE(ia.ts_start, ${conv.ts_start}::timestamptz),
               ${conv.cost_usd}::numeric, ${conv.tokens}::bigint, 'api-uncorroborated'
        FROM instance_attestation ia WHERE ia.instance_id = ${conv.instance_id}::uuid
        ON CONFLICT (conversation_id, instance_id) DO UPDATE SET
          reason = 'api-uncorroborated', resolved_at = NULL, updated_at = now()
      `)
      await tx.execute(sql`
        UPDATE over_emission SET state = 'quarantined', quarantined_conversation_id = ${body.conversation_id},
          resolved_at = now(), resolved_by = ${session.teammateId}::uuid, resolved_over_usd = ${watermark}::numeric
        WHERE id = ${id}::uuid
      `)
    } else {
      // accept | escalate — record the decision; no quarantine write.
      await tx.execute(sql`
        UPDATE over_emission SET state = ${body.action === 'accept' ? 'accepted' : 'escalated'},
          resolved_at = now(), resolved_by = ${session.teammateId}::uuid, resolved_over_usd = ${watermark}::numeric
        WHERE id = ${id}::uuid
      `)
    }

    await recordAuditEvent(tx, {
      eventType: 'over-emission-resolved',
      actorTeammateId: session.teammateId,
      subjectKind: 'over-emission',
      subjectId: id,
      payload: { action: body.action, ...(body.conversation_id ? { conversation_id: body.conversation_id } : {}) },
    })

    return { id, state: body.action === 'quarantine' ? 'quarantined' : body.action === 'accept' ? 'accepted' : 'escalated' }
  })
})
