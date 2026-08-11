/*
 * PUT /api/v1/me/personal-subscription { tool, subscriptionType, monthlyCostUsd }
 * — declare (or edit) a personal-subscription contract for one tool (ADR-0011
 * D3/D4, design §4.3). Self-service, teammate-scoped, audited. Upsert: an
 * existing ACTIVE declaration for the same tool is updated in place
 * (declaredAt is preserved — editing is not re-declaring); otherwise a new
 * declaration is created.
 *
 * NEVER auto-classifies: this endpoint is the ONLY way a declaration is
 * created — no worker/heuristic may insert one on a teammate's behalf. The
 * declaration is §A provenance only; provider-backed §B verdicts never read it.
 */
import { defineEventHandler, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth } from '../../../auth/rbac'
import { assertSameOrigin } from '../../../auth/csrf'
import { withRequestRls } from '../../../db/request-rls'
import { readValidated } from '../../../utils/validated-body'
import { recordAuditEvent } from '../../../db/audit'
import { advisoryXactLock } from '../../../db/advisory-lock'
import {
  personalSubscriptionLockKey,
  resolvePersonalSubscriptionPrompts,
} from '../../../governance/personal-subscription'
import { CLAUDE_FAMILY_TOOLS } from '../../../../shared/usage/surface'

const Body = z.object({
  tool: z.string().refine((t) => (CLAUDE_FAMILY_TOOLS as readonly string[]).includes(t), {
    message: `tool must be one of: ${CLAUDE_FAMILY_TOOLS.join(', ')}`,
  }),
  subscriptionType: z.string().min(2).max(100),
  monthlyCostUsd: z.number().min(0).max(99999.99),
})

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return withRequestRls(event, async (tx) => {
    await tx.execute(
      advisoryXactLock(
        'personalSubscription',
        personalSubscriptionLockKey({ teammateId: session.teammateId, tool: body.tool }),
      ),
    )
    const existing = await tx.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM personal_subscription_declaration
      WHERE teammate_id = ${session.teammateId}::uuid AND tool = ${body.tool} AND revoked_at IS NULL
    `)
    const cur = existing[0]

    if (cur) {
      await tx.execute(sql`
        UPDATE personal_subscription_declaration
        SET subscription_type = ${body.subscriptionType}, monthly_cost_usd = ${body.monthlyCostUsd.toFixed(2)}::numeric
        WHERE id = ${cur.id}::uuid
      `)
      await recordAuditEvent(tx, {
        eventType: 'personal-subscription-updated',
        actorTeammateId: session.teammateId,
        subjectKind: 'personal_subscription_declaration',
        subjectId: cur.id,
        payload: { tool: body.tool, subscriptionType: body.subscriptionType, monthlyCostUsd: body.monthlyCostUsd },
        ipAddress: ip,
        userAgent: ua,
      })
      await resolvePersonalSubscriptionPrompts(tx, { teammateId: session.teammateId, tool: body.tool })
      return { id: cur.id, tool: body.tool, updated: true }
    }

    const [created] = await tx.execute<{ id: string }>(sql`
      INSERT INTO personal_subscription_declaration (teammate_id, tool, subscription_type, monthly_cost_usd)
      VALUES (${session.teammateId}::uuid, ${body.tool}, ${body.subscriptionType}, ${body.monthlyCostUsd.toFixed(2)}::numeric)
      RETURNING id::text AS id
    `)
    await recordAuditEvent(tx, {
      eventType: 'personal-subscription-declared',
      actorTeammateId: session.teammateId,
      subjectKind: 'personal_subscription_declaration',
      subjectId: created!.id,
      payload: { tool: body.tool, subscriptionType: body.subscriptionType, monthlyCostUsd: body.monthlyCostUsd },
      ipAddress: ip,
      userAgent: ua,
    })
    await resolvePersonalSubscriptionPrompts(tx, { teammateId: session.teammateId, tool: body.tool })
    return { id: created!.id, tool: body.tool, updated: false }
  })
})
