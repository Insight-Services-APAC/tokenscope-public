/*
 * POST /api/v1/admin/governance-cutover/preflight — compute (or re-verify) the
 * governance cutover preflight: old-verdict snapshot, mixed-enterprise
 * detection, write-both-sides, verify equivalence. Transactional + idempotent
 * (design §8.1). global-finops ONLY — this decides real money's fate estate-
 * wide, deliberately narrower than a region admin's scope.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { preflightGovernanceCutover, CutoverError } from '../../../../governance/cutover'

const STATUS_BY_CODE: Record<CutoverError['code'], number> = {
  'wrong-state': 409,
  'mixed-enterprise': 422,
  'verify-failed': 422,
  'closed-period-since-activation': 409,
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'global-finops')
  assertSameOrigin(event)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return withRequestRls(event, async (tx) => {
    try {
      const result = await preflightGovernanceCutover(tx, { actorTeammateId: caller.teammateId, ipAddress: ip, userAgent: ua })
      return {
        status: result.state.status,
        unitsVerified: result.unitsVerified,
        preflightSnapshot: result.state.preflightSnapshot,
      }
    } catch (err) {
      if (err instanceof CutoverError) {
        throw createError({
          statusCode: STATUS_BY_CODE[err.code],
          statusMessage: 'Governance cutover preflight failed',
          data: {
            type: 'https://tokenscope.example.com/errors/governance-cutover-preflight',
            title: 'Governance cutover preflight failed',
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
