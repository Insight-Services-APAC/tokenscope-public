/*
 * GET /api/v1/me/quarantined-spend — the caller's OPEN quarantined sessions
 * ("unverified spend"): spend claiming an instance whose authenticated /bearer
 * heartbeat ([ts_start, last_bearer_at + grace]) does NOT span the session's event
 * window. Maintained by the heartbeat-coverage worker (server/workers/heartbeat-
 * coverage.ts) into session_quarantine.
 *
 * This is the EARLY/UX detection leg of revoke+detect+reconcile — it surfaces the
 * cross-instance-spoof signal (records claiming a victim instance_id the spoofer
 * can't mint a bearer for → no covering heartbeat) BEFORE reconciliation (which
 * lags ~1h+) confirms or wipes the spend. It is INFORMATIONAL: nothing here revokes
 * or deletes; reconciliation against Anthropic actuals is the only thing that wipes
 * non-reconciling spend. It does NOT catch full credential theft (the thief owns the
 * instance, so it heartbeats as the victim).
 *
 * Teammate-scoped: requireAuth + withRequestRls (the session_quarantine RLS policy
 * is teammate-scoped) AND getMyQuarantinedSpend filters teammate_id explicitly —
 * the caller only ever sees their own rows, exactly like the other /me reads.
 */
import { defineEventHandler } from 'h3'
import { requireAuth } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'
import { getMyQuarantinedSpend } from '../../../utils/me-queries'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const sessions = await withRequestRls(event, async (tx) =>
    getMyQuarantinedSpend(tx, session.teammateId),
  )
  return {
    sessions,
    total: sessions.length,
    note: 'Unverified spend — claims an instance with no covering emit heartbeat. Informational, pending reconciliation; nothing is revoked or deleted.',
  }
})
