/*
 * POST /api/v1/admin/diagnostics/governance-unresolved/recheck — an explicit,
 * on-demand resweep of the governance-key backlog (design §8.4: "Every
 * unresolved/unknown state has an explicit recheck action"). Runs ONE bounded
 * batch of the same resolution logic the governance-key-backfill worker uses,
 * inline, so an operator who just registered/linked the missing org sees the
 * effect immediately rather than waiting for the next cron tick.
 *
 * RBAC: global-finops (write-adjacent — triggers a bulk UPDATE, though a
 * read-only/idempotent one). CSRF-guarded. Audited (a bulk UPDATE on money
 * rows is consequential even when every change is a resolution, not a
 * verdict flip).
 */
import { defineEventHandler, getRequestIP, getHeader } from 'h3'
import { requireRole } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { runGovernanceKeyBackfill } from '../../../../../workers/governance-key-backfill'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'global-finops')
  assertSameOrigin(event)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  /*
   * WHY THE WORKER STAYS ON THE REQUEST LANE HERE (docs/design/rls-enforcement.md
   * §2, "the six handlers that run worker code under a user's context").
   *
   * The concern that doc raises is a region admin's context silently narrowing
   * an estate-wide computation. It cannot happen on this route, for two
   * independent reasons — neither of them "the pool it happened to land on":
   *
   *   1. requireRole pins this route to `global-finops` (and platform-admin,
   *      which requireRole always admits and withRequestRls maps to
   *      `global-finops` at the RLS layer). There is no region-scoped caller to
   *      inherit a region FROM. The scope is stated by the RBAC gate, which is
   *      the first line of this handler, not implied by plumbing.
   *   2. runGovernanceKeyBackfill touches actual_spend, reconciliation_record
   *      and pending_placement, joined against provider_org /
   *      provider_enterprise. NONE of those five tables has RLS enabled at all
   *      (`grep 'ENABLE ROW LEVEL SECURITY' drizzle/migrations/`), so no policy
   *      applies to this work under any FORCE phase in §6.
   *
   * And the sweep MUST stay in the audit's transaction: it is one bounded bulk
   * UPDATE on money rows, and splitting it onto a second connection would let
   * the UPDATE commit while its audit row rolls back. Atomicity is worth more
   * here than a lane change that would change no query's answer.
   */
  return withRequestRls(event, async (tx) => {
    const result = await runGovernanceKeyBackfill(tx)
    await recordAuditEvent(tx, {
      eventType: 'governance-unresolved-recheck',
      actorTeammateId: caller.teammateId,
      subjectKind: 'governance_key_backfill',
      subjectId: null,
      payload: result,
      ipAddress: ip,
      userAgent: ua,
    })
    return result
  })
})
