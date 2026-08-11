/*
 * GET /api/v1/admin/finance-periods/{month} — the close/open state for one
 * calendar month (YYYY-MM). Absence of a stored row means open (the implicit
 * default — see server/governance/finance-period.ts).
 */
import { defineEventHandler } from 'h3'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { requireMonthParam } from '../../../../utils/require-month-param'
import { getFinancePeriod } from '../../../../governance/finance-period'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')
  const month = requireMonthParam(event, 'month')
  return withRequestRls(event, async (tx) => {
    const period = await getFinancePeriod(tx, month)
    return period
  })
})
