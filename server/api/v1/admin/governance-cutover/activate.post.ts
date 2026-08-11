/*
 * POST /api/v1/admin/governance-cutover/activate — flips ALL money paths to
 * read governance data authoritatively (ADR-0011 D1/D2), ignoring name/env
 * heuristics from this point on. Only succeeds from a verified preflight; a
 * defensive re-verify runs first (design §8.1). global-finops ONLY.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { activateGovernanceCutover, CutoverError } from '../../../../governance/cutover'

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
      const state = await activateGovernanceCutover(tx, { actorTeammateId: caller.teammateId, ipAddress: ip, userAgent: ua })
      return { status: state.status, activatedAt: state.activatedAt }
    } catch (err) {
      if (err instanceof CutoverError) {
        throw createError({
          statusCode: STATUS_BY_CODE[err.code],
          statusMessage: 'Governance cutover activation failed',
          data: {
            type: 'https://tokenscope.example.com/errors/governance-cutover-activate',
            title: 'Governance cutover activation failed',
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
