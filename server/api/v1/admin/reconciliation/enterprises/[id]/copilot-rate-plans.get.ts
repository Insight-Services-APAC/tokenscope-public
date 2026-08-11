/*
 * GET /api/v1/admin/reconciliation/enterprises/{id}/copilot-rate-plans — the
 * effective-dated Copilot rate-plan history for one provider_enterprise
 * (ADR-0011 D9, design §5.3). Newest-starting first, including retired rows
 * (a complete audit trail, not just the live set).
 *
 * RBAC: requireRole(admin, global-finops).
 */
import { defineEventHandler } from 'h3'
import { requireRole } from '../../../../../../auth/rbac'
import { withRequestRls } from '../../../../../../db/request-rls'
import { requireUuidParam } from '../../../../../../utils/require-uuid-param'
import { listCopilotRatePlans } from '../../../../../../governance/copilot-rate-plan'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')
  const id = requireUuidParam(event, 'id', 'provider-enterprise id')
  return withRequestRls(event, async (tx) => {
    const plans = await listCopilotRatePlans(tx, id)
    return { plans, total: plans.length }
  })
})
