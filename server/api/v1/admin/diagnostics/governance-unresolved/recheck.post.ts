/*
 * POST /api/v1/admin/diagnostics/governance-unresolved/recheck — an explicit,
 * on-demand resweep of the governance-key backlog (design §8.4: "Every
 * unresolved/unknown state has an explicit recheck action"). Runs ONE bounded
 * batch of the same resolution logic the governance-key-backfill worker uses,
 * inline, so an operator who just registered/linked the missing org sees the
 * effect immediately rather than waiting for the next cron tick.
 *
 * RBAC: global-finops (write-adjacent — triggers a bulk UPDATE, though a
 * read-only/idempotent one). CSRF-guarded. Audited (a bulk UPDATE on money
 * rows is consequential even when every change is a resolution, not a
 * verdict flip).
 */
import { defineEventHandler, getRequestIP, getHeader } from 'h3'
import { requireRole } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { runGovernanceKeyBackfill } from '../../../../../workers/governance-key-backfill'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'global-finops')
  assertSameOrigin(event)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return withRequestRls(event, async (tx) => {
    const result = await runGovernanceKeyBackfill(tx)
    await recordAuditEvent(tx, {
      eventType: 'governance-unresolved-recheck',
      actorTeammateId: caller.teammateId,
      subjectKind: 'governance_key_backfill',
      subjectId: null,
      payload: result,
      ipAddress: ip,
      userAgent: ua,
    })
    return result
  })
})
