/*
 * GET /api/v1/me/projects/{code} — the project dashboard payload (brief §5)
 * in ONE fetch, for PM and project team alike (PO decision: full project
 * transparency for current members; no role asymmetry).
 *
 * Gate: current project_assignment membership — a non-member is
 * indistinguishable from a missing project (404, the [sid] posture).
 *
 * Reads: aggregate for series/mix/velocity; the per-project DETAIL ledger
 * reads (member contribution, activity mix, untagged pressure) are the
 * single sanctioned raw-ledger exception (brief §6.5) — one project,
 * month-bounded, index-served.
 */
import { createError, defineEventHandler, getRouterParam, getValidatedQuery } from 'h3'
import { sql as sqlRaw } from 'drizzle-orm'
import { z } from 'zod'
import { WindowQuery } from '../../../../../../shared/schemas/usage'
import { requireAuth } from '../../../../../auth/rbac'
import { withRequestRls } from '../../../../../db/request-rls'
import {
  fetchDailySeries,
  fetchModelSeries,
  fetchMtdSpend,
  fetchProjectAllocation,
  fetchProjectVelocity,
  fetchWindowTotals,
  requireProjectMembership,
} from '../../../../../usage/consumption'
import { exhaustionDate, runRate } from '../../../../../usage/projections'
import {
  fetchMemberContribution,
  fetchProjectActivityMix,
  fetchUntaggedPressure,
} from '../../../../../usage/project-detail'
import {
  GOV_VELOCITY_SPIKE_THRESHOLD,
  resolveGovernanceSetting,
} from '../../../../../utils/governance-settings'


export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const codeParsed = z
    .string()
    .min(1)
    .max(120)
    .safeParse(getRouterParam(event, 'code'))
  if (!codeParsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid project code' })
  }
  const { window } = await getValidatedQuery(event, (d) => WindowQuery.parse(d))

  return await withRequestRls(event, async (tx) => {
    const project = await requireProjectMembership(tx, session.teammateId, codeParsed.data)
    if (!project) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Project not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Project not found',
          status: 404,
          detail: 'No project with this code among your current memberships.',
        },
      })
    }

    // Spike-threshold dial (mig 0049): resolved for the PROJECT's region
    // (R1 F2 — subject's region, never the viewer's; a cross-region CC
    // owner must see the project judged by its own region's bar).
    const velocityThreshold = await resolveGovernanceSetting(
      tx,
      GOV_VELOCITY_SPIKE_THRESHOLD,
      project.region_id,
    )

    const now = new Date()
    const [mtd, allocation, velocity, series, seriesByModel, totals, members, activityMix, untagged] =
      await Promise.all([
        fetchMtdSpend(tx, 'project', project.id),
        fetchProjectAllocation(tx, project.id),
        fetchProjectVelocity(tx, project.id, velocityThreshold),
        fetchDailySeries(tx, 'project', project.id, window),
        fetchModelSeries(tx, 'project', project.id, window),
        fetchWindowTotals(tx, 'project', project.id, window),
        fetchMemberContribution(tx, project.id),
        fetchProjectActivityMix(tx, project.id),
        fetchUntaggedPressure(tx, project.id),
      ])

    // Team concentration (AEUF's metric, project-health framing): the share
    // of MTD spend carried by the top 2 contributors.
    const memberTotal = members.reduce((a, m) => a + Number(m.cost_usd), 0)
    const top2 = members.slice(0, 2).reduce((a, m) => a + Number(m.cost_usd), 0)

    // R2 F1: a cou-owner viewer is NOT a member — they get the project-health
    // AGGREGATES (totals, concentration, counts; same posture as their
    // /cost-centres cards) but never the NAMED per-developer contribution
    // rows (display_name/email/cost/intensity). PO principle #5: per-member
    // rows show contribution to the team itself, never to an observer.
    const namedMembersVisible = project.access === 'member'

    // J5: the PM's budget entry point. viewer_role comes from the caller's
    // own assignment; budget_allocation_id is the currently-effective
    // baseline the /allocations/{id} editor focuses (null when no budget —
    // the UI offers Set budget via /projects/new flow instead).
    const viewerRows = await tx.execute<{ role: string }>(sqlRaw`
      SELECT role FROM project_assignment
      WHERE project_id = ${project.id}::uuid
        AND teammate_id = ${session.teammateId}::uuid
        AND effective @> now()
      LIMIT 1
    `)
    const viewerRole = [...viewerRows][0]?.role ?? 'member'
    const baselineRows = await tx.execute<{ id: string }>(sqlRaw`
      SELECT id::text AS id FROM allocation
      WHERE scope_type = 'project' AND scope_id = ${project.id}::uuid
        AND teammate_id IS NULL AND allocation_kind = 'baseline'
        AND effective @> now()
      LIMIT 1
    `)

    return {
      viewer: {
        role: viewerRole,
        // 'member' | 'cou-owner' (R1 F1): how the caller was admitted.
        access: project.access,
        budget_allocation_id: [...baselineRows][0]?.id ?? null,
      },
      project: {
        id: project.id,
        code: project.code,
        display_name: project.display_name,
        type: project.type,
        wbs_code: project.wbs_code,
        end_date: project.end_date,
        ended: project.ended,
      },
      budget: {
        mtd_cost_usd: mtd.toFixed(2),
        allocation_usd: allocation.toFixed(2),
        utilisation: allocation > 0 ? Number((mtd / allocation).toFixed(4)) : null,
        projected_exhaustion_date: exhaustionDate(mtd, allocation, now),
        run_rate: runRate(mtd, now),
      },
      velocity,
      window_days: window,
      series,
      series_by_model: seriesByModel,
      mix: {
        by_model: totals.by_model,
        by_token_type: totals.by_token_type,
        by_activity: activityMix,
      },
      cache: totals.cache,
      fidelity: {
        window_cost_usd: totals.cost_usd.toFixed(2),
        advisory_cost_usd: totals.advisory_cost_usd.toFixed(2),
      },
      team: {
        members: namedMembersVisible ? members : [],
        member_count: members.length,
        concentration_top2_share:
          memberTotal > 0 ? Number((top2 / memberTotal).toFixed(4)) : null,
      },
      untagged_pressure: untagged,
    }
  })
})
