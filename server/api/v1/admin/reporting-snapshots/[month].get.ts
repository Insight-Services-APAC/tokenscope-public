/*
 * GET /api/v1/admin/reporting-snapshots/{month} — what a month read when it was
 * recorded, and whether it has moved since.
 *
 * NULL IS NOT A STATE. There is no open/closed axis any more; a month either has
 * a record of what it read at close or it does not, and neither condition
 * changes what the month is currently allowed to do.
 *
 * ── WHY THE DELTA IS THE RESPONSE, NOT THE ROW ───────────────────────────────
 * This used to return the stored row alone, and `reportingSnapshotDelta` had no
 * caller anywhere in the product — so a month that moved after being reported
 * moved silently, which is the ONLY thing a snapshot is for. The stored figures
 * are still here (`snapshot`), beside what the month reads now (`current`) and
 * the movement between them.
 *
 * ── WHY NOT A REGION ADMIN ───────────────────────────────────────────────────
 * `reporting_snapshot` is an ORG-WIDE singleton — one row per month for the
 * whole company, with no region column and no RLS policy to clamp. A
 * region-scoped admin reading it would receive whole-org chargeable totals,
 * which is information they can get nowhere else in the product. The card that
 * renders this was already gated on an org-wide role; the API now agrees with
 * it, and so does the close route.
 *
 * `deltaUsd` is null when the two are not comparable — a basis or snapshot-version
 * change means the difference is what changing the question costs, not money
 * moving — and `incomparableReason` says which.
 */
import { defineEventHandler } from 'h3'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { requireMonthParam } from '../../../../utils/require-month-param'
import { reportingSnapshotDelta } from '../../../../governance/reporting-snapshot'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'global-finops', 'platform-admin')
  const month = requireMonthParam(event, 'month')
  return withRequestRls(event, async (tx) => {
    // null = never recorded. The caller distinguishes that from "recorded and
    // unchanged", which comes back with `chargeableUnchanged: true`.
    return await reportingSnapshotDelta(tx, month)
  })
})
