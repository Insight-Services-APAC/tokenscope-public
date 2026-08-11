/*
 * GET /api/v1/me/projects/summary — project CARDS for the /projects index
 * (brief §5.6): one card per project the caller is currently a member of,
 * with MTD burn vs allocation, run-rate exhaustion, velocity flag, and end
 * state. Ended projects with a current assignment stay visible (post-mortem
 * view) — unlike the tag-picker (/me/projects), which excludes them.
 *
 * MTD burn is `completeProjectSpend` (server/usage/complete-spend.ts) — THE
 * project-spend definition, in ONE batched call for every card, so a card and
 * the project page it opens can never show different money. The velocity flag
 * still reads the cron-refreshed `attribution_aggregate` (the series perf
 * contract), which is why the payload carries `page_freshness`.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireAuth } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { activeProjectPredicate } from '../../../../db/project-predicates'
import type { ProjectCard } from '../../../../../shared/schemas/usage'
import { fetchProjectAllocation, fetchProjectVelocity } from '../../../../usage/consumption'
import {
  completeProjectDailySpend,
  completeProjectSpend,
  completeTeammateProjectSpend,
} from '../../../../usage/complete-spend'
import { getUnallocatedSummary } from '../../../../utils/me-queries'
import { baseAllowanceUsd } from '../../../../utils/base-allowance'
import { aggregateSetFreshness, worstFreshness } from '../../../../usage/freshness'
import { monthToDateWindow } from '../../../../utils/period'
import { requestClock } from '../../../../utils/request-clock'
import { exhaustionDate } from '../../../../usage/projections'
import {
  GOV_VELOCITY_SPIKE_THRESHOLD,
  loadGovernanceSettingResolver,
} from '../../../../utils/governance-settings'

interface MembershipRow extends Record<string, unknown> {
  id: string
  code: string
  display_name: string
  type: string
  wbs_code: string | null
  end_date: string | null
  ended: boolean
  member_count: string
  region_id: string
}

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)

  return await withRequestRls(event, async (tx) => {
    const memberships = await tx.execute<MembershipRow>(sql`
      SELECT p.id::text AS id, p.code, p.display_name, p.type, p.wbs_code,
             p.end_date::text AS end_date,
             p.region_id::text AS region_id,
             (NOT ${activeProjectPredicate('p')}) AS ended,
             (SELECT COUNT(DISTINCT pa2.teammate_id) FROM project_assignment pa2
               WHERE pa2.project_id = p.id AND pa2.effective @> now())::text AS member_count
      FROM project p
      JOIN project_assignment pa ON pa.project_id = p.id
      WHERE pa.teammate_id = ${session.teammateId}::uuid
        AND pa.effective @> now()
      ORDER BY p.code
    `)

    const memberProjects = [...memberships]
    if (memberProjects.length === 0) {
      return {
        projects: [],
        total: 0,
        untagged_usd: '0.00',
        page_freshness: {
          aggregate_minutes_ago: null,
          projects_never_rolled_up: 0,
          worst_minutes_ago: null,
        },
      }
    }

    // Spike-threshold dial (mig 0049): one snapshot per request, applied
    // per PROJECT region (R1 F2/F3 — the subject's region decides the
    // bar, never the viewer's; memberships can be cross-region).
    const thresholdFor = await loadGovernanceSettingResolver(tx, GOV_VELOCITY_SPIKE_THRESHOLD)

    /*
     * The REQUEST's clock (F1/D1), not a fresh wall-clock read: the MTD window
     * every card on this list decomposes must be the same month the browser's
     * own `/api/v1/clock` says it is. It is also what lets the parity capture
     * pin a real day 1 here (D29).
     */
    const now = new Date(requestClock(event).now)
    const monthWindow = monthToDateWindow(now)
    // ONE lane read for EVERY card (not one per card): the same call the project
    // page makes, batched by project id. The W3 additions (D25/D26) ride the
    // SAME window and provisional option: the caller's own per-project slice
    // (the "yours" line + band Σ) and the per-day series behind each card's
    // sparkline.
    const projectIds = memberProjects.map((m) => m.id)
    const [spendByProject, sparkByProject, mineByProject, unallocated] = await Promise.all([
      completeProjectSpend(tx, monthWindow, { projectIds, excludeProvisional: true }),
      completeProjectDailySpend(tx, monthWindow, { projectIds, excludeProvisional: true }),
      completeTeammateProjectSpend(tx, session.teammateId, monthWindow, {
        excludeProvisional: true,
      }),
      /*
       * The band's WORKLIST pull-through, from the AUTHORITATIVE predicates —
       * the same split the needs-tagging queue itself is built from
       * (me-queries.ts:77-127), not a lane subtraction (r3-M5). The helper this
       * replaces summed "no project, not arm 3", which folded already-decided
       * activity-tagged spend and explicitly DISMISSED spend into a figure
       * labelled "→ worklist" — money nobody owes work on, presented as work.
       */
      getUnallocatedSummary(
        tx,
        session.teammateId,
        monthWindow.startIso,
        baseAllowanceUsd(),
        monthWindow.endIso,
      ),
    ])
    const untaggedUsd = Number(unallocated.unallocated.untagged_cost_usd)

    /*
     * The aggregate's own lag, for the velocity flag it still feeds — reported
     * by its STALEST project, plus a count of those never rolled up at all.
     *
     * It used to be MAX(refresh_at) over the whole set, which is the exact
     * inverse of the "as fresh as its stalest source" line it feeds: one
     * freshly-rolled project made every other card on the page claim that
     * project's freshness, and a project with no rollup row contributed nothing
     * at all. Both failures point the same way — towards a reassuring number.
     */
    const aggFresh = await aggregateSetFreshness(
      tx,
      'project',
      memberProjects.map((m) => m.id),
    )

    const cards: ProjectCard[] = await Promise.all(
      memberProjects.map(async (m) => {
        const mtd = spendByProject.get(m.id)?.costUsd ?? 0
        const [allocation, velocity] = await Promise.all([
          fetchProjectAllocation(tx, m.id),
          fetchProjectVelocity(tx, m.id, thresholdFor(m.region_id)),
        ])
        return {
          id: m.id,
          code: m.code,
          display_name: m.display_name,
          type: m.type,
          wbs_code: m.wbs_code,
          end_date: m.end_date,
          ended: m.ended,
          member_count: Number(m.member_count),
          mtd_cost_usd: mtd.toFixed(2),
          allocation_usd: allocation.toFixed(2),
          utilisation: allocation > 0 ? Number((mtd / allocation).toFixed(4)) : null,
          projected_exhaustion_date: exhaustionDate(mtd, allocation, now),
          velocity,
          // W3 D25/D26: the caller's slice of the card figure (same lane,
          // window and provisional option as `mtd_cost_usd`) + the same-window
          // per-day series behind the sparkline.
          mine_mtd_usd: (mineByProject.get(m.id) ?? 0).toFixed(2),
          spark: (sparkByProject.get(m.id) ?? []).map((d) => ({
            day: d.day,
            cost_usd: d.costUsd.toFixed(2),
          })),
        }
      }),
    )

    return {
      projects: cards,
      total: cards.length,
      // W3 D25: the band's "$X untagged → worklist" pull-through — the
      // caller's own taggable-but-untagged spend this month (self figure).
      untagged_usd: untaggedUsd.toFixed(2),
      /*
       * The month figure on every card is LIVE off the lane; the velocity flag
       * is not. Disclosed rather than left for a viewer to discover — and
       * disclosed at its WORST, so one recently-rolled project cannot speak for
       * the page.
       */
      page_freshness: {
        // The STALEST project's rollup age (null = none has ever rolled up).
        aggregate_minutes_ago: aggFresh.stalestMinutes,
        // Projects with no rollup at all: age unknown, not fresh.
        projects_never_rolled_up: aggFresh.neverRefreshed,
        worst_minutes_ago: worstFreshness([aggFresh.stalestMinutes]),
      },
    }
  })
})
