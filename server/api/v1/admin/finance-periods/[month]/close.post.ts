/*
 * POST /api/v1/admin/finance-periods/{month}/close — freeze every open
 * actual_spend row's chargeback verdict for this calendar month, after a
 * final recompute against CURRENT governance (design §4.1/§8.4). Serialised
 * via the financePeriod advisory lock + SELECT FOR UPDATE
 * (server/governance/finance-period.ts). RBAC: admin or global-finops
 * (mirrors the reconciliation-provider admin surface); audited.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { requireRole } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { requireMonthParam } from '../../../../../utils/require-month-param'
import { closeFinancePeriod, FinancePeriodError } from '../../../../../governance/finance-period'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin', 'global-finops')
  assertSameOrigin(event)
  const month = requireMonthParam(event, 'month')
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return withRequestRls(event, async (tx) => {
    try {
      const result = await closeFinancePeriod(tx, {
        periodMonth: month,
        actorTeammateId: caller.teammateId,
        ipAddress: ip,
        userAgent: ua,
      })
      return result
    } catch (err) {
      if (err instanceof FinancePeriodError) {
        throw createError({
          statusCode: 409,
          statusMessage: 'Finance period close failed',
          data: {
            type: 'https://tokenscope.example.com/errors/finance-period-close',
            title: 'Finance period close failed',
            status: 409,
            detail: err.message,
            code: err.code,
          },
        })
      }
      throw err
    }
  })
})
