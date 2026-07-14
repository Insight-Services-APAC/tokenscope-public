/*
 * GET /api/v1/rollups/finance/{couId}/breakdown — per-project
 * breakdown for one cost-owning unit (design-notes §Screen 6
 * expand-row).
 *
 * BILL-ANCHORED (mig 0059): per-project charge comes from the project overlay
 * (v_finance_project_overlay), which splits the CoU's BILL across the projects
 * its teammates tagged (scaled never to exceed the bill) plus an untagged
 * remainder row — together they sum to the CoU's bill exactly. The untagged row
 * is read DIRECTLY from the overlay (project_id IS NULL), not synthesised as
 * max(0, total − Σ). Per-project tokens are the OTel volume signal (the bill has
 * no per-project token split); dev_count = COUNT(DISTINCT teammate_id).
 */
import { defineEventHandler, createError, getValidatedQuery } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../../auth/rbac'
import { withRequestRls } from '../../../../../db/request-rls'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'
import { monthStartIso } from '../../../../../utils/period'

const Query = z.object({
  period: z.enum(['prior', 'mtd', 'q1']).default('mtd'),
})

function rangeForPeriod(period: 'prior' | 'mtd' | 'q1'): { start: string; end: string } {
  const now = new Date()
  if (period === 'mtd') {
    return {
      start: monthStartIso(now),
      end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
    }
  }
  if (period === 'prior') {
    return {
      start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString(),
      end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    }
  }
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString(),
    end: new Date(Date.UTC(now.getUTCFullYear(), 3, 1)).toISOString(),
  }
}

interface ProjectRow extends Record<string, unknown> {
  project_id: string | null
  project_code: string | null
  project_display_name: string | null
  wbs_code: string | null
  dev_count: string
  total_cost_usd: string
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')
  const couId = requireUuidParam(event, 'couId')
  const query = await getValidatedQuery(event, (data) => Query.parse(data))
  const range = rangeForPeriod(query.period)

  return await withRequestRls(event, async (tx) => {
    // Resolve the CoU's region and region-bound the caller before
    // reading any spend. Without this an admin (region-bounded role)
    // could pull the per-project breakdown of any CoU in any region by
    // id — RLS is inert at runtime so it provides no backstop.
    const couRows = await tx.execute<{ region_id: string }>(sql`
      SELECT region_id::text AS region_id FROM org_unit WHERE id = ${couId}::uuid LIMIT 1
    `)
    const cou = [...couRows][0]
    if (!cou) {
      throw createError({ statusCode: 404, statusMessage: 'CoU not found' })
    }
    await requireRegionScope(event, cou.region_id)

    const startDate = range.start.slice(0, 10)
    const endDate = range.end.slice(0, 10)

    // Per-project charge = the bill split (overlay), homed to this CoU. dev_count is
    // the distinct teammates contributing to that project's charge.
    const rows = await tx.execute<ProjectRow>(sql`
      SELECT o.project_id::text AS project_id,
             p.code AS project_code,
             p.display_name AS project_display_name,
             p.wbs_code,
             COUNT(DISTINCT o.teammate_id)::text AS dev_count,
             COALESCE(SUM(o.charge_usd), 0)::text AS total_cost_usd
      FROM v_finance_project_overlay o
      JOIN project p ON p.id = o.project_id
      WHERE o.cost_owning_unit_id = ${couId}::uuid
        AND o.period_date >= ${startDate}::date
        AND o.period_date <  ${endDate}::date
      GROUP BY o.project_id, p.code, p.display_name, p.wbs_code
      ORDER BY SUM(o.charge_usd) DESC NULLS LAST
    `)
    const projectList = [...rows]

    // Per-project tokens: the OTel volume signal for the CoU (the bill carries no
    // per-project token split). Merged by project_id; missing -> 0.
    const tokenRows = await tx.execute<{ project_id: string; total_tokens: string }>(sql`
      SELECT project_id::text AS project_id, COALESCE(SUM(tokens), 0)::text AS total_tokens
      FROM v_finance_reportable_spend
      WHERE cost_owning_unit_id = ${couId}::uuid
        AND project_id IS NOT NULL
        AND occurred_at >= ${range.start}::timestamptz
        AND occurred_at <  ${range.end}::timestamptz
      GROUP BY project_id
    `)
    const tokensByProject = new Map([...tokenRows].map((r) => [r.project_id, r.total_tokens]))

    // Untagged remainder: read DIRECTLY from the overlay (project_id IS NULL), the
    // bill minus the tagged projects — never a max(0, total − Σ) synthesis.
    const untaggedRow = await tx.execute<{ untagged: string }>(sql`
      SELECT COALESCE(SUM(o.charge_usd), 0)::text AS untagged
      FROM v_finance_project_overlay o
      WHERE o.cost_owning_unit_id = ${couId}::uuid
        AND o.project_id IS NULL
        AND o.period_date >= ${startDate}::date
        AND o.period_date <  ${endDate}::date
    `)
    const untaggedUsd = Number([...untaggedRow][0]?.untagged ?? 0)
    const projectsSum = projectList.reduce((acc, r) => acc + Number(r.total_cost_usd), 0)
    // CoU total = the bill = tagged projects + untagged remainder (overlay sums back).
    const couTotal = projectsSum + untaggedUsd

    return {
      cou_id: couId,
      period: query.period,
      projects: projectList.map((r) => ({
        project_id: r.project_id,
        project_code: r.project_code,
        project_display_name: r.project_display_name,
        wbs_code: r.wbs_code,
        dev_count: Number(r.dev_count),
        total_tokens: Number(r.project_id ? (tokensByProject.get(r.project_id) ?? 0) : 0),
        total_cost_usd: Number(r.total_cost_usd).toFixed(2),
        pct_of_cou: couTotal > 0 ? Number(r.total_cost_usd) / couTotal : 0,
      })),
      untagged: {
        total_cost_usd: untaggedUsd.toFixed(2),
        pct_of_cou: couTotal > 0 ? untaggedUsd / couTotal : 0,
      },
      cou_total_usd: couTotal.toFixed(2),
    }
  })
})
