/*
 * GET /api/v1/admin/reconciliation/enterprises/{id}/copilot-rate-plans — the
 * effective-dated Copilot rate-plan history for one provider_enterprise
 * (ADR-0011 D9, design §5.3). Newest-starting first, including retired rows
 * (a complete audit trail, not just the live set).
 *
 * RBAC: requireRole(platform-admin).
 */
import { defineEventHandler } from 'h3'
import { requireRole } from '../../../../../../auth/rbac'
import { withRequestRls } from '../../../../../../db/request-rls'
import { requireUuidParam } from '../../../../../../utils/require-uuid-param'
import { listCopilotRatePlans } from '../../../../../../governance/copilot-rate-plan'
import { requestClock } from '../../../../../../utils/request-clock'
import { utcMonthOf } from '../../../../../../../shared/reports/clock'

export default defineEventHandler(async (event) => {
  // Provider configuration is estate config (owner ruling 2026-10-08): a rate plan hangs off a region-less provider_enterprise, so platform-admin is the only clamp.
  await requireRole(event, 'platform-admin')
  const id = requireUuidParam(event, 'id', 'provider-enterprise id')
  return withRequestRls(event, async (tx) => {
    // Status is judged for the current UTC month by the server's clock, never the browser's.
    const plans = await listCopilotRatePlans(tx, id, utcMonthOf(requestClock(event).today))
    return { plans, total: plans.length }
  })
})
