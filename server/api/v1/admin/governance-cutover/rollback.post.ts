/*
 * POST /api/v1/admin/governance-cutover/rollback { reason } — reverts to the
 * legacy heuristic path. Only allowed while ACTIVATED and before any closed
 * period has used the new regime (design: "allowed only before any closed
 * period uses the new regime"). global-finops ONLY.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { readValidated } from '../../../../utils/validated-body'
import { rollbackGovernanceCutover, CutoverError } from '../../../../governance/cutover'

const STATUS_BY_CODE: Record<CutoverError['code'], number> = {
  'wrong-state': 409,
  'mixed-enterprise': 422,
  'verify-failed': 422,
  'closed-period-since-activation': 409,
}

const Body = z.object({
  reason: z.string().min(3).max(2000),
})

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'global-finops')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return withRequestRls(event, async (tx) => {
    try {
      const state = await rollbackGovernanceCutover(tx, {
        actorTeammateId: caller.teammateId,
        reason: body.reason,
        ipAddress: ip,
        userAgent: ua,
      })
      return { status: state.status, rolledBackAt: state.rolledBackAt }
    } catch (err) {
      if (err instanceof CutoverError) {
        throw createError({
          statusCode: STATUS_BY_CODE[err.code],
          statusMessage: 'Governance cutover rollback failed',
          data: {
            type: 'https://tokenscope.example.com/errors/governance-cutover-rollback',
            title: 'Governance cutover rollback failed',
            status: STATUS_BY_CODE[err.code],
            detail: err.message,
            code: err.code,
            details: err.details,
          },
        })
      }
      throw err
    }
  })
})
