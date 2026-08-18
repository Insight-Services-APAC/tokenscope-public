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
 * overage allocation for that month — the worker does both in ONE transaction
 * per (enterprise, month), under the reportingSnapshot +
 * copilotOverageAllocation advisory locks.
 *
 * LANES: the worker runs on the WORKER pool (estate-wide RLS identity), the
 * validation and the audit rows on the REQUEST pool (the caller's). See the
 * block comment at the worker call for why — docs/design/rls-enforcement.md §2
 * names the previous shape, which ran the worker inside the request
 * transaction, as the failure mode this design exists to remove.
 *
 * FINANCE-PERIOD INTEGRATION: a CLOSED month is NOT refused. This header used to
 * say it was 409'd; the refusal was removed (see the block comment on the
 * request-lane transaction below, and the matching one in copilot-pool-bill.ts)
 * because we close at +2, the provider corrects at +6 and the bill lands at +10,
 * so refusing it guaranteed the month stayed wrong. The bill always lands; if
 * the month was closed, its snapshot is unchanged and the difference is reported
 * as a delta. This route still never reopens or restates a period itself.
 *
 * RBAC: requireRole(global-finops) + assertSameOrigin. Audited
 * (before the pull, and again with the outcome).
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../../auth/csrf'
import { withRequestRls } from '../../../../../../db/request-rls'
import { getWorkerDb } from '../../../../../../db/worker-db'
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
  // `global-finops` ONLY — deliberately NOT 'admin'. `admin` is a REGION-scoped role
  // (rbac.ts), but `provider_enterprise` carries no region column, so there is nothing
  // to clamp a region admin against: any admin could pass any enterprise id and cause
  // that enterprise's copilot_pool_bill month to be deleted and rewritten, plus its
  // overage allocations recomputed and its inbox alerts raised, anywhere in the estate.
  //
  // That gap predates this branch, but this branch is what removed the accident that
  // half-covered it: while the worker ran on the caller's RLS context, FORCE would at
  // least have narrowed the damage (to a wrong, partial bill). Now that the worker
  // correctly runs estate-wide, the authorization has to carry the weight the lane used
  // to. Raised by an external review of this sprint.
  //
  // Consistent with the standing recommendation in owner-decisions.md §1 — "provider
  // configuration is estate config, so drop 'admin' from that whole tree". This is one
  // route of that tree, tightened where a money-of-record write made it urgent; the
  // ruling for the other 22 handlers is still the owner's.
  const caller = await requireRole(event, 'global-finops')
  assertSameOrigin(event)
  const providerEnterpriseId = requireUuidParam(event, 'id', 'provider-enterprise id')
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null
  const now = new Date()

  assertMonthInBounds(body.month, now)
  const monthStart = `${body.month}-01`

  // ── Request lane: validate the target, then attribute the trigger ─────────
  // Both belong to the CALLER, so both run under the caller's RLS context.
  await withRequestRls(event, async (db) => {
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
  })

  /*
   * ── WORKER LANE: the bill is estate-wide, and now says so ─────────────────
   *
   * This call used to sit INSIDE the `withRequestRls` transaction above, which
   * docs/design/rls-enforcement.md §2 names as "the failure mode, not the
   * precedent". Two things were wrong with it, and this line fixes both:
   *
   *   SCOPE. requireRole admits a region-scoped `admin`, so the worker inherited
   *   THAT admin's region as its RLS context. Under FORCE the bill computation's
   *   org_unit lookups (org → BU mapping) and its inbox_item alerts would be
   *   narrowed to one region — a PARTIAL BILL that reports success. The lane now
   *   decides the scope: `app.user_role=global-finops`, estate-wide, the same
   *   identity the scheduled tick of this exact worker runs under. The
   *   COMPUTATION's scope is therefore neither widened nor narrowed by who
   *   pressed the button — which is a statement about the computation, NOT about
   *   authorisation. The caller's authority is bounded by requireRole above, and
   *   an external review of this sprint correctly pointed out that those are two
   *   different questions and only one of them was being answered here.
   *
   *   TRANSACTION NESTING. runCopilotPoolBill opens its own transaction per
   *   (enterprise, month) and takes `advisoryXactLock('reportingSnapshot', …)`
   *   + `advisoryXactLock('copilotOverageAllocation', …)` inside it. Nested in a
   *   request transaction those demote to SAVEPOINTs, so the xact locks scoped
   *   to the whole request instead of the unit of work they were written to
   *   guard — and GitHub billing HTTP calls ran mid-transaction.
   *
   * Consequence to know: the worker's writes are no longer atomic with the audit
   * rows. That is the correct trade — the worker already commits per
   * (enterprise, month) internally, and the previous shape meant a 502 rolled
   * back the "triggered" AND "failed" audit rows, so a failed re-pull left no
   * trace at all. It now leaves both.
   */
  const workerDb = await getWorkerDb()
  const result = await runCopilotPoolBill(workerDb, {
    now,
    enterpriseId: providerEnterpriseId,
    explicitMonths: [monthStart],
  })

  // The raced-close 409 went with the pre-flight one: there is no longer a
  // state a month can race INTO that would make its bill unwelcome.

  if (result.enterprisesErrored > 0) {
    await withRequestRls(event, (db) =>
      recordAuditEvent(db, {
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
      }),
    )
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

  await withRequestRls(event, (db) =>
    recordAuditEvent(db, {
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
    }),
  )

  return { month: body.month, result }
})
