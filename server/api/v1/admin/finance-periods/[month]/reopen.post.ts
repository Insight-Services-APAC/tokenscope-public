/*
 * POST /api/v1/admin/finance-periods/{month}/reopen { reason } — reopens a
 * closed period so it becomes ordinarily-recomputable again. Does NOT itself
 * recompute (design §4.1). Audited with a mandatory reason.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { z } from 'zod'
import { requireRole } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { readValidated } from '../../../../../utils/validated-body'
import { requireMonthParam } from '../../../../../utils/require-month-param'
import { reopenFinancePeriod, FinancePeriodError } from '../../../../../governance/finance-period'

const Body = z.object({ reason: z.string().min(3).max(2000) })

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin', 'global-finops')
  assertSameOrigin(event)
  const month = requireMonthParam(event, 'month')
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return withRequestRls(event, async (tx) => {
    try {
      return await reopenFinancePeriod(tx, {
        periodMonth: month,
        actorTeammateId: caller.teammateId,
        reason: body.reason,
        ipAddress: ip,
        userAgent: ua,
      })
    } catch (err) {
      if (err instanceof FinancePeriodError) {
        throw createError({
          statusCode: 409,
          statusMessage: 'Finance period reopen failed',
          data: {
            type: 'https://tokenscope.example.com/errors/finance-period-reopen',
            title: 'Finance period reopen failed',
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
