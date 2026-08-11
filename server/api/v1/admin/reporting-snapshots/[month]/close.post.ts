/*
 * POST /api/v1/admin/reporting-snapshots/{month}/close — RECORD what this month
 * currently reads.
 *
 * It freezes nothing. Ingestion, provider re-polls and governance recompute all
 * continue on a recorded month exactly as before, and a month that subsequently
 * moves reports the difference against this record. The route it replaced
 * (`/admin/finance-periods/{month}/close`) froze every row's chargeback verdict
 * and needed reopen/restate siblings to get back out; those are deleted.
 *
 * Serialised via the reportingSnapshot advisory lock + SELECT FOR UPDATE, so a
 * snapshot can never record a half-recomputed month. RBAC: admin or
 * global-finops; audited.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { requireRole } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { requireMonthParam } from '../../../../../utils/require-month-param'
import { closeReportingSnapshot, ReportingSnapshotError } from '../../../../../governance/reporting-snapshot'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'global-finops', 'platform-admin')
  assertSameOrigin(event)
  const month = requireMonthParam(event, 'month')
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return withRequestRls(event, async (tx) => {
    try {
      const result = await closeReportingSnapshot(tx, {
        periodMonth: month,
        actorTeammateId: caller.teammateId,
        ipAddress: ip,
        userAgent: ua,
      })
      return result
    } catch (err) {
      if (err instanceof ReportingSnapshotError) {
        throw createError({
          statusCode: 409,
          statusMessage: 'Snapshot already recorded',
          data: {
            type: 'https://tokenscope.example.com/errors/reporting-snapshot-close',
            title: 'Snapshot already recorded',
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
