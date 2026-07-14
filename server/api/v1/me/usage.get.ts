/*
 * GET /api/v1/me/usage — the developer's project bucket split for the
 * current month-to-date.
 *
 * Epic 5 shipped the bucket scaffold from project_assignment with
 * zeros; Epic 6 wired the real numbers via attribution_record. Epic
 * 11 (MVP-Final) layers on:
 *   - `allocation_total_usd` per bucket — SUM(allocation.budget_usd)
 *     where `effective` contains monthStart, allocation_kind IN
 *     ('baseline', 'top-up'), scope_type='project', scope_id=project.id;
 *     burst rows excluded
 *   - `is_active_now` per bucket — true if this user produced any
 *     attribution_record event for this project within the last 30 min.
 *     Spec deviation accepted: design-notes §Screen 2 originally said
 *     "currently-running session"; we use activity-based instead because
 *     session-based misses still-running sessions that haven't emitted
 *     yet (the Zeal pulse dot would NEVER fire for the first 30 sec of
 *     a session — opposite of what the UI promises). Ratified in Epic
 *     11 commit body.
 *   - top-level `freshness_minutes_ago` — clock-time since the most
 *     recent attribution_record event for this user (any project)
 *   - top-level `total_allocation_usd` — sum of buckets' allocation
 */
import { defineEventHandler } from 'h3'
import { requireAuth } from '../../../utils/auth'
import { withRequestRls } from '../../../db/request-rls'
import { getMyUsage } from '../../../utils/me-queries'

export default defineEventHandler(async (event) => {
  // Cookie-only: the WEB dashboard usage card. The headless read path moved to
  // the MCP `my_usage` tool (OAuth bearer → getMyUsage directly), so this
  // endpoint no longer accepts a read bearer. requireAuth caches the session
  // per-event, so withRequestRls's internal requireAuth reuses it for the RLS GUCs.
  const session = await requireAuth(event)
  return withRequestRls(event, async (tx) => getMyUsage(tx, session.teammateId))
})
