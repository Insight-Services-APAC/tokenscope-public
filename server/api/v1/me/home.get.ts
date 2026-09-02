/*
 * GET /api/v1/me/home — the developer's project bucket split for the
 * current month-to-date. Serves Home (`app/pages/index.vue`).
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
import { sql } from 'drizzle-orm'
import { consola } from 'consola'
import { defineEventHandler } from 'h3'
import { requireAuth } from '../../../utils/auth'
import { getDb } from '../../../db'
import { withRequestRls } from '../../../db/request-rls'
import { attributionStall } from '../../../usage/attribution-stall'
import { getMyUsage, getMyProviderTruthMtd } from '../../../utils/me-queries'
import { buildMeHeadline, buildMeLensDisclosure } from '../../../utils/me-lens'
import { requestClock } from '../../../utils/request-clock'

export default defineEventHandler(async (event) => {
  // Cookie-only: the WEB dashboard usage card. The headless read path moved to
  // the MCP `my_usage` tool (OAuth bearer → getMyUsage directly), so this
  // endpoint no longer accepts a read bearer. requireAuth caches the session
  // per-event, so withRequestRls's internal requireAuth reuses it for the RLS GUCs.
  const session = await requireAuth(event)
  // ADR 0012 — the LENS. Coerced, never rejected (see shared/usage/lens.ts).
  /*
   * Home is the §A surface, full stop. ADR 0012 D2 as amended: it carries no
   * lane control because its hero is entirely §A constructs — budgets, the soft
   * cap, pace — and has nothing to render under the other lane. The page never
   * sent `?lane`, so parsing one left an endpoint that would answer a question
   * no caller could ask and no surface could draw. The lane lives on /me/usage.
   */
  const lane = 'usage' as const

  return withRequestRls(event, async (tx) => {
    /*
     * ONE clock for the whole response.
     *
     * `getMyUsage` used to be called with no `now` (defaulting to its own
     * `new Date()`) while everything below read a second one taken afterwards.
     * Two clocks either side of UTC midnight put the two halves of this payload
     * in DIFFERENT MONTHS: `attributed_usage_usd` is derived from `usage`, and
     * `declared_personal_usage_usd` / `tool_gaps` are computed from `now`. On
     * the 1st that breaks the invariant the disclosure is built on — the
     * declared figure is a subset of the figure printed above it — in
     * production, while the integration test that pins it passes, because the
     * test supplies one clock to both.
     *
     * F1/F6: that one clock is the REQUEST's clock, not a second `new Date()`.
     * F6 found the failure this closes by running the day-1 parity capture:
     * `/api/v1/clock` honoured the pinned day while `/me/usage` took its own
     * `new Date()`, so a capture filed as day 1 rendered "day 5 of 31". Home
     * carries the same seam, and the same defect until it reads the same clock.
     */
    const now = new Date(requestClock(event).now)
    const usage = await getMyUsage(tx, session.teammateId, now)
    /*
     * ADDITIVE ONLY. `getMyUsage`'s own shape is the MCP `my_usage` tool's
     * contract as well as this page's, so the lens rides ALONGSIDE it rather
     * than reshaping it. `headline` carries the selected lens's figure and
     * everything derived from it; `disclosure` carries decision 5.
     */
    const providerReported = await getMyProviderTruthMtd(tx, session.teammateId, now)
    const [headline, disclosure] = await Promise.all([
      buildMeHeadline(tx, {
        teammateId: session.teammateId,
        lane,
        attributedUsageUsd: usage.total_cost_usd,
        baseAllowanceUsd: usage.base_allowance_usd,
        allocationUsd: usage.total_allocation_usd,
        quotaUsd: usage.total_quota_usd,
        now,
      }),
      buildMeLensDisclosure(tx, {
        teammateId: session.teammateId,
        /*
         * The TOTAL, not the budgeted slice the headline above uses — and the
         * difference is deliberate on this endpoint alone.
         *
         * The dashboard's hero splits the month into two named figures
         * (Budgeted · N budgets / Unallocated · soft cap), so `total_cost_usd`
         * carries its own label there. The disclosure card is a different
         * question: it sets attributed usage against `providerReportedUsd`,
         * which is the whole month across every surface the providers reported
         * on. Putting the budgeted slice on one side of that comparison
         * understates the gap by however much of the month was unallocated, and
         * prints it under a label ("attributed usage · this month") that claims
         * the whole month.
         *
         * /usage reaches the same figure from the other direction: its
         * headline IS the total (ADR 0012 decision 1a), so it passes one operand
         * to both. Either way the disclosure compares like with like.
         */
        attributedUsageUsd: (
          Number(usage.total_cost_usd) + Number(usage.unallocated.total_cost_usd)
        ).toFixed(2),
        providerReportedUsd: providerReported,
        now,
      }),
    ])
    /*
     * HAS THIS TEAMMATE EVER EMITTED OTel? (external review r2 + owner ruling.)
     *
     * The onboarding CTA on `/` asks whether the reader is instrumented — "a
     * brand-new dev who has never emitted" — and it must be answered on the OTel
     * lane SPECIFICALLY. `attribution_record` IS that lane by construction: the
     * Azure-Monitor reader is the only writer in the tree. Everything else on
     * this page (spend totals, the Activity list) counts API-REPORTED records
     * too, and F4 made Activity a deliberate union of both kinds — so a
     * Copilot-only teammate, who has never emitted anything, populates every
     * other signal and would be classified as an established emitter. That is
     * the rollout gap the product exists to measure, silently mis-read as
     * onboarded.
     *
     * ALL TIME AND UNFILTERED: "ever", not "this month", and no project/tool
     * clamp — a teammate who emitted in April and not since is not new.
     * RLS-scoped like everything else in this tx; the explicit teammate
     * predicate keeps it true independent of the policy.
     */
    const emitted = await tx.execute<{ ever: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM attribution_record WHERE teammate_id = ${session.teammateId}::uuid
      ) AS ever
    `)
    const hasEverEmitted = [...emitted][0]?.ever === true

    /*
     * The §A6.2 degradation-banner leg (additive). On the BASE handle, not this
     * RLS tx: the signal is GLOBAL — `instance_attestation` is region-scoped
     * under RLS, so a viewer-scoped MAX(last_bearer_at) would hand two regions
     * two different stall verdicts. See server/usage/attribution-stall.ts.
     */
    const attributionStallLeg = await attributionStall(getDb(), { now }).catch((err) => {
      // The leg is additive: an unreadable ledger must degrade to no-banner,
      // never 500 the page — which would hit exactly during the outage the
      // banner exists for (attribution-stall.ts assigns never-throws to us).
      consola.error('[me/home] attribution-stall leg failed', err instanceof Error ? err.name : '')
      return null
    })

    return {
      ...usage,
      /*
       * §A6.1: `getMyUsage` answers "minutes since your newest event" with 0
       * when there IS no event (the MCP `my_usage` wire keeps that shape —
       * changing it is a plugin-contract change, not this endpoint's). The WEB
       * payload ships the honest absence instead: null renders the neutral
       * "freshness unknown" dot, never a fabricated green "Updated 0 min ago".
       */
      freshness_minutes_ago: hasEverEmitted ? usage.freshness_minutes_ago : null,
      has_ever_emitted: hasEverEmitted,
      headline,
      disclosure,
      attribution_stall: attributionStallLeg,
    }
  })
})
