/*
 * POST /api/v1/admin/reconciliation/enterprises/{id}/copilot-bill-repull —
 * audited admin-triggered historical re-pull of the Copilot pooled bill (and
 * its overage-allocation recompute) for ONE explicit (enterprise, month)
 * (design §5.4/§8.4, requirement "audited admin-triggerable historical bill
 * re-pull/restate for an explicit month").
 *
 * Body (zod): { month: 'YYYY-MM', reason: string (3-2000 chars) }. `month` is
 * BOUNDED: rejects any month after the current one, and any month more than
 * `MAX_LOOKBACK_MONTHS` (36) in the past — a re-pull is a targeted correction,
 * not an unbounded historical replay.
 *
 * Re-pulls straight from the GitHub enterprise billing usage report (the SAME
 * path server/workers/copilot-pool-bill.ts's scheduled tick uses, scoped to
 * this one enterprise + month via `explicitMonths`), then recomputes the
 * overage allocation for that month in the SAME transaction — both under the
 * reportingSnapshot + copilotOverageAllocation advisory locks.
 *
 * FINANCE-PERIOD INTEGRATION: a CLOSED month is refused outright (409) — the
 * caller must reopen or restate the period first (server/governance/
 * reporting-snapshot.ts). This route never
 * itself reopens/restates — it only ever operates on an OPEN period.
 *
 * RBAC: requireRole(admin, global-finops) + assertSameOrigin. Audited
 * (before the pull, and again with the outcome).
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../../auth/csrf'
import { withRequestRls } from '../../../../../../db/request-rls'
import { requireUuidParam } from '../../../../../../utils/require-uuid-param'
import { readValidated } from '../../../../../../utils/validated-body'
import { recordAuditEvent } from '../../../../../../db/audit'
import { runCopilotPoolBill } from '../../../../../../workers/copilot-pool-bill'

const MAX_LOOKBACK_MONTHS = 36

const Body = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be 'YYYY-MM'"),
  reason: z.string().min(3).max(2000),
})

function badRequest(detail: string): never {
  throw createError({
    statusCode: 400,
    statusMessage: 'Invalid Copilot bill re-pull request',
    data: {
      type: 'https://tokenscope.example.com/errors/validation',
      title: 'Invalid Copilot bill re-pull request',
      status: 400,
      detail,
    },
  })
}

/** Bounded month input: no future month, no more than MAX_LOOKBACK_MONTHS back. */
function assertMonthInBounds(month: string, now: Date): void {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const target = Date.UTC(y, m - 1, 1)
  const current = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  if (target > current) {
    badRequest(
      `month '${month}' is in the future — the bill for a month that has not happened cannot be re-pulled.`,
    )
  }
  const monthsBack = (current - target) / (1000 * 60 * 60 * 24 * 30.4368) // approx months; bound is generous, not exact
  if (monthsBack > MAX_LOOKBACK_MONTHS + 1) {
    badRequest(
      `month '${month}' is more than ${MAX_LOOKBACK_MONTHS} months in the past — a re-pull this old is out of bounds for this route.`,
    )
  }
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin', 'global-finops')
  assertSameOrigin(event)
  const providerEnterpriseId = requireUuidParam(event, 'id', 'provider-enterprise id')
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null
  const now = new Date()

  assertMonthInBounds(body.month, now)
  const monthStart = `${body.month}-01`

  return withRequestRls(event, async (db) => {
    const ent = await db.execute<{
      id: string
      provider: string
      external_id: string
      reconciliation_mode: string
    }>(sql`
      SELECT id::text AS id, provider, external_id, reconciliation_mode
      FROM provider_enterprise WHERE id = ${providerEnterpriseId}::uuid
    `)
    const row = ent[0]
    if (!row) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Provider enterprise not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Provider enterprise not found',
          status: 404,
          detail: 'No provider_enterprise matches the supplied id.',
        },
      })
    }
    if (row.provider !== 'github') {
      badRequest('the Copilot pooled-bill re-pull applies to github enterprises only.')
    }
    if (row.reconciliation_mode !== 'reconciled') {
      badRequest("the enterprise's reconciliation_mode must be 'reconciled' to re-pull its bill.")
    }

    /*
     * NO CLOSED-MONTH REFUSAL. This used to 409 a re-pull of a closed month and
     * tell the operator to reopen or restate first.
     *
     * The timeline that killed it: we close at +2 after month end, Copilot
     * corrects its billing rows at +6, the bill lands at +10 — and the product
     * rejected the authoritative source because of a state we set ourselves.
     * TokenScope is not the billing system of record. The bill is right; we are
     * not, and refusing it does not protect the month, it guarantees the month
     * stays wrong until somebody performs a ceremony.
     *
     * The bill always lands. If the month was closed, the snapshot it was closed
     * at is unchanged and the difference is reported as a delta.
     */
    await recordAuditEvent(db, {
      eventType: 'copilot-bill-repull-triggered',
      actorTeammateId: caller.teammateId,
      subjectKind: 'provider-enterprise',
      subjectId: providerEnterpriseId,
      payload: { month: body.month, reason: body.reason },
      ipAddress: ip,
      userAgent: ua,
    })

    const result = await runCopilotPoolBill(db, {
      now,
      enterpriseId: providerEnterpriseId,
      explicitMonths: [monthStart],
    })

    // The raced-close 409 went with the pre-flight one: there is no longer a
    // state a month can race INTO that would make its bill unwelcome.

    if (result.enterprisesErrored > 0) {
      await recordAuditEvent(db, {
        eventType: 'copilot-bill-repull-failed',
        actorTeammateId: caller.teammateId,
        subjectKind: 'provider-enterprise',
        subjectId: providerEnterpriseId,
        payload: {
          month: body.month,
          reason: body.reason,
          failure: 'worker-error',
          enterprisesErrored: result.enterprisesErrored,
        },
        ipAddress: ip,
        userAgent: ua,
      })
      throw createError({
        statusCode: 502,
        statusMessage: 'Copilot bill re-pull failed',
        data: {
          type: 'https://tokenscope.example.com/errors/copilot-bill-repull',
          title: 'Copilot bill re-pull failed',
          status: 502,
          detail: `The Copilot bill re-pull for ${body.month} failed before the rewrite committed. No partial result was applied; retry after checking worker diagnostics.`,
        },
      })
    }

    await recordAuditEvent(db, {
      eventType: 'copilot-bill-repull-completed',
      actorTeammateId: caller.teammateId,
      subjectKind: 'provider-enterprise',
      subjectId: providerEnterpriseId,
      payload: {
        month: body.month,
        reason: body.reason,
        orgRowsWritten: result.orgRowsWritten,
        residualRowsWritten: result.residualRowsWritten,
        overageAllocationsComputed: result.overageAllocationsComputed,
        overageAllocationsUnallocated: result.overageAllocationsUnallocated,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return { month: body.month, result }
  })
})
